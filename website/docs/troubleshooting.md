# Troubleshooting

- `No config found`: add `.github/openreview.yml`.
- Need more signal? Set `log-level: debug` on the action step: per-agent endpoint
  (keys redacted), prompt sizes, and resolved config. Default `info` already logs
  reviews, ballots, timings, and publish confirmations.
- `unknown provider`: check `providers{}` keys match `main.provider` / `subagents[].provider`.
- Empty review: check `if_paths` / `defaults.ignore` and diff size (`max_diff_chars`).
- `Inline review failed`: non-fatal; sticky comment is source of truth (commit SHA or permission issue).
- `No LLM output`: verify secrets exist for the providers you reference. Every agent's outcome is listed in the **agent results** table in the sticky comment (`✅ reviewed` / `⏭️ skipped (no key)` / `⚠️ unusable response` / `❌ failed`).
- Sticky says **REVIEW FAILED**: no agent produced a usable result, so the verdict is *not* a pass. Check the `review_status` action output (`ok` / `partial` / `error`) — a review whose agents were all skipped or errored never casts an approving ballot.
- `N agent(s) skipped — no API key`: the named agents' provider has no secret. The message lists which agents; the provider block's `key_from` tells you the secret name to add.
- `FreeTierError` (OpenCode): free-tier keys only work inside OpenCode itself. Use a Go subscription or Zen balance key for API access (`zen/go/v1` vs `zen/v1` + matching model IDs).
- `requires_action` failure: the runner release is older than the config floor — bump the workflow `uses:` ref.
