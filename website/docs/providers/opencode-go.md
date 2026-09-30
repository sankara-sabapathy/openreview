# OpenCode Go ($10/mo subscription)

Curated open coding models on a flat subscription. Official docs: [Go](https://opencode.ai/docs/go/) · [Console / usage](https://opencode.ai/auth). Model list and limits change — the Go page is authoritative.

## 1. Get a key

Sign in at [opencode.ai/auth](https://opencode.ai/auth), subscribe to **Go**, copy the
API key → repo secret `OPENCODE_API_KEY`.

## 2. Configure

```yaml
providers:
  go:
    protocol: openai-chat
    model: glm-5.3-flash # see table
    base_url: https://opencode.ai/zen/go/v1
    key_from: secrets.OPENCODE_API_KEY
reviews:
  - id: general-quality
    main:
      provider: go
      instructions: "Synthesize findings. Strict on bugs, lenient on style."
    subagents:
      - { name: correctness, provider: go, instructions: "Bugs, races, missing tests." }
    verdict: { mode: comment, min_severity: medium }
```

OpenReview calls `POST https://opencode.ai/zen/go/v1/chat/completions` and sends
`User-Agent: OpenReview/*` plus a stable per-run `x-opencode-session` header, as Go
requires for routing/prompt-caching. Only `chat/completions`-listed models work
(GPT/Grok/Anthropic-protocol rows in the Go table use other endpoints).

## Go models on `chat/completions` (checked 2026-09-28)

| Model ID | Monthly included usage |
|---|---|
| `glm-5.3-flash` | $60 — **recommended default reviewer** |
| `kimi-k2.7-code` | $60 — coding specialist, good subagent/main |
| `kimi-k2.6` | $60 |
| `deepseek-v4-flash` | $30 |
| `deepseek-v4.1-flash` | $60 |
| `qwen3.7-plus` / `qwen3.6-plus` | $60 |
| `mimo-v2.6-flash` / `mimo-v2.5` | $60 |
| `hy3` / `hy4-preview` | $60 / $30 |
| `longcat-2.0` | $60 |
| `space-bunny-free`, `longcat-2.5-preview-free` | Unlimited (limited time) |

Usage beyond limits blocks unless **Use balance** (Zen credits) is enabled in the console.

> **Known flake (2026-09-30, [issue #30](https://github.com/sankara-sabapathy/openreview/issues/30)):**
> `glm-5.3-flash` intermittently returns **empty content** (upstream thinking
> degeneration + gateway 500/503/524s — see [opencode#45533](https://github.com/anomalyco/opencode/issues/45533),
> [#36889](https://github.com/anomalyco/opencode/issues/36889)). OpenReview retries
> empties/5xx/429s (`retries:`, default 2) and surfaces total failure in the PR's
> error block instead of silently approving. For default reviewers we currently
> recommend `kimi-k2.7-code` (reliable in live runs; needs `extra_body: {temperature: 1}`).

> **Model quirk found by dogfood:** `kimi-k2.7-code` rejects any `temperature`
> other than `1` (OpenReview defaults to `0.2`). Override per provider:
> `extra_body: { temperature: 1 }`. If a new model 400s on a parameter, the PR's
> error block names it — move that parameter into `extra_body`.
