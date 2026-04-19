# 🤖 Newma Review Action

[![GitHub Marketplace](https://img.shields.io/badge/Marketplace-Newma%20Review-blue?logo=github)](https://github.com/marketplace/actions/newma-review)

AI-powered code review for GitHub pull requests.

> **Copy → Paste → Done.**

## Setup (1 minute)

### 1. Add workflow file

Create `.github/workflows/review.yml` in your repo:

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
      - uses: slatinwine/newma-review-action@v0.1.0
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          ai-api-key: ${{ secrets.AI_API_KEY }}
```

### 2. Add API key

Repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

- Name: `AI_API_KEY`
- Value: your API key

That's it. Every PR will now get an AI review.

## Using 智谱 (ZhipuAI)

Set secret name to `ZHIPU_API_KEY` and use:

```yaml
      - uses: slatinwine/newma-review-action@v0.1.0
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          ai-api-key: ${{ secrets.ZHIPU_API_KEY }}
          ai-model: glm-4-flash
          ai-base-url: https://open.bigmodel.cn/api/paas/v4
          language: zh
```

## Using DeepSeek

```yaml
      - uses: slatinwine/newma-review-action@v0.1.0
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
| `max-files` | `20` | Max files to review per PR |
| `ignore-patterns` | `''` | Comma-separated globs to skip (e.g. `*.lock,dist/*`) |
| `language` | `en` | Review comment language (`en`, `zh`, etc.) |

## Cost

GPT-4o-mini: ~$0.01/PR. Less than $1/month for 100 PRs.

## License

MIT
