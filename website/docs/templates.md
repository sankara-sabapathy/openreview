# Review templates

Don't hand-write `openreview.yml` from scratch. Inherit shared config with `extends`:

```yaml
version: 1
extends:
  - openreview/general@0.7.0
  - openreview/security@0.7.0
providers:
  default:
    protocol: openai-chat
    model: glm-5.3-flash
    base_url: https://opencode.ai/zen/go/v1
    key_from: secrets.OPENCODE_API_KEY
```

Templates resolve in order, then your file overlays on top (child wins).

## Reference kinds

- `openreview/<name>[@<version>]` — built-in drop-ins shipped with the action.
  The version is informational (they version with the release).
- `github:<owner>/<repo>[/<path>][@sha:<hex>|@<40-hex>]` — community templates.
  An immutable commit SHA is **required**; branch tags are rejected because they
  would silently change your reviews. Default path is `openreview-template.yml`.
- `./relative.yml` (also `../`, `/abs/`, `file:`) — local files next to your config.

## Merge rules (no magic)

- `defaults`: deep-merge, child wins per key (arrays replace, they don't concat).
- `providers`: merge by name, child wins per provider.
- `reviews`: merge by `id` — child replaces same-id reviews, appends new ones.
- `global_verdict`, `version`, `requires_action`: child wins, else template value.
- Templates may nest (max depth 5); cycles are rejected.
- The fully resolved config (including template SHAs) is printed in the run log,
  so you always see what actually ran.

## Built-ins

| Template | What | Reviews |
|---|---|---|
| `openreview/general` | Balanced default pass | `general-quality` (comment, medium+) |
| `openreview/security` | Strict sensitive-paths pass | `security-strict` (request_changes on high) |
| `openreview/performance` | Perf-focused pass | `performance` (comment, medium+) |
| `openreview/frugal` | Cheapest possible: one agent, one call | `quick-pass` (comment, high only) |

Built-ins define reviews, not credentials: they reference a provider named
`default` that **you** define, so your keys and model choice stay yours.

## Publishing a community template

1. Publish a public repo containing `openreview-template.yml` (any full or partial
   `openreview.yml` shape) and tag the repo with the `openreview-template` topic.
2. Consumers pin you: `github:<you>/<repo>@sha:<commit>`.
3. To join the curated list below, open a PR against this repo's docs.

> **Trust note:** templates are prompt-injection surface. Pin SHAs, review template
> diffs like code, and never extend a repo you wouldn't give reviewer-instructions
> access to — because that is literally what you're doing.

## Community templates

_None curated yet — be the first via docs PR._
