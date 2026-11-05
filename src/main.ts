import * as core from "@actions/core";
import * as github from "@actions/github";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import * as YAML from "yaml";
import { parseConfig, formatZodError, type OpenReviewConfig } from "./config.js";
import { ZodError } from "zod";
import { templateContextFor, resolveExtends, mergeConfigs, parseConfigLoose } from "./templates.js";
import {
  resolveKeysFromEnv,
  runAgentWithFallback,
  ChainFailedError,
  type ModelLeg,
  formatTokens,
  countsAsReview,
  AgentFailedError,
  resolveDottedProvider,
  assertProviderRefs,
  runTextAgent,
  type Finding,
  type AgentOutcome,
} from "./providers.js";
import {
  matchesAny, filterIgnored, dedupeFindings, applySuppression, decideReviewVerdict, combineVerdicts, combineBallots,
  applyDegradedFloor, resolveNoise, applyNoiseControls, splitDiff, scopeDiff, parseHunkRanges, type Verdict,
  satisfiesActionVersion, runningActionVersion, builtActionVersion, renderPriorReview, matchCarriedFindings, validateFindingFiles,
  scanPromptInjection, groupByAgent, escalateConsensus,
} from "./reviewer.js";
import { parseAskComment, buildAskPrompt, collectFeedbackSignals, isAskAllowed, resolveAskProvider } from "./ask.js";
import { renderStickyBody, upsertStickyComment, appendStickySection, renderAppendSection, createInlineReview, findStickyComment, parseStickyState, sanitizeErrorDetail, type RunStatus, type StickyFindingState } from "./github.js";
import { initLogger, logInfo, logWarning, logDebug } from "./logger.js";
import { buildContextBlock, buildRepoIndex } from "./context.js";
import { authorizeTrigger } from "./authorize.js";
import { labelFindings, renderPriorFindings, mergeSynthesis, type Synthesis } from "./synthesis.js";

const CONFIG_CANDIDATES = [
  ".github/openreview.yml",
  ".github/openreview.yaml",
  "openreview.yml",
  "openreview.yaml",
];

export async function loadConfig(configPath: string, explicit = false) {
  // An explicit config-path that names nothing is a typo, not a default
  // (issue #58d): fail hard instead of silently reviewing another file.
  if (explicit && !existsSync(configPath)) {
    throw new Error(
      `Config file not found: ${configPath} (explicit config-path; not falling back to .github/openreview.yml). ` +
        `See website/docs/configuration.md.`
    );
  }
  const candidates = [configPath, ...CONFIG_CANDIDATES.filter((c) => c !== configPath)];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    const raw = YAML.parse(await readFile(p, "utf8"));
    const loose = parseConfigLoose(raw);
    const extendsEntries = (loose.extends as string[] | undefined) ?? [];
    if (extendsEntries.length === 0) {
      try {
        return { config: parseConfig(raw), path: p };
      } catch (e) {
        if (e instanceof ZodError) throw new Error(formatZodError(e, p));
        throw e;
      }
    }
    // Templates resolve in order; this file overlays on top (child wins).
    const ctx = templateContextFor(p, process.env as any);
    const { merged, sources } = await resolveExtends(extendsEntries, ctx);
    const { extends: _ignored, ...top } = loose;
    let config: OpenReviewConfig;
    try {
      config = parseConfig(mergeConfigs(merged, top) as unknown);
    } catch (e) {
      if (e instanceof ZodError) throw new Error(formatZodError(e, p));
      throw e;
    }
    logInfo(
      `Resolved ${sources.length} template(s): ${sources
        .map((s) => (s.sha ? `${s.source} @${s.sha.slice(0, 7)}` : s.source))
        .join(", ")}`
    );
    return { config, path: p };
  }
  throw new Error(
    `No config found. Tried: ${candidates.join(", ")}. Add .github/openreview.yml (see openreview.example.yml).`
  );
}

/** How a review should run on this push (issue #18). Pure so the
 * orchestration branches (carry / fallback / incremental) are unit-tested;
 * run() only executes the decision. */
export type IncrementalMode =
  | { kind: "full"; reason: string }
  | { kind: "incremental"; baseShort: string }
  | { kind: "carry"; reason: "no-new-commits" | "no-new-in-scope-changes" };

export function decideIncremental(opts: {
  incremental: boolean;
  isSynchronize: boolean;
  prior: { sha: string; truncated: boolean } | null;
  headSha: string;
  incDiffOk: boolean;
  incScopedEmpty: boolean;
}): IncrementalMode {
  if (!opts.incremental) return { kind: "full", reason: "review not opted in" };
  if (!opts.isSynchronize) return { kind: "full", reason: "manual review always runs full" };
  if (!opts.prior) return { kind: "full", reason: "no prior run state" };
  if (opts.prior.truncated) return { kind: "full", reason: "prior state truncated" };
  if (opts.prior.sha === opts.headSha) return { kind: "carry", reason: "no-new-commits" };
  if (!opts.incDiffOk) return { kind: "full", reason: "incremental diff unavailable" };
  if (opts.incScopedEmpty) return { kind: "carry", reason: "no-new-in-scope-changes" };
  return { kind: "incremental", baseShort: opts.prior.sha.slice(0, 7) };
}

/** Cap for paginated file listing (issue #50). GitHub renders at most one page
 * of 100 files per listFiles call; a 150-file PR used to silently review only
 * the first 100. We paginate everything and review up to this many, reporting
 * the rest — an invisible skip is worse than a visible one. */
export const MAX_DIFF_FILES = 300;

export type PrDiff = {
  fileNames: string[];
  diff: string;
  headSha: string;
  /** Files with no renderable patch (binary or too large to render). */
  omitted: string[];
  /** True when the PR touched more than MAX_DIFF_FILES files. */
  truncated: boolean;
  /** Total files touched by the PR, before the MAX_DIFF_FILES cap. */
  totalFiles: number;
  /** True when the head moved mid-fetch (file list may mix two heads). */
  stale: boolean;
};

export async function getPrDiff(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  pr: number,
  payloadHeadSha?: string
): Promise<PrDiff> {
  // Baseline head BEFORE listing: the payload's when available, else one
  // pulls.get up front. The issue_comment path carries no payload sha, so
  // without this its mid-pagination pushes are undetectable (dogfood on #78).
  const baseline =
    payloadHeadSha ??
    (await octokit.rest.pulls.get({ owner, repo, pull_number: pr })).data.head.sha;
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner, repo, pull_number: pr, per_page: 100,
  });
  const truncated = files.length > MAX_DIFF_FILES;
  const capped = files.slice(0, MAX_DIFF_FILES);
  const parts: string[] = [];
  const names: string[] = [];
  const omitted: string[] = [];
  for (const f of capped) {
    names.push(f.filename);
    if (f.patch) parts.push(`--- a/${f.filename}\n+++ b/${f.filename}\n${f.patch}`);
    else omitted.push(f.filename);
  }
  if (truncated)
    logWarning(
      `Diff truncated: PR touches ${files.length} files, reviewing the first ${MAX_DIFF_FILES}.`
    );
  if (omitted.length > 0)
    logWarning(
      `${omitted.length} file(s) have no renderable patch (binary or too large) and were not sent to reviewers: ${omitted.slice(0, 10).join(", ")}${omitted.length > 10 ? ", …" : ""}`
    );
  // Revalidate the head AFTER listing (issue #71): a `synchronize` push
  // landing mid-pagination leaves the file list and the baseline sha from
  // different heads. pulls.get calls are worth it — on mismatch this run
  // aborts: the newer push always triggers a fresh review, so shipping a
  // possibly-mixed analysis is pure downside. Fail-closed per #46: error
  // outputs, nothing published, never a pass.
  const { data: pull } = await octokit.rest.pulls.get({ owner, repo, pull_number: pr });
  const freshSha = pull.head.sha;
  const stale = baseline !== freshSha;
  if (stale)
    logWarning(
      `PR head moved during diff fetch (${baseline.slice(0, 7)} -> ${freshSha.slice(0, 7)}); ` +
        `file list may mix both heads, inline positions revalidated before posting.`
    );
  return { fileNames: names, diff: parts.join("\n\n"), headSha: freshSha, omitted, truncated, totalFiles: files.length, stale };
}

