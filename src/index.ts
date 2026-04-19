// src/index.ts — AI Code Review GitHub Action
// 图灵原则：最简单的机制。拿 diff → 调 AI → 发评论。完毕。

import * as core from '@actions/core';
import * as github from '@actions/github';
import { Octokit } from '@octokit/rest';
import picomatch from 'picomatch';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, extname, relative, dirname } from 'path';
import { parseJSONResponse, isLineInPatch } from './parse.js';

interface ReviewComment {
  path: string;
  line: number;
  body: string;
  severity: 'error' | 'warning' | 'info';
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
    mode: (core.getInput('mode') || 'diff') as 'diff' | 'full',
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
  const langInstruction = language === 'en'
    ? ''
    : language === 'zh'
      ? '\n- 用中文写审查意见（body 字段）'
      : `\n- Write review comments (body field) in ${language}`;

  const bugChecklist = language === 'zh' ? `
🔍 **检查清单（逐项检查）**：
1. **安全问题**
   - eval()、Function() 构造函数、innerHTML/XSS 风险
   - 硬编码密钥/密码/API key
   - SQL 注入、命令注入风险

2. **JavaScript/TypeScript 错误**
   - == vs ===（必须用 ===）
   - var vs let/const（优先用 const）
   - 未声明变量、变量提升问题
   - 数组越界、undefined/null 访问
   - 异步错误（缺少 await、Promise 未处理）
   - this 绑定问题

3. **逻辑错误**
   - 死代码、不可达代码
   - 边界条件错误（空数组、null/undefined）
   - 循环错误（无限循环、错误终止条件）
   - 类型错误（类型不匹配）

4. **性能问题**
   - 循环内的昂贵操作
   - 内存泄漏（未清理的事件监听器、定时器）
   - 重复计算
` : `
🔍 **Checklist (verify each item)**:
1. **Security Issues**
   - eval(), Function() constructor, innerHTML/XSS risks
   - Hardcoded secrets/passwords/API keys
   - SQL injection, command injection risks

2. **JavaScript/TypeScript Errors**
   - == vs === (must use ===)
   - var vs let/const (prefer const)
   - Undeclared variables, hoisting issues
   - Array out of bounds, undefined/null access
   - Async errors (missing await, unhandled Promise)
   - this binding issues

3. **Logic Errors**
   - Dead code, unreachable code
   - Boundary conditions (empty arrays, null/undefined)
   - Loop errors (infinite loops, wrong termination)
   - Type mismatches

4. **Performance Issues**
   - Expensive operations in loops
   - Memory leaks (uncleaned event listeners, timers)
   - Redundant calculations
`;

