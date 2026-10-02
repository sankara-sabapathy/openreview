# Configuration (`openreview.yml`)

Resolution order: `.github/openreview.yml` > `.github/openreview.yaml` > `openreview.yml`.

## Full annotated sample

```yaml
version: 1 # schema version (required). Additive-only in v1.x.
# requires_action: ">=0.3.0" # optional floor for the action release; the workflow uses: ref selects it.

defaults:
  on: [opened, synchronize, ready_for_review]
  command: "/review" # issue-comment trigger: must match EXACTLY (trimmed), and only an
                     # author_association in allowed-author-associations may send it
  draft: false       # review draft PRs?
  lang: en
  ignore: ["**.lock", "dist/**"] # path globs skipped everywhere
  max_diff_chars: 80000          # diff truncation budget per agent
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

reviews:
  - id: general-quality
    if_paths: ["**"] # which files this review sees
    main: # synthesizer; name defaults to "<id>:main"
      provider: go
      instructions: "Synthesize sub-agent findings. Strict on bugs, lenient on style."
    subagents:
      - name: correctness
        provider: go
        instructions: "Bugs, race conditions, missing tests."
    verdict:
      mode: comment # comment | approve | request_changes
      min_severity: medium # suggestion | medium | high
      post_inline: true
      deduplicate: true

## File context (beyond the diff)

Agents receive more than hunks: the full content of changed in-scope files (each
capped at 12KB), plus call-site excerpts for top-level symbols those files define
(who imports/calls them elsewhere — changed files themselves are never cited as
callers), plus any `context_files` globs — all inside a `<context>` block bounded
by `max_context_chars` (default 20KB, `0` disables everything including excerpts). Findings must ground in the diff; context is
evidence only (agents are instructed never to flag context-only code).

```yaml
reviews:
  - id: general-quality
    context_files: ["src/types.ts", "db/schema.sql"] # always include these
    include_full_files: true   # or false for diff-only reviews
    max_context_chars: 20000   # per-review budget override
```

## Noise controls (profiles)

`profile` presets how much the bot says; explicit `min_confidence` /
`max_findings` override the preset. Set per review or under `defaults`.

```yaml
reviews:
  - id: general-quality
    profile: balanced # quiet | balanced | assertive
    min_confidence: 0.6 # explicit knobs override the profile preset
    max_findings: 10
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
