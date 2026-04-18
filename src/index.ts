// src/index.ts — AI Code Review GitHub Action
// 图灵原则：最简单的机制。拿 diff → 调 AI → 发评论。完毕。

import * as core from '@actions/core';
import * as github from '@actions/github';
import { Octokit } from '@octokit/rest';
import picomatch from 'picomatch';
import { parseJSONResponse, isLineInPatch } from './parse.js';

interface ReviewComment {
  path: string;
  line: number;
  body: string;
  severity: 'error' | 'warning' | 'info';
}

interface AIResponse {
  reviews: ReviewComment[];
}

// ── Inputs ──────────────────────────────────────────────
function getInputs() {
  return {
    githubToken: core.getInput('github-token', { required: true }),
    aiApiKey: core.getInput('ai-api-key', { required: true }),
    aiModel: core.getInput('ai-model') || 'gpt-4o-mini',
    aiBaseUrl: (core.getInput('ai-base-url') || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    maxFiles: parseInt(core.getInput('max-files') || '20', 10),
    ignorePatterns: core.getInput('ignore-patterns') || '',
    language: core.getInput('language') || 'en',
  };
}

// ── 文件匹配（picomatch）─────────────────────────────────
function shouldIgnore(filename: string, patterns: string[]): boolean {
  return patterns.some((p) => {
    const trimmed = p.trim();
    if (!trimmed) return false;
    return picomatch(trimmed)(filename);
  });
}

// ── Get PR diff ─────────────────────────────────────────
async function getPRDiff(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<{ filename: string; patch: string; additions: number; deletions: number }[]> {
  const { data: files } = await octokit.pulls.listFiles({
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });
  return files
    .filter((f) => f.patch) // skip binary files
    .map((f) => ({
      filename: f.filename,
      patch: f.patch!,
      additions: f.additions,
      deletions: f.deletions,
    }));
}

// ── Build review prompt ─────────────────────────────────
function buildReviewPrompt(file: { filename: string; patch: string }, language = 'en'): string {
  let systemLine: string;
  if (language === 'zh') {
    systemLine = '你是一位资深代码审查专家。请仅返回有效的 JSON。';
  } else if (language === 'en') {
    systemLine = 'You are an expert code reviewer. Respond with valid JSON only.';
  } else {
    systemLine = `You are an expert code reviewer. Write review comments in ${language}. Respond with valid JSON only.`;
  }
  return `${systemLine} Review the following code diff and identify real issues.

File: ${file.filename}

Diff:
${file.patch}

Rules:
- Only report genuine bugs, security vulnerabilities, logic errors, or significant style issues
- Do NOT report trivial issues (missing semicolons, minor formatting)
- Be specific: reference exact lines and explain WHY something is wrong
- If the code looks fine, return an empty reviews array

Respond with ONLY this JSON structure, no other text:
{
  "reviews": [
    {
      "path": "${file.filename}",
      "line": <line number in the diff>,
      "body": "<description of the issue and suggested fix>",
      "severity": "error" | "warning" | "info"
    }
  ]
}`;
}

// ── API 重试（指数退避，最多 3 次）─────────────────────
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries = 3
): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeout);
      // 4xx 不重试（除了 429）
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        return response;
      }
      if (response.ok || response.status === 429) {
        if (response.ok) return response;
        // 429 rate limit — 重试
      }
    } catch (err: any) {
      clearTimeout(timeout);
      if (attempt === maxRetries) throw err;
    }
    if (attempt < maxRetries) {
      const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
      core.info(`    Retry ${attempt + 1}/${maxRetries} after ${Math.round(delay)}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error('Max retries exceeded');
}

// ── Call AI API ─────────────────────────────────────────
async function callAI(
  baseUrl: string,
  apiKey: string,
  model: string,
  prompt: string,
  language = 'en'
): Promise<ReviewComment[]> {
  const endpoint = `${baseUrl}/chat/completions`;

  const body = {
    model,
    temperature: 0,
    max_tokens: 4096,
    messages: [
      { role: 'system', content: language === 'zh' ? '你是一位资深代码审查专家。请仅返回有效的 JSON。' : language === 'en' ? 'You are an expert code reviewer. Respond with valid JSON only.' : `You are an expert code reviewer. Write review comments in ${language}. Respond with valid JSON only.` },
      { role: 'user', content: prompt },
    ],
  };

  const response = await fetchWithRetry(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`AI API returned ${response.status}: ${errorText.substring(0, 200)}`);
  }

  const data = (await response.json()) as any;
  const content: string = data.choices?.[0]?.message?.content || '';

  if (!content) return [];

  const parsed = parseJSONResponse(content);
  if (parsed) {
    if (Array.isArray(parsed)) return parsed;
    if (parsed.reviews && Array.isArray(parsed.reviews)) return parsed.reviews;
    if (parsed.issues && Array.isArray(parsed.issues)) return parsed.issues;
  }

  return [];
}


// ── 并行化文件 review（限制并发数）─────────────────────
async function reviewFilesConcurrently(
  files: { filename: string; patch: string }[],
  aiBaseUrl: string,
  aiApiKey: string,
  aiModel: string,
  language = 'en',
  concurrency = 5
): Promise<ReviewComment[]> {
  const allReviews: ReviewComment[] = [];

  for (let i = 0; i < files.length; i += concurrency) {
    const batch = files.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      batch.map(async (file) => {
        core.info(`  Reviewing: ${file.filename}`);
        const prompt = buildReviewPrompt(file, language);
        const reviews = await callAI(aiBaseUrl, aiApiKey, aiModel, prompt, language);
        core.info(`    Found ${reviews.length} issue(s)`);
        return reviews;
      })
    );

    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status === 'fulfilled') {
        allReviews.push(...r.value);
      } else {
        core.warning(`Failed to review ${batch[j].filename}: ${r.reason?.message || r.reason}`);
      }
    }
  }

  return allReviews;
}

// ── Post review comments ────────────────────────────────
async function postReviewComments(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  reviews: ReviewComment[]
): Promise<void> {
  if (reviews.length === 0) return;

  const severityOrder = { error: 0, warning: 1, info: 2 };
  reviews.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  const comments = reviews.map((r) => ({
    path: r.path,
    line: r.line,
    body: `**[${r.severity.toUpperCase()}]** ${r.body}`,
  }));

  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number: prNumber,
    body: `🤖 AI Code Review — found ${reviews.length} issue(s)\n\n` +
      `| Severity | Count |\n|----------|-------|\n` +
      `| 🔴 Error | ${reviews.filter((r) => r.severity === 'error').length} |\n` +
      `| 🟡 Warning | ${reviews.filter((r) => r.severity === 'warning').length} |\n` +
      `| 🔵 Info | ${reviews.filter((r) => r.severity === 'info').length} |`,
    event: 'COMMENT' as const,
    comments,
  });
}

// ── Main ────────────────────────────────────────────────
async function main(): Promise<void> {
  try {
    const inputs = getInputs();
    const { owner, repo } = github.context.repo;
    const prNumber = github.context.payload.pull_request?.number;

    if (!prNumber) {
      core.setFailed('This action can only be run on pull requests.');
      return;
    }

    core.info(`Reviewing PR #${prNumber} in ${owner}/${repo}`);

    const octokit = new Octokit({ auth: inputs.githubToken });

    // Get PR diff
    let files = await getPRDiff(octokit, owner, repo, prNumber);
    core.info(`Found ${files.length} changed file(s)`);

    // 过滤 ignore-patterns
    const patterns = inputs.ignorePatterns.split(',').filter((p) => p.trim());
    if (patterns.length > 0) {
      const before = files.length;
      files = files.filter((f) => !shouldIgnore(f.filename, patterns));
      core.info(`Ignored ${before - files.length} file(s) by pattern`);
    }

    if (files.length === 0) {
      core.info('No files to review');
      return;
    }

    // Limit files
    const filesToReview = files.slice(0, inputs.maxFiles);
    core.info(`Reviewing ${filesToReview.length} file(s)`);

    // 并行 review
    const allReviews = await reviewFilesConcurrently(
      filesToReview, inputs.aiBaseUrl, inputs.aiApiKey, inputs.aiModel, inputs.language
    );

    // 验证 line 号
    const patchMap = new Map(filesToReview.map((f) => [f.filename, f.patch]));
    const validReviews: ReviewComment[] = [];
    for (const r of allReviews) {
      const patch = patchMap.get(r.path);
      if (patch && !isLineInPatch(r.line, patch)) {
        core.warning(`Line ${r.line} in ${r.path} is not in the diff range, skipping`);
        continue;
      }
      validReviews.push(r);
    }

    // Post comments
    if (validReviews.length > 0) {
      await postReviewComments(octokit, owner, repo, prNumber, validReviews);
      core.info(`Posted ${validReviews.length} review comment(s)`);
    } else {
      core.info('No issues found — clean review!');
    }

    // Set outputs
    core.setOutput('total-issues', validReviews.length);
    core.setOutput('errors', validReviews.filter((r) => r.severity === 'error').length);
    core.setOutput('warnings', validReviews.filter((r) => r.severity === 'warning').length);
    core.setOutput('info', validReviews.filter((r) => r.severity === 'info').length);

    // GitHub Step Summary
    const summary = core.summary;
    summary.addHeading('🤖 AI Code Review Summary');
    summary.addRaw(
      `| Severity | Count |\n|----------|-------|\n` +
      `| 🔴 Error | ${validReviews.filter((r) => r.severity === 'error').length} |\n` +
      `| 🟡 Warning | ${validReviews.filter((r) => r.severity === 'warning').length} |\n` +
      `| 🔵 Info | ${validReviews.filter((r) => r.severity === 'info').length} |\n`
    );
    if (validReviews.length > 0) {
      summary.addHeading('Issues', 3);
      for (const r of validReviews.slice(0, 20)) {
        summary.addRaw(`- **${r.severity}** \`${r.path}:${r.line}\` — ${r.body}\n`);
      }
      if (validReviews.length > 20) {
        summary.addRaw(`\n... and ${validReviews.length - 20} more\n`);
      }
    }
    await summary.write();
  } catch (error: any) {
    core.setFailed(`Action failed: ${error.message}`);
  }
}

main();