  return `You are a senior code reviewer. Review this diff and find REAL bugs only.

File: ${file.filename}

Diff:
${file.patch}
${bugChecklist}
**Severity Guide**:
- 🔴 **error**: Security vulnerabilities, crashes, data corruption, == instead of ===, var instead of let/const
- 🟡 **warning**: Potential bugs, edge cases, performance issues
- 🔵 **info**: Minor issues, best practices

**Quality Control**:
- Report ONLY genuine issues from the checklist above
- Do NOT report: missing semicolons, spacing, formatting, style preferences
- Be specific: quote the exact code and explain WHY it's wrong
- Check EACH line carefully - don't skip obvious bugs${langInstruction}

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
    const timeout = setTimeout(() => controller.abort(), 120_000);
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

// ── Full scan: 递归读本地文件 ───────────────────────────
const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift',
  '.c', '.cpp', '.h', '.hpp', '.cs', '.scala',
  '.php', '.pl', '.sh', '.bash', '.zsh',
  '.vue', '.svelte', '.html', '.css', '.scss',
]);

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '__pycache__',
  '.next', '.nuxt', 'vendor', '.venv', 'venv', 'target',
]);

function walkDir(dir: string, root: string, results: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
        walkDir(join(dir, entry.name), root, results);
      }
    } else if (entry.isFile()) {
      const ext = extname(entry.name);
      if (CODE_EXTENSIONS.has(ext)) {
        results.push(relative(root, join(dir, entry.name)));
      }
    }
  }
}

function readRepoFiles(root: string, maxFiles: number, ignorePatterns: string[]): { filename: string; content: string }[] {
  const allFiles: string[] = [];
  walkDir(root, root, allFiles);

  // 过滤 ignore patterns
  const filtered = allFiles.filter(f => !shouldIgnore(f, ignorePatterns));
  const limited = filtered.slice(0, maxFiles);

  const results: { filename: string; content: string }[] = [];
  for (const f of limited) {
    try {
      const content = readFileSync(join(root, f), 'utf-8');
      // 跳过超大文件 (>50KB)
      if (content.length > 50_000) continue;
      results.push({ filename: f, content });
    } catch {
      // 跳过读不了的文件
    }
  }
  return results;
}

// ── Full scan prompt（青山软件审查模式内化）───────────────
function buildFullScanPrompt(
  file: { filename: string; content: string },
  language = 'en',
  validators = ''
): string {
  const langInstruction = language === 'zh'
    ? '\n- 用中文写审查意见（body 字段）'
    : language === 'en'
      ? ''
      : `\n- Write review comments (body field) in ${language}`;

  const validatorsContext = validators
    ? `\n**本目录可用的校验/清理函数**：${validators}\n（如果代码构造了 URL/路径但没有调用上述函数，很可能存在注入漏洞）\n`
    : '';

  const prompt = language === 'zh'
    ? `你是代码安全审查专家。逐项检查以下代码中的 **3 类高危问题**。只报告确定存在的问题。

## 检查项（按优先级）

### 1. URL/路径注入（最严重 — 报告为 error）
- 找出所有用 \`\${...}\` 或字符串拼接构造 URL、路径、命令的地方
- 对每个这样的地方：拼接的变量是否经过校验（validate/sanitize/escape）？
- 如果未校验 → 报告为 error
- 特别注意：参数直接拼入 fetch/axios URL 的情况

### 2. 异步错误丢失（报告为 warning）
- 找出所有 \`void someAsync()\` 或未 \`await\` 的 Promise 调用
- 这个 Promise reject 时错误去哪了？外层 try-catch 能捕获吗？
- 如果错误被静默吞掉 → 报告为 warning

### 3. 异常分支状态错误（报告为 warning）
- try-catch 的 catch 分支里，是否重置了不该重置的计数器或标志位？
- 正常流程中设置的变量，在异常路径是否被错误修改？
- 如果发现状态不一致 → 报告为 warning
${validatorsContext}
**规则**：
- 只报告这 3 类问题，不报告代码风格、格式、命名
- 必须引用具体代码行并说明 WHY
- 如果没发现问题，回复空列表${langInstruction}

文件：${file.filename}

\`\`\`
${file.content}
\`\`\`

只回复这个 JSON：
{"reviews": [{"path": "${file.filename}", "line": <行号>, "body": "<问题描述>", "severity": "error"|"warning"|"info"}]}`
    : `You are a code security auditor. Check this code for EXACTLY 3 categories of high-priority bugs. Report ONLY confirmed issues.

## Checks (in priority order)

### 1. URL/Path Injection (report as error)
- Find ALL places where \`\${...}\` or string concatenation builds a URL, path, or command
- For each: is the variable validated/sanitized/escaped before interpolation?
- If NOT validated → report as error
- Watch for: parameters directly interpolated into fetch/axios URLs

### 2. Swallowed Async Errors (report as warning)
- Find ALL \`void someAsync()\` or un-awaited Promise calls
- Where does the rejection go? Can the outer try-catch catch it?
- If the error is silently lost → report as warning

### 3. Corrupted State on Error Paths (report as warning)
- In catch blocks: are counters/flags incorrectly reset?
- Is state modified in error paths that should only change on success?
- If you find inconsistent state → report as warning
${validatorsContext}
**Rules**:
- ONLY report these 3 categories. No style/formatting/naming issues.
- Quote the exact code and explain WHY it's wrong
- If no issues found, return empty list${langInstruction}

File: ${file.filename}

\`\`\`
${file.content}
\`\`\`

Respond with ONLY this JSON:
{"reviews": [{"path": "${file.filename}", "line": <number>, "body": "<description>", "severity": "error"|"warning"|"info"}]}`;

  return prompt;
}

// ── Grep 预扫描：找同目录的校验函数 ──────────────────────
function grepValidators(fileDir: string, allFiles: { filename: string; content: string }[]): string {
  const validators: string[] = [];
  const pattern = /(?:function|const|let|export)\s+(validate\w*|sanitize\w*|escape\w*|check\w*|verify\w*)/gi;

  for (const f of allFiles) {
    if (dirname(f.filename) === fileDir) {
      const matches = f.content.match(pattern);
      if (matches) {
        for (const m of matches) {
          const name = m.replace(/^(?:function|const|let|export)\s+/, '');
          if (!validators.includes(name)) validators.push(name);
        }
      }
    }
  }

  return validators.join(', ');
}

