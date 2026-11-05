import * as github from "@actions/github";
import { lineInRanges } from "./reviewer.js";

export const STICKY_MARKER = "<!-- openreview:sticky -->";

/** Scrub key-shaped secrets out of error text (issue #58f). Provider error
 * bodies travel into the sticky's agent-error block; a gateway that echoes
 * request material must never leak a credential into a PR comment. */
const SECRET_RES = [
  /sk-[A-Za-z0-9-_]{10,}/g,
  /gh[pousr]_[A-Za-z0-9]{10,}/g,
  /xox[bpas]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
];

/** Truncate to ~300 chars and scrub key-shaped strings. Best-effort: exact
 * originals stay in the Actions log for debugging. */
export function sanitizeErrorDetail(text: string, cap = 300): string {
  let out = text;
  for (const re of SECRET_RES) out = out.replace(re, "[redacted]");
  out = out.replace(/\s+/g, " ").trim();
  return out.length > cap ? out.slice(0, cap) + "…" : out;
}

function actionBase(): { repo: string; ref: string } {
  // Prefer the action's own coordinates so forks/renames keep working; the
  // hardcoded default matches this repo's published location.
  const repo = process.env.GITHUB_ACTION_REPOSITORY || "sankara-sabapathy/openreview";
  const ref = process.env.GITHUB_ACTION_REF || "";
  // With `uses: ./` (how PRs dogfood unreleased changes) GITHUB_ACTION_REF is the
  // checkout ref — `refs/pull/62/merge` — which raw.githubusercontent cannot
  // serve, so the logo would 404 in every comment. Prefer the PR's head branch,
  // then any plain branch/tag, and fall back to the default branch.
  //
  // Only trust GITHUB_HEAD_REF when the head branch actually lives in THIS
  // repo: on a fork PR it does not, and {base}/{head}/assets 404s — the exact
  // failure this function exists to prevent.
  const headRepo = (github.context?.payload as any)?.pull_request?.head?.repo?.full_name;
  const head =
    typeof headRepo === "string" && headRepo.toLowerCase() === repo.toLowerCase()
      ? process.env.GITHUB_HEAD_REF || ""
      : "";
  if (head && !head.includes("..") && !/[~^:\\]|\s/.test(head)) return { repo, ref: head };
  if (/^[\w.\-/]+$/.test(ref) && !ref.startsWith("refs/")) return { repo, ref };
  return { repo, ref: "main" };
}

export function logoUrl(): string {
  const { repo, ref } = actionBase();
  return `https://raw.githubusercontent.com/${repo}/${ref}/assets/logo.svg`;
}

export type RunStatus = "ok" | "partial" | "error";

const OUTCOME_LABEL: Record<string, string> = {
  ok: "✅ reviewed",
  "no-findings": "✅ no findings",
  "skipped-no-key": "⏭️ skipped (no key)",
  "budget-exhausted": "⏱️ skipped (run budget)",
  unparseable: "⚠️ unusable response",
  error: "❌ failed",
};

function logoImg(): string {
  return `<img src="${logoUrl()}" width="28" height="28" align="left" alt="OpenReview AI" />`;
}

/** Fresh sticky body for append mode's first run and post-rotation runs. */
function freshAppendBody(section: string): string {
  return [STICKY_MARKER, logoImg(), section, `\n${REREVIEW_LINE}`].join("\n");
}

/** One review's row in the sticky. `synthesis`/`dismissed` come from the
 * main agent in `main_mode: synthesize`. */
export type ReviewRow = {
  id: string;
  verdict: string;
  count: number;
  counted?: boolean;
  synthesis?: { summary: string; walkthrough: { file: string; change: string }[] };
  dismissed?: { file: string; line?: number; severity: string; agent: string; reason: string }[];
};

/** Table-cell safe: one line, pipes escaped. */
const cell = (s: string, n: number) => s.replace(/\s+/g, " ").replace(/\|/g, "\\|").slice(0, n);

/** Character budget for all reviews' summary/walkthrough/dismissed blocks
 * together, so a many-review config cannot push one append section toward
 * STICKY_LIMIT (see appendStickySection's size assumption). */
