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
| `cat-jam-free`, `space-bunny-free`, `longcat-2.5-preview-free` | **Free / unlimited (limited time)**. `cat-jam-free` is what this repo uses; `space-bunny-free` has answered "Model is unavailable" since 2026-10-13; `longcat-2.5-preview-free` is not review-capable. See below |
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

Free models disappear without notice, so pair one with a
[`fallback_models`](../configuration.md#model-fallback) chain. When the free model
answers "Model is unavailable", the review moves to the next model in the same
run instead of failing.

Go's free models change without notice: the table above was checked on
2026-10-02, and `cat-jam-free` (used by this repo since 2026-10-15) appeared
after it. For a PR on every push, free models are the sensible default
— usage is only a few thousand tokens per review, and subscription minutes add up
fast over a busy repo:

```yaml
providers:
  go:
    protocol: openai-chat
    model: cat-jam-free
    base_url: https://opencode.ai/zen/go/v1
    key_from: secrets.OPENCODE_API_KEY
```

**Do not use `longcat-2.5-preview-free` for reviews.** Before it became
unavailable, `space-bunny-free` was compared against it. Both are
free and both reason, but on a full-size diff `longcat-2.5-preview-free` answers
7-8k characters of **markdown prose with no JSON at all**, so every agent ends as
`unusable response` and the run reports zero findings. It also ignores
`response_format: {type: json_object}`, so `json_mode` cannot fix it and neither
could a much harder prompt instruction. `space-bunny-free` honours the JSON
contract on real diffs. This repo reviewed itself with it until OpenCode began
answering it with `Upstream request failed: Model is unavailable` (2026-10-13).
It now uses `cat-jam-free`, which reviewed 2/2 in a few seconds. A trial of
`deepseek-v4-flash` finished only 2 of 10 agent calls: it kept thinking until
it hit even a 16000-token output budget.

Verify before you trust a model on a real diff, not a toy prompt:

```bash
OPENCODE_API_KEY=sk-... npm run probe:model <model-id>
```

Keep `json_mode: true` (the default). Turning it off removes
`response_format: {type: json_object}`, and a model that ignores the "JSON only"
instruction then answers in markdown — which shows up as `unusable response` on
every agent. OpenReview's parser tolerates prose *around* JSON, not prose
*instead of* it. Only disable `json_mode` for a provider that actually rejects
`response_format` (the PR's error block names it).

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
> Cap the thinking, not the answer: on an 80k-char diff `space-bunny-free`
> thinks ~9.5k chars, exhausts the 2000-token output budget, and returns empty
> content with `finish_reason=length` (0/5 parseable across both prompt styles;
> raising the cap to 8000 does not help — thinking expands to fill it, 0/2).
> With `extra_body: { reasoning_effort: "low" }` the same diff parses 2/2 with
> real findings. This repo sets that on its own provider; do the same for any
> reasoning reviewer on a busy repo.
> The output cap is 2000 tokens per agent, or 4000 for a synthesizing `main`
> (it also writes the summary and walkthrough); `extra_body: { max_tokens: N }`
> overrides both. `deepseek-v4-flash` with `reasoning_effort: "low"` writes its
> thinking as prose *before* the JSON and keeps going until the cap: on #82 it
> was cut off at both 2000 and 8000 tokens, so this repo switched its own
> reviews to `cat-jam-free`.

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
