# Troubleshooting

- `No config found`: add `.github/openreview.yml`.
- Need more signal? Set `log-level: debug` on the action step: per-agent endpoint
  (keys redacted), prompt sizes, and resolved config. Default `info` already logs
  reviews, ballots, timings, and publish confirmations.
- `unknown provider`: check `providers{}` keys match `main.provider` / `subagents[].provider`.
- Empty review: check `if_paths` / `defaults.ignore` and diff size (`max_diff_chars`).
- `Inline review failed`: non-fatal; sticky comment is source of truth (commit SHA or permission issue).
- No LLM output: verify secrets exist for the providers you reference. If all agents failed, the sticky comment shows a details block with each agent's error.
- `FreeTierError` (OpenCode): free-tier keys only work inside OpenCode itself. Use a Go subscription or Zen balance key for API access (`zen/go/v1` vs `zen/v1` + matching model IDs).
- `requires_action` failure: the runner release is older than the config floor — bump the workflow `uses:` ref.