export const SYNTHESIS_BUDGET = 16000;

/** Summary, walkthrough and dismissed findings for every review that has
 * them. Labels name the review only when more than one review is shown. */
export function renderSynthesis(rows: ReviewRow[]): string[] {
  const withData = rows.filter(
    (r) => (r.synthesis && (r.synthesis.summary || r.synthesis.walkthrough.length > 0)) || (r.dismissed?.length ?? 0) > 0
  );
  if (withData.length === 0) return [];
  const label = (r: ReviewRow) => (rows.length > 1 ? ` — \`${r.id}\`` : "");
  const out: string[] = [];
  let used = 0;
  for (let i = 0; i < withData.length; i++) {
    const r = withData[i];
    const block: string[] = [];
    if (r.synthesis?.summary) {
      block.push(`**Summary${label(r)}**`, "", r.synthesis.summary.replace(/\s+/g, " ").slice(0, 1200), "");
    }
    const walk = r.synthesis?.walkthrough ?? [];
    if (walk.length > 0) {
      const shown = walk.slice(0, 25);
      block.push(`<details><summary>📋 Walkthrough${label(r)} (${walk.length} file${walk.length === 1 ? "" : "s"})</summary>`, "");
      block.push("| File | Change |", "|---|---|");
      for (const w of shown) block.push(`| \`${cell(w.file, 160)}\` | ${cell(w.change, 240)} |`);
      if (walk.length > shown.length) block.push("", `… and ${walk.length - shown.length} more.`);
      block.push("", "</details>", "");
    }
    const dis = r.dismissed ?? [];
    if (dis.length > 0) {
      const shown = dis.slice(0, 15);
      block.push(
        `<details><summary>🧹 ${dis.length} finding(s) dismissed by the synthesizer${label(r)}</summary>`,
        "",
        "| Severity | File | Reported by | Why dismissed |",
        "|---|---|---|---|"
      );
      for (const d of shown) {
        const loc = d.line ? `${d.file}:${d.line}` : d.file;
        block.push(`| ${d.severity} | \`${cell(loc, 160)}\` | ${cell(d.agent, 80)} | ${cell(d.reason, 240)} |`);
      }
      if (dis.length > shown.length) block.push("", `… and ${dis.length - shown.length} more.`);
      block.push("", "</details>", "");
    }
    const text = block.join("\n");
    if (used + text.length > SYNTHESIS_BUDGET && out.length > 0) {
      out.push(`<sub>Summary for ${withData.length - i} more review(s) omitted for length.</sub>`, "");
      break;
    }
    out.push(...block);
    used += text.length;
  }
  return out;
}

type RunContentOpts = {
  verdict: string;
  status?: RunStatus;
  perReview: ReviewRow[];
  agents?: {
    review: string;
    agent: string;
    provider: string;
    outcome: string;
    seconds: number;
    /** Fallback chain note (issue #101), shown under the provider. */
    fallback?: string;
  }[];
  findings?: {
    file: string;
    line?: number;
    severity: string;
    category: string;
    comment: string;
    suggestion?: string;
    agent: string;
    provider: string;
    model: string;
  }[];
  runUrl?: string;
};

/** Verdict heading text shared by update (`##`) and append (`###`) modes. */
function verdictTitle(verdict: string, status: RunStatus): string {
  return status === "error" ? "REVIEW FAILED" : verdict.replace(/_/g, " ").toUpperCase();
}

/**
 * The per-run content core: everything after the heading through the
 * agent-details block. Shared by the update body and append sections so both
 * render identically (issue #69).
 */