/**
 * Incremental diff for issue #18: what changed between the last-reviewed
 * SHA and the current head, via the compare API (one call, no pagination
 * race). Falls back to the full PR diff on any failure — a force-push that
 * rewrote history 404s the base, in which case re-reviewing everything is
 * the only honest option. Same shape and accounting as getPrDiff so the
 * review loop treats both uniformly.
 */
export async function getIncrementalDiff(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  pr: number,
  base: string,
  head: string
): Promise<PrDiff> {
  const { data } = await octokit.rest.repos.compareCommits({
    owner,
    repo,
    base,
    head,
  });
  const files = data.files ?? [];
  const truncated = files.length > MAX_DIFF_FILES;
  const capped = files.slice(0, MAX_DIFF_FILES);
  const parts: string[] = [];
  const names: string[] = [];
  const omitted: string[] = [];
  for (const f of capped) {
    names.push(f.filename);
    if (f.patch) parts.push(`--- a/${f.filename}\n+++ b/${f.filename}\n${f.patch}`);
    else omitted.push(f.filename);
  }
  if (truncated)
    logWarning(
      `Incremental diff truncated: ${files.length} files changed since ${base.slice(0, 7)}, reviewing the first ${MAX_DIFF_FILES}.`
    );
  if (omitted.length > 0)
    logWarning(
      `${omitted.length} file(s) have no renderable patch (binary or too large) and were not sent to reviewers: ${omitted.slice(0, 10).join(", ")}${omitted.length > 10 ? ", …" : ""}`
    );
  // Same mid-fetch guard as the full diff (issue #71): a push landing
  // during the compare leaves base...head stale. Fail closed, the new push
  // re-runs and aborts are never read as a pass (issue #46).
  const { data: pull } = await octokit.rest.pulls.get({ owner, repo, pull_number: pr });
  const freshSha = pull.head.sha;
  const stale = head !== freshSha;
  if (stale)
    logWarning(
      `PR head moved during incremental diff fetch (${head.slice(0, 7)} -> ${freshSha.slice(0, 7)}); aborting - a fresh review runs on the new head.`
    );
  return { fileNames: names, diff: parts.join("\n\n"), headSha: freshSha, omitted, truncated, totalFiles: files.length, stale };
}

/** Sticky note for an agent that moved down its fallback chain (issue #101):
 * `a → b (why a failed)`. Undefined when the first model answered alone. */
export function describeFallback(legs: ModelLeg[] | undefined): string | undefined {
  if (!legs || legs.length < 2) return undefined;
  const why = legs[0].error ? ` (${firstLine(legs[0].error).slice(0, 80)})` : "";
  return `${legs.map((l) => l.model).join(" → ")}${why}`;
}

function firstLine(s: string): string {
  // Provider bodies are JSON; prefer the human message inside when present.
  const m = /"message"\s*:\s*"([^"]{1,200})"/.exec(s);
  return (m ? m[1] : s).split("\n")[0];
}

/** One agent's accounted spend: totals across all its attempts (issue #52). */
export type AgentSpend = {
  agent: string;
  model: string;
  /** Null when the provider omitted usage: unknown spend, never zero. */
  usage: { in: number; out: number } | null;
  seconds: number;
  attempts: number;
  startedAt: number;
  endedAt: number;
};

/**
 * Footer lines for the sticky (issue #52). Models line groups true spend by
 * model with wall-clock throughput; agents line shows each agent's own spend
 * so retried and failed attempts stay visible instead of vanishing.
 * Unknown usage (provider omitted it) renders as ?/?, never 0/0.
 */
export function summarizeUsage(records: AgentSpend[]): { modelsLine: string; agentsLine: string } {
  const byModel = new Map<string, { In: number; Out: number; known: boolean; unknown: boolean; start: number; end: number }>();
  for (const u of records) {
    const e = byModel.get(u.model) ?? { In: 0, Out: 0, known: false, unknown: false, start: u.startedAt, end: u.endedAt };
    if (u.usage) {
      e.In += u.usage.in;
      e.Out += u.usage.out;
      e.known = true;
    } else {
      e.unknown = true;
    }
    e.start = Math.min(e.start, u.startedAt);
    e.end = Math.max(e.end, u.endedAt);
    byModel.set(u.model, e);
  }
  const modelsLine = [...byModel.entries()]
    .map(([m, e]) => {
      if (!e.known) return `${m} ?/?`;
      // A "+" marks a partial sum: some agents on this model omitted usage,
      // so the total covers only the known records (dogfood on #72). The
      // agents line names the ?/? agents.
      const partial = e.unknown ? "+" : "";
      // No pace badge on sub-second windows: a 1ms floor turns any output
      // into an absurd rate (dogfood on #72). Fast runs just show totals.
      const elapsed = (e.end - e.start) / 1000;
      return (
        `${m} ${formatTokens(e.In)}/${formatTokens(e.Out)}${partial}` +
        (e.Out > 0 && elapsed >= 1 ? ` ${(e.Out / elapsed).toFixed(0)}t/s` : "")
      );
    })
    .join(" · ");
  const agentsLine = records
    .map((u) => {
      const spend = u.usage ? `${formatTokens(u.usage.in)}/${formatTokens(u.usage.out)}` : "?/?";
      const pace = u.usage && u.usage.out > 0 && u.seconds > 0 ? ` · ${(u.usage.out / u.seconds).toFixed(0)}t/s` : "";
      const tries = u.attempts === 1 ? "1 attempt" : `${u.attempts} attempts`;
      return `${u.agent} ${spend}${pace} · ${u.seconds.toFixed(0)}s · ${tries}`;
    })
    .join("; ");
  return { modelsLine, agentsLine };
}

/** Findings eligible for inline comments: only reviews that did not opt out
 * via verdict.post_inline (issue #53). Pure helper, unit-tested. */
export function selectInlineFindings(
  reviews: { postInline: boolean; findings: Finding[] }[]
): Finding[] {
  return reviews.filter((r) => r.postInline).flatMap((r) => r.findings);
}

