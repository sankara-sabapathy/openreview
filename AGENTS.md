# AGENTS.md — OpenReview contributor context

This file gives any coding agent the full context needed to work in this repo.
Read it before making changes.

## What this is

**OpenReview AI** — free, open-source, BYOK multi-provider multi-agent PR reviewer,
shipped as a **GitHub Action** (Node, `action.yml` → `dist/index.js`) + a Docusaurus
docs site (`website/`). Marketplace: `sankara-sabapathy/openreview`.
Live docs: https://sankara-sabapathy.github.io/openreview/

How it works: a consumer repo adds `.github/workflows/ai-review.yml` (calls this
action with provider API keys as secrets) + `.github/openreview.yml` (reviews config).
On PR open/sync or a `/review` comment, the action fetches the diff via the GitHub
API, fans out to `main` + `subagents` across any configured LLM providers, merges
verdicts, and posts a sticky comment + inline review.

## Layout

- `action.yml` — action metadata (name must stay Marketplace-unique: `OpenReview AI`).
  Runtime `node24`, entry `dist/index.js`.
- `src/` — TypeScript source (output `dist-src/`, then bundled to `dist/` with ncc):
  - `config.ts` — zod schema for `openreview.yml` (source of truth for config).
  - `providers.ts` — generic two-protocol transport (`openai-chat`,
    `anthropic-messages`): `resolveProvider()` maps `kind`→protocol/base (back-compat),
    `key_from`, `auth`, `headers`, `endpoint_path`, `json_mode`, `extra_body`.
  - `reviewer.ts` — path globs, dedupe, per-review + global verdict math, semver
    `requires_action` check.
  - `github.ts` — sticky comment (`openreview:sticky` marker), inline reviews.
  - `main.ts` — orchestration: load config → diff → fan-out → verdict → publish.
  - `validate.ts` — CLI config validator (`node dist-src/validate.js <file>`).
  - `index.ts` — entrypoint (invokes `run()`).
- `dist/` — **committed** ncc bundle. The published action runs from here.
- `schema/openreview.schema.json` — JSON Schema mirror of `config.ts`.
- `openreview.example.yml` — full commented example for consumers.
- `.github/openreview.yml` — this repo's own dogfood config (see rule below).
- `.github/workflows/` — `ai-review.yml` (dogfood trigger; named to not collide
  with the `openreview.yml` config), `ci.yml` (typecheck/build/
  package/validate + dist-fresh check), `release.yml` (release-please + move `v0`
  tag), `docs.yml` (Pages deploy).
- `website/` — Docusaurus v3 docs site, deployed to GitHub Pages from `main`.

## Invariants (do not break)

1. **`dist/` is committed and fresh.** After any `src/` change run
   `npm run build && npm run package` and commit `dist/`. CI fails otherwise.
2. **Config v1 is additive-only.** New fields must be optional with defaults so old
   yamls keep working. Breaking changes wait for `version: 2` + migration guide.
3. **`kind:` is deprecated but supported.** Keep the `kindDefaults` mapping in
   `providers.ts` until a v2 cleanup.
4. **Action version tags:** release-please cuts `v0.x.y`; `release.yml` moves `v0`.
   `v1` is moved manually to the latest release (`git tag -f v1 v0.x.y && git push origin v1 --force`).
5. **No per-release Marketplace step.** The listing tracks the latest GitHub Release
   automatically after the one-time publish.
6. **Secrets never in logs.** Keys travel as env only; error messages must not echo them.

## Config reference rule (mandatory)

`.github/openreview.yml` is the **canonical live showcase** of the config format —
the file newcomers copy from. Therefore:

- It must demonstrate **every available field** (`version`, `requires_action`,
  all `defaults`, provider `kind/protocol/model/base_url/key_from/auth/headers/
  endpoint_path/json_mode/extra_body`, review `id/if_paths/main/subagents/verdict`,
  `global_verdict`). Fields this repo doesn't need stay present but **commented out**.
- **On every core change** (new config field, new provider capability, deprecation,
  behavior change): update `.github/openreview.yml`, `openreview.example.yml`,
  `schema/openreview.schema.json`, and the affected `website/docs/*` page **in the
  same PR**, then run `node dist-src/validate.js` on both yamls.
- Never let README / website / example / dogfood config disagree about what the
  code does (see issue #12 for what happens when they do).

## Docs conventions (Diátaxis)

`website/docs/` follows one-role-per-page: `intro` (orientation), `quickstart`
(tutorial), `configuration` + `providers` + `multi-review` (reference),
`versioning` + `troubleshooting` (how-to/explanation support). Keep pages in their
lane; verify every snippet against the code before committing.

## Test loop

- `npm run typecheck && npm run build && node dist-src/validate.js openreview.example.yml`
- **PR reviews run the branch, not the release.** `.github/workflows/ai-review.yml`
  uses `uses: ./` while a PR is open, so the dogfood review exercises the
  change being proposed (with `@v1` it always reviews the last release, so a
  fix PR is "reviewed" by the code it is fixing). The **final commit before
  merge** restores `uses: sankara-sabapathy/openreview@v1`. `uses: ./` needs
  `dist/` committed and fresh, which CI already enforces.
- Live dogfood: push to `main`, move `v1` after release, open a **temporary** PR with
  a buggy fixture file, verify sticky + inline comments, then close unmerged and
  delete the branch. Each run spends real provider budget — one verification PR per
  behavior change, not per commit.
- The dogfood review can take 10+ min and is advisory: `ci.yml` (`build`) is the
  merge gate. Treat a `review` failure as "no signal", not "no opinion".
- Commit style: Conventional Commits (`feat:`/`fix:` release; `docs:`/`chore:` don't).