// ── Full scan: 发 GitHub Issue ────────────────────────────
async function createReviewIssue(
  octokit: Octokit,
  owner: string,
  repo: string,
  reviews: ReviewComment[]
): Promise<void> {
  const errors = reviews.filter(r => r.severity === 'error');
  const warnings = reviews.filter(r => r.severity === 'warning');
  const infos = reviews.filter(r => r.severity === 'info');

  const title = `🤖 Full Scan Report — ${reviews.length} issue(s) found`;

  let body = `## 🤖 AI Full Scan Report\n\n`;
  body += `| Severity | Count |\n|----------|-------|\n`;
  body += `| 🔴 Error | ${errors.length} |\n| 🟡 Warning | ${warnings.length} |\n| 🔵 Info | ${infos.length} |\n\n`;

  if (errors.length > 0) {
    body += `### 🔴 Errors\n\n`;
    for (const r of errors.slice(0, 30)) {
      body += `- **\`${r.path}:${r.line}\`** — ${r.body}\n`;
    }
    if (errors.length > 30) body += `\n... and ${errors.length - 30} more errors\n`;
    body += '\n';
  }

  if (warnings.length > 0) {
    body += `### 🟡 Warnings\n\n`;
    for (const r of warnings.slice(0, 20)) {
      body += `- **\`${r.path}:${r.line}\`** — ${r.body}\n`;
    }
    if (warnings.length > 20) body += `\n... and ${warnings.length - 20} more warnings\n`;
    body += '\n';
  }

  if (infos.length > 0) {
    body += `### 🔵 Info\n\n`;
    for (const r of infos.slice(0, 10)) {
      body += `- **\`${r.path}:${r.line}\`** — ${r.body}\n`;
    }
    if (infos.length > 10) body += `\n... and ${infos.length - 10} more\n`;
    body += '\n';
  }

  if (reviews.length === 0) {
    body += `\n✅ No issues found — clean scan!\n`;
  }

  body += `\n---\n*Generated by [Newma Review](https://github.com/marketplace/actions/newma-review)*`;

  await octokit.issues.create({ owner, repo, title, body, labels: ['ai-review'] });
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

// ── Diff 模式（原逻辑）──────────────────────────────────
async function runDiffMode(inputs: ReturnType<typeof getInputs>): Promise<void> {
  const { owner, repo } = github.context.repo;
  const prNumber = github.context.payload.pull_request?.number;

  if (!prNumber) {
    core.setFailed('Diff mode requires a pull request.');
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

  setOutputsAndSummary(validReviews);
}

// ── Full 模式（串行逐文件，尊重 API 并发限制）────────────
async function runFullMode(inputs: ReturnType<typeof getInputs>): Promise<void> {
  const { owner, repo } = github.context.repo;
  const octokit = new Octokit({ auth: inputs.githubToken });
  const patterns = inputs.ignorePatterns.split(',').filter((p) => p.trim());

  // 读本地文件
  const repoFiles = readRepoFiles(process.cwd(), inputs.maxFiles, patterns);
  core.info(`Found ${repoFiles.length} file(s) to scan`);

  if (repoFiles.length === 0) {
    core.info('No code files found');
    return;
  }

  // 串行逐文件调用 AI（API 并发限制），每文件间隔 3 秒避免限频
  const allReviews: ReviewComment[] = [];
  for (let i = 0; i < repoFiles.length; i++) {
    const file = repoFiles[i];
    core.info(`[${i + 1}/${repoFiles.length}] Scanning: ${file.filename}`);
    try {
      // grep 预扫描：找同目录的校验函数，注入 prompt 上下文
      const fileDir = dirname(file.filename);
      const validators = grepValidators(fileDir, repoFiles);
      if (validators) {
        core.info(`  Found validators in same dir: ${validators}`);
      }
      const prompt = buildFullScanPrompt(file, inputs.language, validators);
      const reviews = await callAI(inputs.aiBaseUrl, inputs.aiApiKey, inputs.aiModel, prompt, inputs.language);
      core.info(`  Found ${reviews.length} issue(s)`);
      allReviews.push(...reviews);
    } catch (err: any) {
      core.warning(`Failed to scan ${file.filename}: ${err.message}`);
    }
    // 避免 API 限频
    if (i < repoFiles.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }

  // 发 GitHub Issue
  await createReviewIssue(octokit, owner, repo, allReviews);
  core.info(`Created review issue with ${allReviews.length} finding(s)`);

  setOutputsAndSummary(allReviews);
}

// ── 共用：输出 + Summary ────────────────────────────────
function setOutputsAndSummary(reviews: ReviewComment[]): void {
  const errors = reviews.filter(r => r.severity === 'error').length;
  const warnings = reviews.filter(r => r.severity === 'warning').length;
  const infos = reviews.filter(r => r.severity === 'info').length;

  core.setOutput('total-issues', reviews.length);
  core.setOutput('errors', errors);
  core.setOutput('warnings', warnings);
  core.setOutput('info', infos);

  const summary = core.summary;
  summary.addHeading('🤖 AI Code Review Summary');
  summary.addRaw(
    `| Severity | Count |\n|----------|-------|\n` +
    `| 🔴 Error | ${errors} |\n` +
    `| 🟡 Warning | ${warnings} |\n` +
    `| 🔵 Info | ${infos} |\n`
  );
  if (reviews.length > 0) {
    summary.addHeading('Issues', 3);
    for (const r of reviews.slice(0, 20)) {
      summary.addRaw(`- **${r.severity}** \`${r.path}:${r.line}\` — ${r.body}\n`);
    }
    if (reviews.length > 20) {
      summary.addRaw(`\n... and ${reviews.length - 20} more\n`);
    }
  }
  summary.write();
}

// ── Main ────────────────────────────────────────────────
async function main(): Promise<void> {
  try {
    const inputs = getInputs();
    core.info(`Mode: ${inputs.mode}`);

    if (inputs.mode === 'full') {
      await runFullMode(inputs);
    } else {
      await runDiffMode(inputs);
    }
  } catch (error: any) {
    core.setFailed(`Action failed: ${error.message}`);
  }
}

main();