function renderRunBody(opts: RunContentOpts): string[] {
  const status = opts.status ?? "ok";
  const findings = opts.findings ?? [];
  const lines: string[] = [];
  lines.push("");
  lines.push("");
  lines.push("<br />");
  lines.push("");
  if (status === "partial") {
    const failed = opts.perReview.filter((r) => r.counted === false).map((r) => r.id);
    lines.push(
      `> ⚠️ **Partial review** — ${failed.map((i) => `\`${i}\``).join(", ")} produced no usable result and did not vote.`
    );
    lines.push("");
  }
  for (const r of opts.perReview)
    lines.push(
      `- \`${r.id}\`: **${r.counted === false ? "not reviewed" : r.verdict}** (${r.count} findings)`
    );
  lines.push("");
  lines.push(...renderSynthesis(opts.perReview));
  if (status === "error") {
    lines.push("**No review completed.** The verdict below is not a pass — see the agent results.");
    lines.push("");
  }
  if (findings.length === 0) {
    lines.push(
      status === "ok"
        ? "No actionable findings. Nice work."
        : "No findings were produced (the run did not complete cleanly)."
    );
  } else {
    lines.push("| Severity | File | Finding | Agent |");
    lines.push("|---|---|---|---|");
    for (const f of findings.slice(0, 50)) {
      // Every cell is model-controlled text: escape pipes everywhere and
      // neutralize backticks in the file cell (an unmatched ` would break
      // out of the code span and reshape the table) (issue #58).
      const loc = (f.line ? `${f.file}:${f.line}` : f.file).replace(/\|/g, "\\|").replace(/`/g, "'");
      const one = f.comment.replace(/\n+/g, " ").replace(/\|/g, "\\|").slice(0, 220);
      const by = `${f.agent}/${f.provider}/${f.model}`.replace(/\|/g, "\\|");
      lines.push(`| ${f.severity} | \`${loc}\` | ${one} | ${by} |`);
    }
    if (findings.length > 50)
      lines.push(`\n… and ${findings.length - 50} more (see inline comments).`);
  }
  lines.push(...renderSuggestedFixes(findings));
  const agents = opts.agents ?? [];
  const rough = agents.filter((a) => a.outcome !== "ok" && a.outcome !== "no-findings");
  if (agents.length > 0) {
    lines.push("");
    lines.push(
      `<details><summary>🤖 ${agents.length} agent(s)${rough.length ? ` — ${rough.length} not clean` : ""}</summary>`
    );
    lines.push("");
    lines.push("| Agent | Provider | Outcome | Time |");
    lines.push("|---|---|---|---|");
    for (const a of agents) {
      lines.push(
        `| ${a.agent} | ${a.provider}${a.fallback ? `<br><sub>fallback: ${cell(sanitizeErrorDetail(a.fallback, 160), 160).replace(/</g, "&lt;").replace(/>/g, "&gt;")}</sub>` : ""} | ${OUTCOME_LABEL[a.outcome] ?? a.outcome} | ${a.seconds.toFixed(1)}s |`
      );
    }
    lines.push("");
    lines.push("</details>");
  }
  return lines;
}

const REREVIEW_LINE = "<sub>Re-review with `/review`. Config: `.github/openreview.yml`.</sub>";

/** Cap for the sticky suggested-fixes section (issue #22). */
export const SUGGESTED_FIXES_SHOWN = 10;

const SUGGEST_LANG: [RegExp, string][] = [
  [/\.tsx?$/, "ts"],
  [/\.jsx?$/, "js"],
  [/\.py$/, "python"],
  [/\.go$/, "go"],
  [/\.rs$/, "rust"],
  [/\.java$/, "java"],
  [/\.md$/, "markdown"],
  [/\.ya?ml$/, "yaml"],
  [/\.json$/, "json"],
  [/\.sh$/, "bash"],
];