/**
 * Run one review's agents according to `main_mode`.
 * - synthesize: subagents in a bounded pool, then `main` over their findings;
 *   its merge/dismiss decisions apply via mergeSynthesis. A main that returns
 *   no usable synthesis (failed, unparseable, budget gone) falls back to the
 *   plain union of subagent findings — a bad synthesizer never erases them.
 * - parallel (or no runnable main): every agent in one pool, findings unioned.
 * `results` always lists main first, then subagents, matching declaration order.
 */
export async function runReviewAgents<R extends { findings: Finding[]; synthesis?: Synthesis }>(opts: {
  main: ((priorFindings?: string) => Promise<R>) | null;
  subs: (() => Promise<R>)[];
  synthesize: boolean;
  maxConcurrency: number;
}): Promise<{
  results: R[];
  findings: Finding[];
  dismissed: { finding: Finding; reason: string }[];
  synthesis?: Synthesis;
  /** Subagent findings handed to the synthesizer (0 in parallel mode). */
  reported: number;
}> {
  const { main, subs, synthesize, maxConcurrency } = opts;
  if (!synthesize || !main) {
    const results = await runPooled(main ? [() => main(), ...subs] : subs, maxConcurrency);
    return { results, findings: results.flatMap((r) => r.findings), dismissed: [], reported: 0 };
  }
  const subResults = await runPooled(subs, maxConcurrency);
  const labeled = labelFindings(subResults.flatMap((r) => r.findings));
  const mainResult = await main(renderPriorFindings(labeled));
  const results = [mainResult, ...subResults];
  if (!mainResult.synthesis) {
    return { results, findings: subResults.flatMap((r) => r.findings), dismissed: [], reported: labeled.length };
  }
  const merged = mergeSynthesis(labeled, mainResult.findings, mainResult.synthesis);
  return { results, ...merged, synthesis: mainResult.synthesis, reported: labeled.length };
}

/** Run thunks with at most `limit` in flight, preserving result order.
 * Takes thunks, NOT promises: an already-started promise is in flight before
 * the pool can see it, so passing promises caps nothing. */
export async function runPooled<T>(thunks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  if (thunks.length === 0) return [];
  const cap = Math.max(1, Math.min(limit, thunks.length));
  const out: T[] = new Array(thunks.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= thunks.length) return;
      out[i] = await thunks[i]();
    }
  };
  await Promise.all(Array.from({ length: cap }, worker));
  return out;
}

type AskFlowOpts = {
  octokit: ReturnType<typeof github.getOctokit>;
  owner: string;
  repo: string;
  prNumber: number;
  config: ReturnType<typeof parseConfig>;
  keys: ReturnType<typeof resolveKeysFromEnv>;
  question: string;
  quoted: string;
  sessionId: string;
  deadlineAt: number;
  dryRun: boolean;
};

/**
 * In-thread Q&A (issue #23): answer `/ask` from the PR diff plus the
 * recorded prior findings, then log the sticky's reaction signal (the
 * learning half of issue #43; read-only, never changes behavior).
 */
async function runAskFlow(opts: AskFlowOpts): Promise<void> {
  const { octokit, owner, repo, prNumber, config, keys } = opts;
  const { fileNames, diff, stale } = await getPrDiff(
    octokit, owner, repo, prNumber, (github.context.payload as any).pull_request?.head?.sha
  );
  if (stale) {
    logWarning("Ask: PR head moved during diff fetch; answering from the fetched (slightly old) diff.");
  }
  if (!diff.trim() || fileNames.length === 0) {
    logWarning("Ask: empty diff, nothing to answer from.");
    return;
  }
  // Prior findings ground follow-ups ("what about the P1?") without
  // re-running any agent. Absent state just means a thinner prompt.
  let prior: { file: string; line?: number; comment: string }[] = [];
  try {
    const sticky = await findStickyComment(octokit, owner, repo, prNumber);
    const state = sticky?.body ? parseStickyState(sticky.body) : null;
    if (state) prior = state.reviews.flatMap((r) => r.findings);
  } catch {
    logWarning("Ask: prior run state unreadable; answering from the diff alone.");
  }
  const mainDef = config.reviews[0]?.main;
  const resolved = resolveAskProvider(config);
  if (!resolved.ok || !mainDef) {
    logWarning(`Ask: cannot pick an answering provider (${!mainDef ? "no reviews configured" : (resolved as { reason: string }).reason}).`);
    return;
  }
  const { provider } = resolved;
  const providerName = mainDef.provider;
  const { system, user } = buildAskPrompt({
    diff: diff.slice(0, config.defaults.max_diff_chars ?? 80000),
    priorFindings: prior,
    quoted: opts.quoted,
    question: opts.question,
  });
  let answer: string;
  let modelLine = "";
  try {
    const r = await runTextAgent({
      agentName: "ask",
      providerName,
      provider,
      system,
      user,
      keys,
      sessionId: opts.sessionId,
      deadlineAt: opts.deadlineAt,
    });
    answer = r.text;
    modelLine = `${provider.model}${r.usage ? ` · ${formatTokens(r.usage.in)}/${formatTokens(r.usage.out)} in/out` : ""}`;
  } catch (e) {
    logWarning(`Ask: answering failed (${e instanceof Error ? e.message : String(e)}).`);
    answer = "";
  }
  if (opts.dryRun) {
    logInfo(`DRY RUN ask answer (model ${provider.model}):\n${(answer || "(no answer)").slice(0, 2000)}`);
    return;
  }
  // The answer carries its own marker so reaction collection (which scans
  // bot comments by `<!-- openreview:` prefix) includes answers. It is NOT
  // the sticky marker, so sticky lookup (first-line match) never selects it.
  const body = answer
    ? `<!-- openreview:answer -->\n**OpenReview answer** (to \`${opts.question.slice(0, 120)}\`)\n\n${answer}\n\n<sub>Answered with \`${modelLine || provider.model}\` · react on this comment to teach future reviews · ask again with \`/ask\`</sub>`
    : `<!-- openreview:answer -->\nOpenReview could not answer that (model ${provider.model} returned nothing usable). Try rephrasing, or run a fresh review with \`/review\`.`;
  await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body });
  logInfo(`Ask: answered question (${opts.question.slice(0, 80)}).`);
  const signals = await collectFeedbackSignals(octokit, owner, repo, prNumber);
  logInfo(`Feedback signals: ${JSON.stringify(signals.totals)} across ${signals.comments.length} bot comment(s).`);
}


