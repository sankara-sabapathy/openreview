# Multi-review + subagents + verdict

Define parallel `reviews[]`, each with `if_paths`, `main`, `subagents[]`, `verdict{mode,min_severity}`.

```yaml
reviews:
  - id: security-strict # runs only on sensitive paths…
    if_paths: ["auth/**", "payments/**"]
    main:
      provider: codex
      instructions: "Staff security reviewer. OWASP, authz, injection. High-confidence only."
    verdict: { mode: request_changes, min_severity: high } # …and can block
  - id: general-quality # …while everything gets the general pass
    if_paths: ["**"]
    main:
      provider: go
      instructions: "Synthesize sub-agent findings."
    subagents:
      - { name: correctness, provider: go, instructions: "Bugs, races, missing tests." }
      - { name: perf, provider: go, instructions: "N+1 queries, hot loops." }
    verdict: { mode: comment, min_severity: medium }
global_verdict:
  strategy: any_blocking # one request_changes verdict decides the run
```

- Each distinct provider used by a review's agents casts one **ballot**: its own
  verdict over its own findings (`mode` + `min_severity`). `strategy` combines them:
  `any` = most severe ballot wins, `all` = unanimous to escalate, `majority` =
  median ballot (even-count ties break toward more severe). Single-provider reviews
  behave identically under all three.
- `global_verdict.strategy: any_blocking|majority` merges per-review verdicts.
- Output: sticky comment (marker `openreview:sticky`), inline `pulls.createReview` (max 20), `verdict` output.
- Every run appends a one-line usage footer to the sticky (`Models: <model> <in>/<out> <tok/s> …`, summed per model) and logs per-agent tokens/sec. Token counts come from each provider's `usage` block; providers that omit it show duration only.