/** Strip fences so model output cannot break out of our code block. */
export function sanitizeSuggestion(code: string): string {
  return code.replace(/```/g, "").trim();
}

function suggestLang(file: string): string {
  for (const [re, lang] of SUGGEST_LANG) if (re.test(file)) return lang;
  return "";
}

/**
 * One-click fixes (issue #22): findings carrying `suggestion` get a
 * collapsed section with fenced replacement blocks. Inline comments carry
 * the appliable ```suggestion form instead (see createInlineReview); the
 * sticky shows plain fences since table cells cannot hold them and the
 * section has no diff position to apply against.
 */
export function renderSuggestedFixes(
  findings: { file: string; line?: number; comment: string; suggestion?: string }[]
): string[] {
  const withFix = findings.filter((f) => f.suggestion && f.suggestion.trim().length > 0);
  if (withFix.length === 0) return [];
  const shown = withFix.slice(0, SUGGESTED_FIXES_SHOWN);
  const lines = [
    "",
    `<details><summary>Suggested fixes (${withFix.length})</summary>`,
    "",
  ];
  for (const f of shown) {
    const loc = f.line ? `${f.file}:${f.line}` : f.file;
    lines.push(`**\`${loc}\`** — ${f.comment.replace(/\s+/g, " ").slice(0, 160)}`, "");
    lines.push(`\`\`\`${suggestLang(f.file)}`, sanitizeSuggestion(f.suggestion!), "```", "");
  }
  if (withFix.length > shown.length)
    lines.push(`… and ${withFix.length - shown.length} more (see inline comments).`, "");
  lines.push("</details>");
  return lines;
}

/**
 * Machine-readable run state for incremental re-review (issue #18).
 *
 * The next `synchronize` run needs two things no API gives it cheaply: the
 * exact SHA it last reviewed (so it can diff head-vs-last instead of
 * base..head) and that run's open findings (so agents can validate fixes
 * instead of re-reporting). Both ride along as a hidden HTML comment —
 * invisible to users, zero new storage, subject to the same STICKY_LIMIT
 * rotation as everything else. Update mode carries one block; append mode
 * one per section, and the parser takes the LAST valid block (latest run).
 */
export const STICKY_STATE_MARKER = "openreview:state";
export const STICKY_STATE_VERSION = 1;
/** Per-finding comment cap in state: enough to re-identify, not the full text. */
export const STICKY_STATE_COMMENT_CAP = 500;
/** Per-review finding cap in state; cut reviews set `truncated` so the next
 * run knows the carry is partial and falls back to a full review. */
export const STICKY_STATE_FINDINGS_CAP = 50;

export type StickyFindingState = {
  file: string;
  line?: number;
  severity: string;
  category: string;
  comment: string;
};
export type StickyReviewState = {
  id: string;
  verdict: string;
  findings: StickyFindingState[];
  truncated: boolean;
};
export type StickyRunState = {
  v: number;
  sha: string;
  reviews: StickyReviewState[];
};

export function renderStickyState(
  sha: string,
  reviews: { id: string; verdict: string; findings: StickyFindingState[] }[]
): string {
  const state: StickyRunState = {
    v: STICKY_STATE_VERSION,
    sha,
    reviews: reviews.map((r) => {
      const kept = r.findings.slice(0, STICKY_STATE_FINDINGS_CAP);
      return {
        id: r.id,
        verdict: r.verdict,
        findings: kept.map((f) => ({
          file: f.file,
          ...(f.line !== undefined ? { line: f.line } : {}),
          severity: f.severity,
          category: f.category,
          comment: f.comment.slice(0, STICKY_STATE_COMMENT_CAP),
        })),
        // Partial carry in either dimension (dropped findings or sliced
        // comments) means the next run cannot trust the state as complete.
        truncated:
          r.findings.length > STICKY_STATE_FINDINGS_CAP ||
          kept.some((f) => f.comment.length > STICKY_STATE_COMMENT_CAP),
      };
    }),
  };
  // Finding text is attacker-influenced (it quotes PR diffs). A literal
  // `-->` inside would close the HTML comment early and corrupt or split
  // the block; `<!--` would nest one. Both sequences are escaped with
  // JSON unicode escapes, which JSON.parse decodes back byte-identically,
  // so the round-trip is exact and the comment structure is intact.
  const json = JSON.stringify(state).replace(/<!--/g, "\\u003c!--").replace(/-->/g, "--\\u003e");
  return `<!-- ${STICKY_STATE_MARKER} ${json} -->`;
}

function isStickyFindingState(f: unknown): f is StickyFindingState {
  const o = f as Record<string, unknown>;
  return (
    !!o &&
    typeof o.file === "string" &&
    (o.line === undefined || typeof o.line === "number") &&
    typeof o.severity === "string" &&
    typeof o.category === "string" &&
    typeof o.comment === "string"
  );
}

/** Latest valid state block in a sticky body, or null when none parses.
 * Never throws: a hand-edited or truncated block is not state. */
export function parseStickyState(body: string): StickyRunState | null {
  const re = new RegExp(`<!-- ${STICKY_STATE_MARKER} (.*?) -->`, "gs");
  let m: RegExpExecArray | null;
  let last: StickyRunState | null = null;
  while ((m = re.exec(body)) !== null) {
    try {
      const s = JSON.parse(m[1]) as Partial<StickyRunState>;
      if (typeof s !== "object" || s === null || s.v !== STICKY_STATE_VERSION) continue;
      if (typeof s.sha !== "string" || s.sha.length === 0) continue;
      if (!Array.isArray(s.reviews)) continue;
      const reviews: StickyReviewState[] = [];
      let ok = true;
      for (const r of s.reviews) {
        const ro = r as Partial<StickyReviewState>;
        if (!ro || typeof ro.id !== "string" || typeof ro.verdict !== "string" || !Array.isArray(ro.findings)) {
          ok = false;
          break;
        }
        if (!ro.findings.every(isStickyFindingState)) {
          ok = false;
          break;
        }
        reviews.push({ id: ro.id, verdict: ro.verdict, findings: ro.findings, truncated: ro.truncated === true });
      }
      if (!ok) continue;
      last = { v: STICKY_STATE_VERSION, sha: s.sha, reviews };
    } catch {
      continue;
    }
  }
  return last;
}

export function renderStickyBody(opts: {
  verdict: string;
  status?: RunStatus;
  perReview: ReviewRow[];
  agents?: {
    review: string;
    agent: string;
    provider: string;
    outcome: string;
    seconds: number;
    /** Fallback chain note (issue #101), shown under the provider. */
    fallback?: string;
  }[];
  findings: {
    file: string;
    line?: number;
    severity: string;
    category: string;
    comment: string;
    agent: string;
    provider: string;
    model: string;
  }[];
  runUrl?: string;
  headSha?: string;
  stateReviews?: { id: string; verdict: string; findings: StickyFindingState[] }[];
}): string {
  const status = opts.status ?? "ok";
  const lines: string[] = [];
  lines.push(STICKY_MARKER);
  lines.push(logoImg());
  // Fail loud: a run where nothing was reviewed must never read as a pass
  // (issue #46). "APPROVE / No actionable findings. Nice work." was printed for
  // runs where every agent had errored.
  lines.push(`## OpenReview AI — ${verdictTitle(opts.verdict, status)}`);
  lines.push(...renderRunBody(opts));
  if (opts.runUrl) lines.push(`\n<sub>Run: ${opts.runUrl}</sub>`);
  if (opts.headSha && opts.stateReviews) lines.push(`\n${renderStickyState(opts.headSha, opts.stateReviews)}`);
  lines.push(`\n${REREVIEW_LINE}`);
  return lines.join("\n");
}

/**
 * One run's section for append mode (issue #69): headed by short SHA +
 * verdict + run link, same content core as the update body, then the run's
 * footer extras (usage, warnings — assembled by the caller).
 */
export function renderAppendSection(
  opts: RunContentOpts & {
    headSha: string;
    runUrl?: string;
    extras?: string[];
    stateReviews?: { id: string; verdict: string; findings: StickyFindingState[] }[];
  }
): string {
  const status = opts.status ?? "ok";
  const short = opts.headSha.slice(0, 7);
  const runLink = opts.runUrl ? ` ([run](${opts.runUrl}))` : "";
  const lines = [
    `### \`${short}\` — ${verdictTitle(opts.verdict, status)}${runLink}`,
    ...renderRunBody(opts),
  ];
  for (const e of opts.extras ?? []) lines.push(e);
  if (opts.stateReviews) lines.push(`\n${renderStickyState(opts.headSha, opts.stateReviews)}`);
  return lines.join("\n");
}

/** GitHub hard-caps comments at 65536 chars; rotate well before hitting it. */
export const STICKY_LIMIT = 60000;

/** GitHub's hard comment cap. */
export const GITHUB_COMMENT_LIMIT = 65536;

/**
 * Mark a rotated comment as superseded (issue #69). Drops the marker so
 * future lookups select the NEW comment — keeping it re-selected the old one
 * on every run, rotating forever (dogfood on #75). Caps at the GitHub limit
 * so the marking edit itself can never 422 (dogfood on #75).
 */
export function markSuperseded(body: string): string {
  const mark = `\n\n> _History rotated — continued in the newest sticky comment._`;
  const unmarked = body.replace(STICKY_MARKER + "\n", "");
  const full = unmarked + mark;
  return full.length > GITHUB_COMMENT_LIMIT ? full.slice(0, GITHUB_COMMENT_LIMIT - mark.length) + mark : full;
}

/**
 * Pure append: existing body + section, trailing re-review line kept last.
 * Reports rotation when the result would pass STICKY_LIMIT — the caller then
 * creates a fresh comment and marks the old one superseded.
 */
export function appendToSticky(
  existing: string,
  section: string
): { body: string; rotated: boolean } {
  const tail = `\n${REREVIEW_LINE}`;
  const base = existing.endsWith(tail) ? existing.slice(0, -tail.length) : existing;
  const body = `${base}\n\n---\n\n${section}${tail}`;
  return body.length > STICKY_LIMIT ? { body: "", rotated: true } : { body, rotated: false };
}

type Octokit = ReturnType<typeof github.getOctokit>;

/** The hardened sticky lookup, shared by update and append modes (issue #53). */
export async function findStickyComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number
) {
  // Paginate everything: on a busy PR the sticky may sit past comment 100,
  // and stopping at the first page posted duplicate stickies (issue #53).
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner, repo, issue_number: issueNumber, per_page: 100,
  });
  // The marker must be the FIRST line and the comment bot-authored. Matching
  // `includes` anywhere let any user hijack the sticky: their comment got
  // picked and the update 403d, failing the whole run (issue #53).
  // Residual: a *different* bot planting the exact first-line marker would
  // still match — but that is overt sabotage with a loud 403, not silent
  // corruption, and authorship cannot be proven further via REST (dogfood #73).
  return (
    comments.find(
      (c) => c.user?.type === "Bot" && typeof c.body === "string" && c.body.startsWith(STICKY_MARKER)
    ) ?? null
  );
}

