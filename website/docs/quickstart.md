# Quickstart

Get your first AI review in ~5 minutes.

## 1. Add the workflow

Create `.github/workflows/ai-review.yml` in your repo (named to avoid confusion
with the `.github/openreview.yml` config file):

```yaml
name: OpenReview
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  issue_comment:
    types: [created]
permissions:
  pull-requests: write
  issues: write
  contents: read
# One review per PR at a time.
concurrency:
  group: openreview-${{ github.event.pull_request.number || github.event.issue.number || github.run_id }}
  cancel-in-progress: false
jobs:
  review:
    # issue_comment runs in the BASE repo, so your secrets are live. Gate the
    # sender on write access so no random commenter can spend your provider
    # budget. The command match is a cheap pre-filter: `trim()` does not exist
    # in the Actions expression language, and the action itself enforces the
    # EXACT command (defaults.command) plus this same association check.
    if: >-
      github.event_name == 'pull_request' ||
      (github.event_name == 'issue_comment' &&
      github.event.issue.pull_request &&
      github.event.sender.type != 'Bot' &&
      (github.event.comment.author_association == 'OWNER' ||
      github.event.comment.author_association == 'MEMBER' ||
      github.event.comment.author_association == 'COLLABORATOR') &&
      contains(github.event.comment.body, '/review'))
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: sankara-sabapathy/openreview@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          opencode-api-key: ${{ secrets.OPENCODE_API_KEY }}
          # anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          # openai-api-key: ${{ secrets.OPENAI_API_KEY }}
          # log-level: debug # debug | info (default) | warn | error
          # allowed-author-associations: "" # default = OWNER,MEMBER,COLLABORATOR
```

## 2. Add secrets

Repo **Settings → Secrets and variables → Actions → New repository secret**.
Add only what your config uses — e.g. `OPENCODE_API_KEY` for the starter below.
Provider guides ([Claude](./providers/claude), [OpenAI](./providers/openai),
[Go](./providers/opencode-go), [Zen](./providers/opencode-zen)) show where each key comes from.

## 3. Add the config

Create `.github/openreview.yml` (OpenCode Go example — swap provider for others):

```yaml
version: 1
providers:
  go:
    protocol: openai-chat
    model: glm-5.3-flash
    base_url: https://opencode.ai/zen/go/v1
    key_from: secrets.OPENCODE_API_KEY
reviews:
  - id: general-quality
    main:
      provider: go
      instructions: "Be strict on bugs, lenient on style."
    subagents:
      - name: correctness
        provider: go
        instructions: "Bugs, races, missing tests."
    verdict: { mode: comment }
```

## 4. Open a PR

Push a branch, open a pull request — the review lands as a sticky comment plus
inline findings. Comment `/review` on the PR to re-run after pushes.

No keys configured? The run still posts a comment telling you which secrets are
missing — so a first green run already proves the plumbing.

Running on your own machines? See [Self-hosted runners](./self-hosted) — one
label change, plus the secrets rules for fork PRs.

## Disclaimer

OpenReview is MIT software provided as-is: you own your keys, your provider bills,
and everything merged in your repos. AI findings can be wrong — a human must review
before merging.