export async function run(): Promise<void> {
  try {
    initLogger();
    const token = process.env["INPUT_GITHUB-TOKEN"] || process.env.GITHUB_TOKEN || "";
    if (!token) throw new Error("Missing github-token (GITHUB_TOKEN).");
    const octokit = github.getOctokit(token);
    const ctx = github.context;
    const issue = (ctx.payload as any).issue;
    const prNumber =
      ctx.payload.pull_request?.number ??
      (issue?.pull_request ? issue.number : undefined) ??
      Number(process.env.PR_NUMBER ?? 0);
    if (!prNumber) {
      logWarning("No pull_request context; nothing to review. (Supports pull_request + issue_comment /review)");
      return;
    }
    const { owner, repo } = ctx.repo;
    const configPath = core.getInput("config-path") || ".github/openreview.yml";
    const dryRun = (core.getInput("dry-run") || "false").toLowerCase() === "true";

    const { config, path } = await loadConfig(configPath, core.getInput("config-path") !== "");
    logInfo(`Loaded config: ${path} (${config.reviews.length} reviews)`);
    // Fail fast on dotted provider refs that resolve to nothing (issue #67):
    // a typo'd `opencode.flah` errors here naming both halves, before any
    // budget is spent. Legacy plain-unknown names keep warn-and-skip per agent.
    assertProviderRefs(config);
    if (config.requires_action) {
      // Prefer the action's own package.json (issue #58c): the workflow
      // usually pins a floating ref (@v1) that GITHUB_ACTION_REF cannot
      // resolve, which used to skip the check.
      const running =
        runningActionVersion(process.env as any) ??
        builtActionVersion({ actionPath: process.env.GITHUB_ACTION_PATH, distDir: import.meta.dirname });
      if (running && !satisfiesActionVersion(config.requires_action, running)) {
        throw new Error(
          `This openreview.yml needs action ${config.requires_action} but the runner is ${running}. ` +
            `Bump the workflow ref (e.g. uses: sankara-sabapathy/openreview@v1) to a release satisfying the constraint.`
        );
      }
    }
    const keys = resolveKeysFromEnv(process.env as any);
    // In-thread Q&A (issue #23): `/ask <question>` on a PR is answered from
    // the diff, before the review gate below (which would reject any body
    // that is not exactly the review command). Same write-access rule as
    // /review: BASE-repo secrets are live here too (issue #59).
    const askParsed =
      (ctx.payload as any).issue?.pull_request != null
        ? parseAskComment((ctx.payload as any).comment?.body)
        : null;
    if (askParsed) {
      if (
        !isAskAllowed(
          (ctx.payload as any).comment?.author_association,
          core.getInput("allowed-author-associations")
        )
      ) {
        logWarning(
          `Ask denied: sender association '${(ctx.payload as any).comment?.author_association ?? "NONE"}' may not spend provider budget. Nothing was answered or posted.`
        );
        return;
      }
      const askDeadline = Date.now() + (config.defaults.max_runtime_s ?? 1200) * 1000;
      await runAskFlow({
        octokit,
        owner,
        repo,
        prNumber,
        config,
        keys,
        question: askParsed.question,
        quoted: askParsed.quoted,
        sessionId: process.env.GITHUB_RUN_ID ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        deadlineAt: askDeadline,
        dryRun,
      });
      return;
    }
    // Authorization gate (issue #59): `issue_comment` runs in the BASE repo
    // context, so the secrets are live. Without this, anyone on the internet
    // could comment the command on any PR and spend the maintainer's keys.
    // Runs before the diff fetch, the key resolution and every agent call.
    const gate = authorizeTrigger({
      eventName: process.env.GITHUB_EVENT_NAME ?? "",
      commentBody: (ctx.payload as any).comment?.body,
      authorAssociation: (ctx.payload as any).comment?.author_association,
      command: config.defaults.command,
      allowedAssociations: core.getInput("allowed-author-associations"),
    });
    if (!gate.allowed) {
      // Exit 0: an unauthorized trigger must not paint a red X on a PR.
      logWarning(`Trigger denied: ${gate.reason}. Nothing was reviewed or posted.`);
      return;
    }
    // Run-wide wall-clock budget (issue #51). Every agent call clamps its own
    // timeout to what is left, and `runAgent` refuses to start once it is gone.
    const maxRuntimeS = config.defaults.max_runtime_s ?? 1200;
    const maxConcurrency = config.defaults.max_concurrency ?? 4;
    const deadlineAt = Date.now() + maxRuntimeS * 1000;
    logInfo(
      `Run budget: ${maxRuntimeS}s total, ${maxConcurrency} agent(s) in flight per review` +
        (config.reviews.length > 1
          ? `; projected worst case ~${Math.ceil(
              (config.reviews.length *
                config.reviews.reduce((n, r) => n + 1 + r.subagents.length, 0) *
                ((config.reviews[0].main ? 3 : 0) + 1)) /
                60
            )} min without the budget kicking in`
          : "")
    );
    // Stable session per workflow run (required by OpenCode Go/Zen routing).
    const sessionId =
      process.env.GITHUB_RUN_ID ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    logInfo(`Reviewing PR #${prNumber} in ${owner}/${repo}`);
    const { fileNames, diff, headSha, omitted, truncated, totalFiles, stale } = await getPrDiff(
      octokit, owner, repo, prNumber, (ctx.payload as any).pull_request?.head?.sha
    );
    if (stale) {
      // Head moved mid-fetch: the file list may mix two pushes. Abort — the
      // newer push triggers its own run. Outputs mirror the no-review path
      // below so consumers never read this as a pass (issue #46).
      core.setOutput("verdict", "comment");
      core.setOutput("review_status", "error");
      logWarning("Head moved during diff fetch; aborting — a fresh review runs on the new head.");
      return;
    }
    logInfo(`Diff: ${fileNames.length} files, ${diff.length} chars (head ${headSha.slice(0, 7)})`);
    logDebug(`Diff files: ${fileNames.join(", ")}`);
    // Prompt-injection tripwire (issue #58a): the diff is untrusted
    // PR-author text. Flagged lines are still reviewed as code; the note
    // tells a human where to look harder.
    const injectionHits = scanPromptInjection(diff);
    let injectionNote: string | null = null;
    if (injectionHits.length > 0) {
      injectionNote =
        `${injectionHits.length} instruction-shaped line(s) in the diff ` +
        `(treating the diff as untrusted data): ${injectionHits.slice(0, 3).join(" | ")}`;
      logWarning(`Prompt-injection scan: ${injectionNote}`);
    }
    // Incremental re-review (issue #18): recover the last-reviewed SHA and
    // open findings from the sticky's machine-readable state (slice 0).
    // Only `synchronize` pushes qualify — a manual /review is an explicit
    // ask for a fresh full review. One sticky lookup per run, not per review.
    const isSynchronize = (ctx.payload as any).action === "synchronize";
    type PriorCarry = { sha: string; verdict: Verdict; truncated: boolean; findings: StickyFindingState[] };
    const priorByReview = new Map<string, PriorCarry>();
    if (isSynchronize && config.reviews.some((r) => r.incremental)) {
      try {
        const sticky = await findStickyComment(octokit, owner, repo, prNumber);
        const state = sticky?.body ? parseStickyState(sticky.body) : null;
        if (state) {
          for (const r of state.reviews) {
            priorByReview.set(r.id, {
              sha: state.sha,
              verdict: r.verdict === "approve" || r.verdict === "request_changes" ? r.verdict : "comment",
              truncated: r.truncated,
              findings: r.findings,
            });
          }
          logInfo(
            `Incremental carry: prior run at ${state.sha.slice(0, 7)} recorded ${state.reviews.length} review(s) with state.`
          );
        } else {
          logInfo("Incremental: no prior run state in sticky; reviews fall back to full diff.");
        }
      } catch (e) {
        logWarning(`Incremental: sticky lookup failed (${(e as Error).message}); falling back to full diff.`);
      }
    }
    // One incremental diff per run (all reviews share the prior run's SHA).
    // A base that no longer resolves (force-push rewrote history) 404s the
    // compare call — then re-reviewing everything is the honest fallback.
    const incBase = [...priorByReview.values()].map((p) => p.sha)[0];
    let incDiff: PrDiff | null = null;
    if (incBase && incBase !== headSha) {
      try {
        incDiff = await getIncrementalDiff(octokit, owner, repo, prNumber, incBase, headSha);
        if (incDiff.stale) {
          core.setOutput("verdict", "comment");
          core.setOutput("review_status", "error");
          logWarning("Head moved during incremental diff fetch; aborting - a fresh review runs on the new head.");
          return;
        }
        logInfo(
          `Incremental diff: ${incDiff.fileNames.length} files, ${incDiff.diff.length} chars (${incBase.slice(0, 7)}..${headSha.slice(0, 7)})`
        );
      } catch (e) {
        logWarning(`Incremental diff failed (${(e as Error).message}); falling back to full diff.`);
        incDiff = null;
      }
    }
    if (truncated)
      logWarning(`PR touches more than ${MAX_DIFF_FILES} files; only the first ${MAX_DIFF_FILES} were reviewed.`);
    if (omitted.length > 0)
      logWarning(`${omitted.length} changed file(s) skipped (binary or patch too large): ${omitted.slice(0, 10).join(", ")}${omitted.length > 10 ? ", …" : ""}`);
    const inScope = filterIgnored(fileNames, config.defaults.ignore ?? []);
    if (!diff.trim() || inScope.length === 0) {
      logInfo("Empty diff or all files ignored.");
      return;
    }
    // Parse the multi-file diff once; every review scopes from this (#47).
    const parsedDiff = splitDiff(diff);
    if (parsedDiff.length === 0)
      logWarning(`Diff parser found no per-file patches for ${fileNames.length} changed file(s).`);
    // Repo index built ONCE per run and shared by every review's context
    // builder (issue #55): the walk + candidate reads used to repeat per review.
    const repoIndex = buildRepoIndex(process.cwd(), config.defaults.ignore ?? []);

    type AgentRun = {
      agent: string;
      providerName: string;
      outcome: AgentOutcome;
      seconds: number;
      error?: string;
      /** e.g. "cat-jam-free → glm-5.3-flash (Model is unavailable)" */
      fallback?: string;
    };
    const perReview: {
      id: string;
      verdict: Verdict;
      findings: Finding[];
      /** Summary + walkthrough from the synthesizer, when it produced one. */
      synthesis?: Synthesis;
      /** Subagent findings the synthesizer dismissed, with its reasons. */
      dismissed: { finding: Finding; reason: string }[];
      errors: string[];
      /** Agents that actually reviewed (issue #46: only these may vote). */
      counted: boolean;
      /** verdict.post_inline honored per review (issue #53). */
      postInline: boolean;
      agents: AgentRun[];
      usage: AgentSpend[];
      /** Unmatched prior findings re-entering next run's state (issue #18). */
      carried?: StickyFindingState[];
      /** Pre-rendered incremental ledger lines for the sticky footer. */
      ledger?: string[];
    }[] = [];
    // Incremental parsed diff, shared by every incremental review in the run.
    const parsedInc = incDiff ? splitDiff(incDiff.diff) : [];
    const incIgnore = config.defaults.ignore ?? [];
    for (const review of config.reviews) {
      const prior = priorByReview.get(review.id) ?? null;
      const fullScoped = inScope.filter((f) => matchesAny(f, review.if_paths));
      const incFiles = incDiff ? filterIgnored(incDiff.fileNames, incIgnore) : null;
      const incScoped = incFiles ? incFiles.filter((f) => matchesAny(f, review.if_paths)) : null;
      // One decision point for all three paths (issue #18): full review,
      // incremental review of the additive diff, or carry without agents.
      const mode = decideIncremental({
        incremental: review.incremental,
        isSynchronize,
        prior: prior ? { sha: prior.sha, truncated: prior.truncated } : null,
        headSha,
        incDiffOk: incDiff !== null,
        incScopedEmpty: incScoped !== null && incScoped.length === 0,
      });
      if (mode.kind === "carry") {
        // No new commits, or no new in-scope changes: carry the previous
        // verdict forward without spending provider budget. Fixes cannot
        // have landed where nothing changed, so priors stay open by
        // construction, never silently dropped. Carry implies prior state
        // by decideIncremental's construction.
        const p = prior!;
        const why =
          mode.reason === "no-new-commits"
            ? "no new commits since the last review"
            : "no new in-scope changes";
        logInfo(`Review ${review.id}: incremental carry (${why}); ${p.findings.length} prior finding(s) stand.`);
        perReview.push({
          id: review.id,
          verdict: p.verdict,
          findings: [],
          dismissed: [],
          errors: [],
          counted: true,
          postInline: review.verdict.post_inline !== false,
          agents: [],
          usage: [],
          carried: p.findings,
          ledger: [
            `\n> 🔁 Incremental since \`${p.sha.slice(0, 7)}\`: ${why}; ` +
              `${p.findings.length} prior finding(s) carried, verdict stands at ${p.verdict}.`,
          ],
        });
        continue;
      }
      const incActive = mode.kind === "incremental";
      const baseFiles = incActive ? incFiles! : inScope;
      const scopedFiles = incActive ? incScoped! : fullScoped;
      if (scopedFiles.length === 0) {
        logInfo(`Review ${review.id}: no matching paths, skipped.`);
        continue;
      }
      // Scoped diff (issue #47). `if_paths` used to decide only *whether* a
      // review ran — agents always got the whole PR diff, so a src/-only review
      // still paid for (and could comment on) website/ and dist/. Parsed once per
      // run, reused by every review and agent. Incremental reviews scope the
      // additive diff instead (issue #18).
      const useParsed = incActive ? parsedInc : parsedDiff;
      const scopedDiff = scopeDiff(scopedFiles, useParsed, baseFiles.length);
      logDebug(
        `Review ${review.id}: ${scopedFiles.length}/${baseFiles.length} in-scope file(s) sent ` +
          `(${scopedDiff.length} chars)`
      );
      // Cross-file context (issue #20): full files + call-site excerpts, budgeted.
      const { block: contextBlock } = buildContextBlock({
        repoRoot: process.cwd(),
        scopedFiles,
        contextFiles: review.context_files,
        includeFullFiles:
          review.include_full_files ?? config.defaults.include_full_files ?? true,
        maxContextChars:
          review.max_context_chars ?? config.defaults.max_context_chars ?? 20000,
        ignore: config.defaults.ignore ?? [],
      }, repoIndex);
      type TaskResult = {
        findings: Finding[];
        usage: { in: number; out: number } | null;
        seconds: number;
        attempts: number;
        startedAt: number;
        endedAt: number;
        error?: string;
        outcome: AgentOutcome;
        agent: string;
        providerName: string;
        model: string;
        synthesis?: Synthesis;
        /** Models tried along the fallback chain (issue #101), in order. */
        legs?: ModelLeg[];
      };
      // Prior-round carry for incremental reviews (issue #18). Rendered once
      // per review; subagents validate each entry, the synthesizer inherits
      // through its cited sources (see mergeSynthesis).
      const priorRender =
        incActive && prior && prior.findings.length > 0 ? renderPriorReview(prior.findings) : null;
      const priorReview = priorRender
        ? {
            baseShort: prior!.sha.slice(0, 7),
            headShort: headSha.slice(0, 7),
            block: priorRender.block,
          }
        : undefined;
      const mainDef = { ...review.main, name: review.main.name ?? `${review.id}:main` };
      const subDefs = review.subagents.map((s, i) => ({ ...s, name: s.name ?? `${review.id}:sub${i}` }));
      const synthesize = review.main_mode !== "parallel";
      logInfo(
        `Review ${review.id}: launching ${1 + subDefs.length} agent(s) [${[mainDef, ...subDefs]
          .map((a) => `${a.name}/${a.provider}`)
          .join(", ")}] on ${scopedFiles.length} file(s), strategy=${review.strategy}, ` +
          `main_mode=${synthesize ? "synthesize" : "parallel"}` +
          (priorReview ? `, incremental carry (${priorRender!.shown}/${priorRender!.total} prior findings)` : "")
      );
      // Thunks, not promises: runAgent must not start until the pool allows it
      // (an eager promise is already in flight, so the cap would be a no-op).
      // The optional argument is the synthesizer's <prior_findings> block,
      // known only once the subagents have finished.
      const makeTask = (
        a: { name: string; provider: string; instructions: string },
        isMain: boolean
      ): ((priorFindings?: string) => Promise<TaskResult>) | null => {
        let provider = config.providers[a.provider];
        if (!provider) {
          if (a.provider.includes(".")) {
            // Validated at load; throws naming both halves as a backstop.
            provider = resolveDottedProvider(config.providers, a.provider).config;
          } else {
            logWarning(`Review ${review.id}: unknown provider '${a.provider}', skipped agent ${a.name}.`);
            return null;
          }
        }
        const p = provider;
        return (priorFindings?: string) =>
          runAgentWithFallback({
            agentName: a.name,
            providerName: a.provider,
            provider: p,
            instructions: a.instructions,
            diff: scopedDiff,
            lang: config.defaults.lang ?? "en",
            keys,
            maxDiffChars: config.defaults.max_diff_chars ?? 80000,
            sessionId,
            contextBlock,
            deadlineAt,
            priorFindings,
            // Validation duty sits with the subagents; the synthesizer
            // inherits each finding's status through its cited sources.
            priorReview: !isMain ? priorReview : undefined,
            suggestFixes: review.suggest_fixes ?? true,
          })
            .then((result): TaskResult => ({
              findings: result.findings,
              usage: result.usage,
              seconds: result.seconds,
              attempts: result.attempts,
              startedAt: result.startedAt,
              endedAt: result.endedAt,
              outcome: result.outcome,
              agent: a.name,
              providerName: a.provider,
              model: result.model,
              synthesis: result.synthesis,
              legs: result.legs,
            }))
            .catch((e): TaskResult => {
              const msg = (e as Error).message;
              logWarning(`Agent ${a.name} failed: ${msg}`);
              // A failed agent still spent tokens on its attempts (issue #52):
              // AgentFailedError carries the totals so the footer can account
              // for them instead of the agent vanishing as "no usage".
              // usageTotal stays null when nothing reported usage — unknown,
              // never zero — so the footer renders ?/? (dogfood on #72).
              const failed = e instanceof AgentFailedError ? e : null;
              const now = Date.now();
              return {
                findings: [] as Finding[],
                usage: failed?.usageTotal ? { ...failed.usageTotal } : null,
                seconds: failed?.seconds ?? 0,
                attempts: failed?.attempts ?? 1,
                startedAt: failed?.startedAt ?? now,
                endedAt: failed?.endedAt ?? now,
                error: msg,
                outcome: "error" as const,
                agent: a.name,
                providerName: a.provider,
                model: p.model,
                legs: e instanceof ChainFailedError ? e.legs : undefined,
              };
            });
      };
      const subTasks = subDefs
        .map((a) => makeTask(a, false))
        .filter((t): t is (p?: string) => Promise<TaskResult> => t !== null)
        .map((t) => () => t());
      const mainTask = makeTask(mainDef, true);
      // Bounded fan-out (issue #51): run at most `max_concurrency` agents at a
      // time instead of bursting every agent at the provider at once. The
      // thunk is what makes the cap real — see runPooled.
      const { results, findings: merged, dismissed, synthesis, reported } = await runReviewAgents({
        main: mainTask,
        subs: subTasks,
        synthesize,
        maxConcurrency,
      });
      let findings = merged;
      if (synthesis) {
        logInfo(
          `Review ${review.id}: synthesizer kept ${findings.length} finding(s) from ${reported} reported, ` +
            `dismissed ${dismissed.length}.`
        );
      } else if (synthesize && mainTask && reported > 0) {
        logWarning(
          `Review ${review.id}: synthesizer produced no usable result; keeping all ${reported} subagent finding(s).`
        );
      }
      const agentErrors = results
        .filter((r) => r.error)
        // Sanitized for the sticky (issue #58f): provider error bodies may
        // echo request material. Full text stays in the Actions log above.
        .map((r) => `- \`${r.agent}\`: ${sanitizeErrorDetail(r.error!)}`);
      if (review.verdict.deduplicate) findings = dedupeFindings(findings);
      // Grounding (issue #56): a finding on a file this review never saw is
      // model drift, not signal — it neither shows nor votes. Dropped files
      // are named in the logs, never silently lost.
      const fileCheck = validateFindingFiles(findings, scopedFiles);
      if (fileCheck.dropped.length > 0) {
        logWarning(
          `Review ${review.id}: dropped ${fileCheck.dropped.length} finding(s) on files outside the review scope: ` +
            fileCheck.dropped.slice(0, 3).map((f) => `\`${f.file}\``).join(", ") +
            (fileCheck.dropped.length > 3 ? ", ..." : "")
        );
        findings = fileCheck.visible;
      }
      // Decided items: rebutted patterns suppressed before verdict math —
      // they neither show nor vote. Per-review wins over defaults.suppress.
      const suppress = review.suppress ?? config.defaults.suppress ?? [];
      if (suppress.length > 0) {
        const preSuppress = findings.length;
        findings = applySuppression(findings, suppress).visible;
        if (findings.length < preSuppress) {
          logInfo(
            `Review ${review.id}: suppression dropped ${preSuppress - findings.length} decided finding(s) ` +
              `(${suppress.length} pattern(s))`
          );
        }
      }
      // Consensus escalation (issue #56c, opt-in): findings confirmed by
      // >=2 independent agents escalate one severity before verdict math.
      if (review.verdict.consensus_escalation) {
        const esc = escalateConsensus(findings);
        if (esc.escalated > 0) {
          logInfo(`Review ${review.id}: consensus escalation raised ${esc.escalated} finding(s) one severity.`);
        }
        findings = esc.findings;
      }
      // Noise controls (issue #21): confidence floor + cap, then verdict on survivors.
      const noise = resolveNoise({
        profile: review.profile ?? config.defaults.profile,
        min_confidence: review.min_confidence ?? config.defaults.min_confidence,
        max_findings: review.max_findings ?? config.defaults.max_findings,
      });
      const preNoise = findings.length;
      findings = applyNoiseControls(findings, noise).visible;
      if (findings.length < preNoise) {
        logInfo(
          `Review ${review.id}: noise controls dropped ${preNoise - findings.length} finding(s) ` +
            `(profile=${review.profile ?? config.defaults.profile}, min_confidence=${noise.min_confidence}, max_findings=${noise.max_findings})`
        );
      }
      // Incremental validation (issue #18): link this round's findings back
      // to the carried priors. Fixed findings neither show nor vote;
      // still-open and new findings vote as usual. Unmatched priors stay
      // open (fail-safe) and re-enter next run's state; if any exist the
      // review cannot report a clean approve.
      let carried: StickyFindingState[] = [];
      let ledger: string[] | undefined;
      let incFloor = false;
      if (incActive && prior && priorRender && priorRender.total > 0) {
        const m = matchCarriedFindings(prior.findings, findings);
        const voteSet = [...m.confirmed, ...m.fresh];
        const unverified = m.unverified;
        carried = unverified;
        findings = voteSet;
        const baseShort = prior.sha.slice(0, 7);
        const openCount = m.open.length;
        ledger = [
          `\n> 🔁 Incremental since \`${baseShort}\`: ${m.fixed.length} fixed, ` +
            `${openCount} still open${unverified.length > 0 ? ` (${unverified.length} carried unverified)` : ""}, ${m.fresh.length} new.`,
        ];
        if (m.fixed.length > 0) {
          ledger.push(
            `<details><summary>Fixed since ${baseShort} (${m.fixed.length})</summary>\n\n` +
              m.fixed
                .map((f) => `- \`${f.file}${f.line !== undefined ? `:${f.line}` : ""}\` — ${f.comment.replace(/\s+/g, " ").slice(0, 120)}`)
                .join("\n") +
              `\n\n</details>`
          );
        }
        logInfo(
          `Review ${review.id}: incremental match — ${m.fixed.length} fixed, ${openCount} still open, ${m.fresh.length} new, ${unverified.length} unverified.`
        );
        if (unverified.length > 0) {
          // Unvalidated carry means no clean approve: the next run (or a
          // human) still has to look. Applied after the verdict math below.
          incFloor = true;
        }
      }
      findings.sort((a, b) =>
        ({ high: 0, medium: 1, suggestion: 2 } as const)[a.severity] -
        ({ high: 0, medium: 1, suggestion: 2 } as const)[b.severity]
      );
      // Fail closed (issue #46): a review whose every agent was skipped or
      // errored contributed NO usable signal, so it must not cast an approving
      // ballot — "no findings because nothing ran" is not "no findings found".
      const counted = results.filter((r) => countsAsReview(r.outcome)).length;
      // A partially-failed review DID get a look, but not the whole picture, so
      // it may not report a clean pass either: floor it at `comment` rather
      // than dropping its findings or claiming everything was checked.
      const degraded = counted > 0 && counted < results.length;
      let verdict = (() => {
        if (counted === 0) return "approve" as Verdict; // placeholder, excluded below
        // One ballot per agent (issue #56a). `any` reproduces the old pooled
        // behavior exactly (max of maxes); `all`/`majority` now resolve real
        // multi-agent disagreement instead of degenerating to a single voter
        // when every agent shares one provider (issue #12's per-provider
        // ballots did that). A merged finding votes in each contributing
        // agent's ballot.
        const byAgent = groupByAgent(findings);
        const ballots = [...byAgent.entries()].map(([name, fs]) => {
          const v = decideReviewVerdict(review.verdict.mode, review.verdict.min_severity, fs);
          logInfo(`Review ${review.id}: ballot ${name} -> ${v} (${fs.length} findings)`);
          return v;
        });
        const base = combineBallots(ballots, review.strategy);
        if (degraded) {
          logWarning(
            `Review ${review.id}: only ${counted}/${results.length} agents reviewed — ` +
              `flooring the verdict instead of reporting a clean approve.`
          );
        }
        return applyDegradedFloor(base, counted, results.length);
      })();
      if (incFloor && verdict === "approve") {
        verdict = "comment";
        logWarning(
          `Review ${review.id}: ${carried.length} prior finding(s) carried unverified - flooring to comment instead of a clean approve.`
        );
      }
      perReview.push({
        id: review.id,
        verdict,
        findings,
        synthesis,
        dismissed,
        errors: agentErrors,
        counted: counted > 0,
        // verdict.post_inline finally honored (issue #53): a review that opts
        // out contributes no inline comments, only sticky rows.
        postInline: review.verdict.post_inline !== false,
        agents: results.map((r) => ({
          agent: r.agent,
          providerName: r.providerName,
          outcome: r.outcome,
          seconds: r.seconds,
          fallback: describeFallback(r.legs),
        })),
        usage: results
          // Every agent that started an attempt is accounted for (issue #52):
          // failed agents carry their spend on the error, so only agents that
          // never started (no key, no budget left) are absent — and those are
          // named separately in the skipped-key warning below.
          .filter((r) => r.attempts > 0)
          .flatMap((r) =>
            // A fallback chain spent on every model it tried (issue #101):
            // one record per leg so the Models footer names each of them.
            r.legs && r.legs.length > 1
              ? r.legs
                  .filter((l) => l.attempts > 0)
                  .map((l) => ({
                    agent: r.agent,
                    model: l.model,
                    usage: l.usage,
                    seconds: l.seconds,
                    attempts: l.attempts,
                    startedAt: l.startedAt,
                    endedAt: l.endedAt,
                  }))
              : [{
                  agent: r.agent,
                  // Resolved model travels with the result: dotted refs
                  // (`opencode.flash`) have no top-level entry to look up (issue #67).
                  model: r.model,
                  usage: r.usage,
                  seconds: r.seconds,
                  attempts: r.attempts,
                  startedAt: r.startedAt,
                  endedAt: r.endedAt,
                }]
          ),
        carried: carried.length > 0 ? carried : undefined,
        ledger,
      });
      if (counted === 0) {
        logWarning(
          `Review ${review.id}: ${results.length} agent(s), none reviewed (no usable result) — ` +
            `excluded from the verdict.`
        );
      }
      logInfo(`Review ${review.id}: ${findings.length} findings -> ${verdict}${counted > 0 ? "" : " (excluded)"}`);
    }

    if (perReview.length === 0) {
      // Still publish both outputs: a consumer branching on
      // steps.review.outputs.verdict must not see an empty string here (the
      // dogfood review on #62 caught this regression).
      core.setOutput("verdict", "comment");
      core.setOutput("review_status", "error");
      logWarning(
        "No review matched any path in the diff (check if_paths / defaults.ignore) — " +
          "nothing was reviewed. review_status=error."
      );
      return;
    }

    // Only reviews that actually ran vote; a run where nothing did is reported
    // as `error` and can never come out as approve (issue #46).
    const countedReviews = perReview.filter((r) => r.counted);
    const global = combineVerdicts(
      countedReviews.map((r) => r.verdict),
      config.global_verdict.strategy
    );
    const status: RunStatus =
      countedReviews.length === 0
        ? "error"
        : countedReviews.length < perReview.length
        ? "partial"
        : "ok";
    const all = perReview.flatMap((r) => r.findings);
    core.setOutput("verdict", global);
    core.setOutput("review_status", status);

    const runUrl = `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${owner}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID ?? ""}`;
    const reviewRows = perReview.map((r) => ({
      id: r.id,
      verdict: r.verdict,
      count: r.findings.length,
      counted: r.counted,
      synthesis: r.synthesis,
      dismissed: r.dismissed.map((d) => ({ ...d.finding, reason: d.reason })),
    }));
    const agentRows = perReview.flatMap((r) =>
      r.agents.map((a) => ({
        ...a,
        provider: a.providerName,
        review: r.id,
      }))
    );
    const stickyBase = renderStickyBody({
      verdict: global,
      status,
      perReview: reviewRows,
      agents: agentRows,
      findings: all,
      runUrl,
      headSha,
      stateReviews: perReview.map((r) => ({
        id: r.id,
        verdict: r.verdict,
        findings: [
          ...r.findings.map((f) => ({
            file: f.file,
            ...(f.line !== undefined ? { line: f.line } : {}),
            severity: f.severity,
            category: f.category,
            comment: f.comment,
          })),
          ...(r.carried ?? []),
        ],
      })),
    });
    // Derived from actual agent outcomes, not from a hardcoded list of three
    // env var names — a config using key_from: env.GROQ_API_KEY used to be told
    // "No provider API keys configured" on a fully successful run (issue #49).
    const skippedNoKey = perReview.flatMap((r) => r.agents).filter((a) => a.outcome === "skipped-no-key");
    const allErrors = perReview.flatMap((r) => r.errors);
    // True spend, grouped by model (issue #52): "model 12.3k/1.1k 38t/s".
    // Throughput divides by the group's WALL-CLOCK elapsed
    // (max(end) - min(start)), not the sum of per-call durations — with
    // concurrent agents the sum understates tok/s (two 60s calls of 1k tokens
    // each used to report 500 tok/s for 1k tokens in 60s).
    const { modelsLine, agentsLine } = summarizeUsage(perReview.flatMap((r) => r.usage));
    // Per-run footer extras: shared by update mode (appended to the sticky)
    // and append mode (inside the run's section) — issue #69.
    const extras: string[] = [];
    if (injectionNote) {
      extras.push(`\n\n> ⚠️ ${injectionNote}.`);
    }
    if (truncated || omitted.length > 0) {
      const bits: string[] = [];
      if (truncated) bits.push(`only the first ${MAX_DIFF_FILES} of ${totalFiles} changed files were reviewed`);
      if (omitted.length > 0)
        bits.push(
          `${omitted.length} file(s) not reviewable (binary or diff too large): ${omitted.slice(0, 8).map((f) => `\`${f}\``).join(", ")}${omitted.length > 8 ? ", …" : ""}`
        );
      extras.push(`\n\n> ⚠️ ${bits.join(". ")}.`);
    }
    if (modelsLine) {
      extras.push(`\n<sub>Models: ${modelsLine}</sub>`);
      logInfo(`Usage: ${modelsLine}`);
    }
    if (agentsLine) {
      extras.push(`\n<sub>Agents: ${agentsLine}</sub>`);
      logInfo(`Per-agent usage: ${agentsLine}`);
    }
    // Incremental ledgers ride the same footer path in both sticky modes
    // (issue #18): fixed/still-open/new counts plus the fixed list.
    for (const r of perReview) {
      if (r.ledger) extras.push(...r.ledger);
    }
    if (skippedNoKey.length > 0) {
      const names = [...new Set(skippedNoKey.map((a) => a.agent))].map((a) => `\`${a}\``).join(", ");
      extras.push(
        `\n\n> ⚠️ ${skippedNoKey.length} agent(s) skipped — no API key for their provider: ${names}. ` +
        `Add the secret each provider's \`key_from\` names (see \`.github/openreview.yml\`).`
      );
      logWarning(`${skippedNoKey.length} agent(s) skipped for a missing API key: ${names}`);
    }
    if (allErrors.length > 0) {
      const scope =
        status === "error"
          ? "⚠️ All agents failed — no review completed"
          : `⚠️ ${allErrors.length} agent error(s)`;
      extras.push(`\n\n<details><summary>${scope} — details</summary>\n\n${allErrors.join("\n")}\n\nCheck model IDs and base URLs against the provider docs. Secrets are never logged.</details>`);
    }
    // Inline review runs BEFORE the single sticky publish so a dropped-count
    // note can ride along in the sticky (issue #53). Skipped entirely on dry
    // runs — like the sticky publish below, it must never touch the API.
    if (!dryRun && selectInlineFindings(perReview).length > 0) {
      try {
        // Commentable ranges from the full parsed diff (issue #53): a finding
        // with a bogus path/line is dropped before posting so one bad position
        // can never 422 the whole batch.
        const validLines = new Map(
          parsedDiff.map((p) => [p.file, parseHunkRanges(p.patch)] as const)
        );
        const inline = selectInlineFindings(perReview);
        const res = await createInlineReview(
          octokit, owner, repo, prNumber, headSha, global, inline, validLines
        );
        if (res.dropped > 0)
          extras.push(`\n<sub>ℹ️ ${res.dropped} finding(s) could not be placed inline (invalid position or over the 20-comment cap).</sub>`);
        logInfo(`Published inline review (${global}): ${res.posted} posted, ${res.dropped} dropped.`);
      } catch (e) {
        logWarning(`Inline review failed (non-fatal): ${(e as Error).message}`);
      }
    }
    const mode = config.global_verdict.sticky_comment_mode ?? "update";
    if (dryRun) {
      const preview = mode === "append" ? "(append section preview)" : stickyBase + extras.join("");
      logInfo(`DRY RUN verdict=${global} status=${status} mode=${mode}\n${preview.slice(0, 2000)}`);
      return;
    }
    if (config.global_verdict.sticky_comment) {
      if (mode === "append") {
        const section = renderAppendSection({
          verdict: global,
          status,
          perReview: reviewRows,
          agents: agentRows,
          findings: all,
          headSha,
          runUrl,
          extras,
          stateReviews: perReview.map((r) => ({
        id: r.id,
        verdict: r.verdict,
        findings: [
          ...r.findings.map((f) => ({
            file: f.file,
            ...(f.line !== undefined ? { line: f.line } : {}),
            severity: f.severity,
            category: f.category,
            comment: f.comment,
          })),
          ...(r.carried ?? []),
        ],
      })),
        });
        const { rotated } = await appendStickySection(octokit, owner, repo, prNumber, section);
        logInfo(`Appended sticky section (verdict ${global}, ${all.length} findings${rotated ? ", rotated" : ""}).`);
      } else {
        await upsertStickyComment(octokit, owner, repo, prNumber, stickyBase + extras.join(""));
        logInfo(`Published sticky comment (verdict ${global}, ${all.length} findings).`);
      }
      // Feedback signal (issue #23, learning half of #43): reactions on the
      // bot's own comments, logged as structured output. Read-only; a
      // failure here must never fail the run.
      const signals = await collectFeedbackSignals(octokit, owner, repo, prNumber);
      logInfo(`Feedback signals: ${JSON.stringify(signals.totals)} across ${signals.comments.length} bot comment(s).`);
    }
    if (global === "request_changes" && config.global_verdict.fail_check_on_request_changes)
      core.setFailed("OpenReview verdict: request_changes");
  } catch (e) {
    core.setFailed((e as Error).message);
  }
}
