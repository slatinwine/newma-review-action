# 🤖 Newma Review Action

[![GitHub Marketplace](https://img.shields.io/badge/Marketplace-Newma%20Review-blue?logo=github)](https://github.com/marketplace/actions/newma-review)

AI-powered code review — **diff mode** for PRs, **full mode** for repo-wide security scans.

> **Copy → Paste → Done.**

## What it checks

5-category security audit, not generic "find bugs":

1. **🔴 URL/Path Injection** — unvalidated variables in URL construction
2. **🔴 Secret Leakage** — incomplete redaction in logs/debug output
3. **🟡 Swallowed Async Errors** — void/un-awaited Promises losing errors
4. **🟡 Corrupted State** — counters/flags reset incorrectly in catch blocks
5. **🟡 Default Fail-Open** — permission checks that default to allow

Plus: auto-detects validation functions in the same directory and flags when they're not used.

## Setup (1 minute)

### Diff mode — PR reviews

Create `.github/workflows/review.yml`:

```yaml
name: AI Review
on:
  pull_request:
    types: [opened, synchronize]

permissions:
  pull-requests: write
  contents: read

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: slatinwine/newma-review-action@v0.2.0
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          ai-api-key: ${{ secrets.AI_API_KEY }}
```

### Full mode — repo-wide security scan

```yaml
name: AI Full Scan
on:
  workflow_dispatch:

permissions:
  issues: write
  contents: read

jobs:
  full-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: slatinwine/newma-review-action@v0.2.0
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          ai-api-key: ${{ secrets.ZHIPU_API_KEY }}
          ai-model: glm-4.7-flash
          ai-base-url: https://open.bigmodel.cn/api/paas/v4
          mode: full
          language: zh
```

### Add API key

Repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

- Name: `AI_API_KEY` (or `ZHIPU_API_KEY`)
- Value: your API key

## Using 智谱 (ZhipuAI) — Recommended

```yaml
      - uses: slatinwine/newma-review-action@v0.2.0
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          ai-api-key: ${{ secrets.ZHIPU_API_KEY }}
          ai-model: glm-4.7-flash
          ai-base-url: https://open.bigmodel.cn/api/paas/v4
          language: zh
```

## Using DeepSeek

```yaml
      - uses: slatinwine/newma-review-action@v0.2.0
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          ai-api-key: ${{ secrets.DEEPSEEK_API_KEY }}
          ai-model: deepseek-chat
          ai-base-url: https://api.deepseek.com/v1
```

## All Inputs

Only `github-token` and `ai-api-key` are required. Everything else has sensible defaults.

| Input | Default | Description |
|-------|---------|-------------|
| `github-token` | — | Auto-provided by GitHub Actions |
| `ai-api-key` | — | Your API key |
| `ai-model` | `gpt-4o-mini` | Any OpenAI-compatible model |
| `ai-base-url` | `https://api.openai.com/v1` | Change for non-OpenAI providers |
| `max-files` | `20` | Max files to review |
| `ignore-patterns` | `''` | Comma-separated globs to skip (e.g. `*.lock,dist/*`) |
| `mode` | `diff` | `diff` = PR review, `full` = repo-wide scan (creates Issue) |
| `language` | `en` | Review comment language (`en`, `zh`, etc.) |

## Benchmarks

Tested against Claude Code source (18 files, 22 known issues):

| Version | Errors found | Total found | Recall |
|---------|:-----------:|:-----------:|:------:|
| v0.1.0  | 0/4         | 2/22        | 9%     |
| v0.2.0  | 8/4*        | 12/22       | 55%    |

*vrior-mode catches more injection bugs than Claude found — 8 errors vs Claude's 4.

## Cost

Free tier: glm-4.7-flash has free quota on 智谱. GPT-4o-mini: ~$0.01/PR.

## License

MIT
