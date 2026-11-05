# Configuration (`openreview.yml`)

Resolution order: `.github/openreview.yml` > `.github/openreview.yaml` > `openreview.yml`.

## Full annotated sample

```yaml
version: 1 # schema version (required). Additive-only in v1.x.
# requires_action: ">=0.3.0" # optional floor for the action release; the workflow uses: ref selects it.

defaults:
  # NOTE: event triggers live in the WORKFLOW (`on: pull_request: types:`),
  # not here — the action can only observe the event, never subscribe.
  command: "/review" # issue-comment trigger: must match EXACTLY (trimmed), and only an
                     # author_association in allowed-author-associations may send it
  lang: en
  ignore: ["**.lock", "dist/**"] # path globs skipped everywhere
  max_diff_chars: 80000          # diff truncation budget per agent
  # Diff fetch: all PR files are paginated (up to 300 reviewed; the sticky
  # names any files skipped as binary/unrenderable or over the cap).
  max_runtime_s: 1200           # wall-clock budget for the whole run (default 1200)
  max_concurrency: 4            # agents in flight per review (default 4)
  max_context_chars: 20000       # cross-file context budget per review (0 = diff only)
  include_full_files: true       # include full changed files as context by default

providers:
  go: # any name; referenced by agents below
    protocol: openai-chat # openai-chat | anthropic-messages
    model: glm-5.3-flash
    base_url: https://opencode.ai/zen/go/v1
    key_from: secrets.OPENCODE_API_KEY # any $NAME
    # auth: { header: api-key, scheme: "" } # Azure style; default is Bearer
    # headers: { X-Extra: v }              # merged per request
    # endpoint_path: /chat/completions     # default per protocol
    # json_mode: false                     # drop response_format for strict APIs
    # extra_body: { temperature: 0.1 }     # merged into request JSON
    # retries: 2                           # retry budget for empty/5xx/429/network (0-5)
    # timeout_s: 420                       # per-attempt TOTAL cap, seconds (idle 90s + trickle 60s/1KB guards)
    # fallback_models: [kimi-k2.7-code]    # tried in order when this model fails (see Model fallback)
    # models:                              # named per-model overrides sharing this transport + credential
    #   flash: { model: deepseek-v4-flash }# agents address them as `go.flash`;
    #   strict:                            # entries merge over the base — only set keys win
    #     model: kimi-k2.7-code
    #     extra_body: { temperature: 1 }   # kimi rejects any other temperature

reviews:
  - id: general-quality
    if_paths: ["**"] # which files this review SEES (the diff is scoped to these, too)
    main_mode: synthesize # default: main runs after the subagents and merges their findings; `parallel` = main is one more reviewer
    # incremental: false # default: on synchronize, review head-vs-last-reviewed-SHA and
    # carry prior findings for fix validation (see multi-review); /review always runs full
    # suggest_fixes: false # default true: agents attach full replacement lines, rendered
    # as appliable ```suggestion blocks inline and a Suggested fixes section on the sticky
    main: # synthesizer; name defaults to "<id>:main"
      provider: go # or go.flash for a models entry; unknown `go.typo` fails the run naming both
      instructions: "Synthesize sub-agent findings. Strict on bugs, lenient on style."
    subagents:
      - name: correctness
        provider: go
        instructions: "Bugs, race conditions, missing tests."
    verdict:
      mode: comment # comment | approve | request_changes
      min_severity: medium # suggestion | medium | high
      post_inline: true
      deduplicate: true # merge near-duplicate findings (same file+line, ~same comment) into one row attributed to every reporting agent; model fields are validated (confidence clamped to 0-1, numeric strings coerced) and findings on files outside if_paths are dropped with a log line
      # consensus_escalation: true # escalate 2+-agent-confirmed findings one severity (opt-in; default false)

## File context (beyond the diff)

Agents receive more than hunks: the full content of changed in-scope files (each
capped at 12KB), plus call-site excerpts for top-level symbols those files define
(who imports/calls them elsewhere — changed files themselves are never cited as
callers), plus any `context_files` globs — all inside a `<context>` block bounded
by `max_context_chars` (default 20KB, `0` disables everything including excerpts). Findings must ground in the diff; context is
evidence only (agents are instructed never to flag context-only code). The repo
is walked once per run and shared by all reviews; excerpt hunting stops at a
2MB scan budget and only traces symbols the changed files actually define.

```yaml
reviews:
  - id: general-quality
    context_files: ["src/types.ts", "db/schema.sql"] # always include these
    include_full_files: true   # or false for diff-only reviews
    max_context_chars: 20000   # per-review budget override
```