export async function upsertStickyComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  body: string
): Promise<void> {
  const prev = await findStickyComment(octokit, owner, repo, issueNumber);
  if (prev) {
    await octokit.rest.issues.updateComment({ owner, repo, comment_id: prev.id, body });
  } else {
    await octokit.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body });
  }
}

/**
 * Append-mode publish (issue #69): the sticky becomes a per-run history.
 * First run creates a marker+logo+section body; later runs append sections.
 * Past STICKY_LIMIT a fresh comment starts and the old one is marked
 * superseded, so there is always one canonical comment.
 *
 * Two accepted residuals (dogfood on #75), both loud, neither silent:
 * - Concurrent runs race read-modify-write (the REST API offers no
 *   compare-and-swap, and update mode has always shared this): the loser’s
 *   section is missing from history, but its findings remain in that run’s
 *   inline review and logs. No retry can close it — only narrow it.
 * - A single section is assumed under STICKY_LIMIT: renderer caps (50
 *   findings rows, 10 file notes, 12 agents) bound it to ~16KB worst case,
 *   4x headroom. If caps ever grow past the limit, creation 422s loudly.
 */
export async function appendStickySection(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  section: string
): Promise<{ rotated: boolean }> {
  const prev = await findStickyComment(octokit, owner, repo, issueNumber);
  if (!prev?.body) {
    await octokit.rest.issues.createComment({
      owner, repo, issue_number: issueNumber, body: freshAppendBody(section),
    });
    return { rotated: false };
  }
  const { body, rotated } = appendToSticky(prev.body, section);
  if (!rotated) {
    await octokit.rest.issues.updateComment({ owner, repo, comment_id: prev.id, body });
    return { rotated: false };
  }
  await octokit.rest.issues.createComment({
    owner, repo, issue_number: issueNumber, body: freshAppendBody(section),
  });
  await octokit.rest.issues.updateComment({
    owner, repo, comment_id: prev.id, body: markSuperseded(prev.body),
  });
  return { rotated: true };
}

