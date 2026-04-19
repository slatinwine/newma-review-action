# 🤖 Newma Review Action

[![GitHub Marketplace](https://img.shields.io/badge/Marketplace-Newma%20Review-blue?logo=github)](https://github.com/marketplace/actions/newma-review)

AI-powered code review for GitHub pull requests. Zero config, one API key, done.

> **Zero config · Any model · $0.01/PR · 5x parallel**

## Quick Start

```yaml
# .github/workflows/review.yml
name: AI Code Review
on:
  pull_request:
    types: [opened, synchronize]

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: slatinwine/newma-review-action@v0.1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          ai-api-key: ${{ secrets.AI_API_KEY }}
```

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `github-token` | ✅ | — | GitHub token (`${{ github.token }}` works) |
| `ai-api-key` | ✅ | — | AI API key |
| `ai-model` | ❌ | `gpt-4o-mini` | Model name |
| `ai-base-url` | ❌ | `https://api.openai.com/v1` | API base URL (change for non-OpenAI providers) |
| `max-files` | ❌ | `20` | Max files to review per PR |
| `ignore-patterns` | ❌ | `''` | Comma-separated glob patterns to ignore (e.g. `*.lock,*.generated.*,i18n/*`) |
| `language` | ❌ | `en` | Language for review comments (`en`, `zh`, or any language code) |

## Using with 智谱 (ZhipuAI)

```yaml
      - uses: slatinwine/newma-review-action@v0.1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    ai-api-key: ${{ secrets.ZHIPU_API_KEY }}
    ai-model: glm-4-flash
    ai-base-url: https://open.bigmodel.cn/api/paas/v4
```

## Outputs

| Output | Description |
|--------|-------------|
| `total-issues` | Total issues found |
| `errors` | Number of errors |
| `warnings` | Number of warnings |
| `info` | Number of info-level items |

## Cost

GPT-4o-mini: ~$0.003-0.01 per PR. That's < $1/month for 100 PRs.

## License

MIT