## Runtime budget

A run's worst case is `reviews x agents x (1 + retries) x timeout_s`, which with
the shipped defaults is tens of minutes. Two knobs bound it:

- `defaults.max_runtime_s` (30-14400, default 1200): once the budget is spent no
  further agent call is started, each per-attempt timeout is clamped to what is
  left, and the remaining agents report `budget-exhausted` — which never casts a
  verdict.
- `defaults.max_concurrency` (1-32, default 4): caps agents in flight per review,
  so a large fan-out is shaped instead of burst.

An empty-but-successful response is retried once, not `retries` times: a model
that keeps answering in a field we don't read will do so on attempt 3 too, and
each attempt costs real wall-clock. Raise `retries` for genuinely transient
failures (5xx, 429, transport).

## Model fallback

Free and preview models are retired without notice. `fallback_models` lists up
to 5 models to try, in order, on the same `base_url` and key:

```yaml
providers:
  go:
    protocol: openai-chat
    model: cat-jam-free
    base_url: https://opencode.ai/zen/go/v1
    key_from: secrets.OPENCODE_API_KEY
    extra_body: { reasoning_effort: "low" }
    fallback_models:
      - glm-5.3-flash                                  # bare id: inherits everything else
      - { model: deepseek-v4.1-flash, json_mode: true, extra_body: { max_tokens: 8000 } }
```

- **When it moves on:** at once on a model-level error (model unavailable, not
  found or unsupported, HTTP 402, quota or usage limit), or after the model's
  `retries` are spent on a transient error (5xx, 429, timeout, network).
- **When it does not:** auth errors (401/403) fail as before, because the key is
  shared. A reply that came back but could not be parsed is not a failure and
  does not fall back.
- **Steps** override only `retries`, `timeout_s`, `json_mode` and `extra_body`;
  a step's `extra_body` replaces the base's instead of merging into it.
- **Budget:** `defaults.max_runtime_s` covers the whole chain; no model starts
  once it is spent. The last model in the chain keeps its full retries.
- **Visibility:** findings name the model that answered, the agents table shows
  `first → next (why first failed)`, and the Models footer lists every model
  that spent tokens.
- A `models.<name>` entry inherits the base chain; set `fallback_models: []` on
  it to turn the chain off for that entry.

On a 429 or 503 that sends `Retry-After`, the retry waits that long (capped at
60s, and never past the run budget) instead of the fixed 2s steps.

## Noise controls (profiles)

`profile` presets how much the bot says; explicit `min_confidence` /
`max_findings` override the preset. Set per review or under `defaults`.

```yaml
reviews:
  - id: general-quality
    profile: balanced # quiet | balanced | assertive
    min_confidence: 0.6 # explicit knobs override the profile preset
    max_findings: 10
    # suppress: ["backdate the config"] # decided items: case-insensitive regexes
    # matched against "<file> <comment>", dropped before verdict math (never vote).
    # Per-review wins over defaults.suppress. Invalid regex fails load naming the entry.
```

| Profile | `min_confidence` | `max_findings` | Effect |
|---|---|---|---|
| `quiet` | 0.85 | 3 | high-confidence top-3 only |
| `balanced` (default) | 0 | 50 | historical behavior (no effective filtering) |
| `assertive` | 0 | 100 | everything the model returns |

Severity stays owned by `verdict.min_severity`; profiles only add confidence +
cap. Filtering applies before verdict/ballots, and dropped counts are logged —
one pipeline, no divergence between what's posted and what's decided.

global_verdict: # merges per-review verdicts
  strategy: any_blocking # any_blocking | max_severity | majority
  sticky_comment: true
  # sticky_comment_mode: update # update (default): sticky always shows the latest run | append: every run adds a headed section, history kept in one comment (rotates past ~60KB)
  fail_check_on_request_changes: false # fail CI when verdict is request_changes?
```

Top-level keys: `version`, `extends` (optional template inheritance — see
[Templates](./templates)), `requires_action` (optional release floor, e.g.
`">=0.3.0"` — the workflow `uses:` ref selects the release, the yaml only guards
it), `defaults`, `providers{}`, `reviews[]`, `global_verdict`.

Do NOT pin the action release in the yaml — it is read after the release is
downloaded and can only validate, not select.

Validate locally after `npm run build`: `node dist-src/validate.js .github/openreview.yml`.

See root `openreview.example.yml` and `schema/openreview.schema.json` as source of truth.
