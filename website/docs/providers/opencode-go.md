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

## Go models on `chat/completions` (checked 2026-10-02, `GET /zen/go/v1/models`)

| Model ID | Monthly included usage |
|---|---|
| `longcat-2.5-preview-free`, `space-bunny-free` | **Free / unlimited (limited time)** |
| `glm-5.3-flash` | $60 — good all-round reviewer |
| `kimi-k2.7-code` | $60 — coding specialist, good subagent/main |
| `kimi-k2.6`, `kimi-k3` | $60 |
| `deepseek-v4-flash`, `deepseek-v4.1-flash` | $30 / $60 |
| `qwen3.7-plus` / `qwen3.6-plus`, `qwen3.8-flash` | $60 |
| `mimo-v2.6-flash` / `mimo-v2.5` | $60 |
| `hy3` / `hy4-preview` | $60 / $30 |
| `longcat-2.0` | $60 |
| `minimax-m3` / `minimax-m2.7`, `gpt-6-luna` / `gpt-5.6-luna`, `grok-4.7` | $60 |

Usage beyond limits blocks unless **Use balance** (Zen credits) is enabled in the console.

## Free tier

Go lists exactly **two** free models: `longcat-2.5-preview-free` and
`space-bunny-free`. For a PR on every push, free models are the sensible default
— usage is only a few thousand tokens per review, and subscription minutes add up
fast over a busy repo:

```yaml
providers:
  go:
    protocol: openai-chat
    model: longcat-2.5-preview-free
    base_url: https://opencode.ai/zen/go/v1
    key_from: secrets.OPENCODE_API_KEY
    json_mode: false   # the parser tolerates prose-wrapped JSON; no need to depend on it
```

> **Reasoning models cost more than they look — measure before you assume.**
> Most modern models think to some degree, including both free ones above, so
> "is it a reasoning model" is the wrong question; **how much does it think** is
> the right one. `npm run probe:model` answers it directly:
>
> ```
> {"model":"longcat-2.5-preview-free","reasoning":147,"content":5,"completion_tokens":38,"verdict":"REASONING"}
> {"model":"space-bunny-free","reasoning":0,"content":5,"completion_tokens":3,"verdict":"plain"}
> {"model":"deepseek-v4-flash","reasoning":151,"content":5,"completion_tokens":41,"verdict":"REASONING"}
> ```
>
> The tells, strongest first: a non-empty `reasoning_content` field; then
> `completion_tokens` far exceeding the visible answer length (thinking is billed
> inside `completion_tokens`, so the usage footer overstates real output for
> these models); then `finish_reason: "length"` with empty content, meaning the
> thinking ate the whole `max_tokens` budget.
>
> In practice `deepseek-v4-flash` billed **100k+ reasoning tokens** on a full PR
> diff and sometimes returned an *empty* `content` field, which OpenReview read
> as an empty response and retried — 10+ minute runs. The free models reason far
> more briefly (~300-1200 chars on a small diff) and returned valid findings JSON
> on 3/3 probe runs. If a reviewer is slow and expensive, probe it before you
> trust it. OpenReview reads `reasoning_content` as a fallback
> ([#26](https://github.com/sankara-sabapathy/openreview/issues/26)).

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