/** Result of posting an inline review: posted vs dropped counts. */
export type InlineResult = { posted: number; dropped: number };

export async function createInlineReview(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  pullNumber: number,
  commitSha: string,
  verdict: "approve" | "comment" | "request_changes",
  findings: { file: string; line?: number; comment: string; suggestion?: string }[],
  /** Commentable line ranges per changed file (new-file coordinates). */
  validLines: Map<string, { start: number; end: number }[]>
): Promise<InlineResult> {
  const event = verdict === "approve" ? "APPROVE" : verdict === "request_changes" ? "REQUEST_CHANGES" : "COMMENT";
  // Validate BEFORE posting (issue #53): `file`/`line` are unvalidated model
  // output, and one bad position 422s the entire batch — 19 good findings
  // lost with it. Invalid entries never reach the API; the caller reports
  // the dropped count on the sticky instead of failing silently.
  let dropped = 0;
  const comments = [];
  const fileLevel: { file: string; comment: string; suggestion?: string }[] = [];
  // No early exit at the 20-comment cap: the loop must still collect later
  // file-level notes and count later drops, or the sticky understates what
  // never made it inline (dogfood on #73).
  for (const f of findings) {
    if (!f.line || f.line <= 0) {
      // File-level notes need a real path too (dogfood on #73): a
      // model-invented file would otherwise publish unchecked.
      if (!validLines.has(f.file)) {
        dropped++;
        continue;
      }
      fileLevel.push({ file: f.file, comment: f.comment, ...(f.suggestion ? { suggestion: f.suggestion } : {}) });
      continue;
    }
    const ranges = validLines.get(f.file);
    if (!ranges || !lineInRanges(f.line, ranges)) {
      dropped++;
      continue;
    }
    // One-click fix (issue #22): a ```suggestion block on a valid diff
    // position renders as an appliable suggestion in the GitHub UI.
    const body =
      f.suggestion && f.suggestion.trim()
        ? `${f.comment}\n\n\`\`\`suggestion\n${sanitizeSuggestion(f.suggestion)}\n\`\`\``
        : f.comment;
    if (comments.length < 20) comments.push({ path: f.file, line: f.line as number, body });
    else dropped++; // valid but over the cap — counted, not silently lost
  }
  // File-level (line-less) findings used to be silently discarded by the
  // `.filter(line > 0)`; they now ride in the review body (issue #53).
  let body =
    `<img src="${logoUrl()}" width="20" height="20" alt="OpenReview AI" /> **OpenReview AI:** ${verdict} (${findings.length} findings)`;
  if (fileLevel.length > 0) {
    const shown = fileLevel.slice(0, 10);
    body += "\n\n**File-level notes:**\n" + shown.map((f) => `- \`${f.file}\`: ${f.comment}`).join("\n");
    if (fileLevel.length > shown.length)
      body += `\n… and ${fileLevel.length - shown.length} more (see sticky comment).`;
    // Suggestions without a diff position cannot apply; show them fenced.
    for (const f of shown) {
      if (f.suggestion && f.suggestion.trim()) {
        body += `\n\n**Suggested fix for \`${f.file}\`:**\n\`\`\`\n${sanitizeSuggestion(f.suggestion)}\n\`\`\``;
      }
    }
  }
  await octokit.rest.pulls.createReview({
    owner, repo, pull_number: pullNumber, commit_id: commitSha, event: event as any,
    body,
    comments: comments.slice(0, 20) as any,
  });
  return { posted: comments.length, dropped };
}
