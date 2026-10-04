export function matchesAny(path: string, patterns: string[]): boolean {
  if (patterns.length === 0) return true;
  return patterns.some((p) => matchGlob(path, p));
}

// Minimal glob: supports **, *, exact. Good enough for path scoping without deps.
export function matchGlob(path: string, pattern: string): boolean {
  if (pattern === "**" || pattern === "**/**") return true;
  const segs = pattern.split("/");
  let rx = "";
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const last = i === segs.length - 1;
    if (seg === "**") {
      // A whole `**` segment means "zero or more path segments", so `**/*.ts`
      // matches BOTH `main.ts` and `src/a/b.ts`. Emitting `.*` here instead
      // required a following "/", which silently dropped every root-level file
      // (issue #48).
      rx += last ? ".*" : "(?:[^/]+/)*";
      continue;
    }
    // Inside a segment, `**` keeps its legacy "crosses directories" meaning
    // (`**.lock` still matches `sub/dir/x.lock`, as shipped configs rely on)
    // and a lone `*` stays within one segment.
    const body = seg
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      // split/join (not sequential replaces): substituting `**` -> `.*` first
      // would let the single-star pass rewrite the `*` inside that `.*`.
      .split("**")
      .map((part) => part.replace(/\*/g, "[^/]*"))
      .join(".*");
    rx += `(?:${body})`;
    if (!last) rx += "/";
  }
  return new RegExp(`^${rx}$`).test(path);
}

export function filterIgnored(files: string[], ignore: string[]): string[] {
  if (!ignore.length) return files;
  return files.filter((f) => !ignore.some((p) => matchGlob(f, p)));
}

/** One file's slice of a unified diff, as GitHub returns it. */
export type DiffFile = { file: string; patch: string };

/**
 * Split a multi-file unified diff into per-file patches (issue #47).
 * GitHub hands us one blob built as
 *   --- a/<file>\n+++ b/<file>\n<patch>
 * so the `+++ b/` header is the reliable boundary: every line inside a patch
 * body starts with ' ', '+' or '-', so no body line can itself start with
 * `+++ b/` — an added line reading `+++ b/x` is written `++++ b/x` and a
 * context line carries a leading space.
 *
 * A file whose content legitimately contains that sequence cannot be
 * represented — no caller builds such a diff, so this is a documented
 * limitation rather than a guess.
 */
export function splitDiff(diff: string): DiffFile[] {
  const out: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let curBody: string[] = [];
  const flush = () => {
    if (cur && curBody.length) {
      const body = curBody.join("\n");
      // Patch lines only (skip the ---/+++ headers we consumed).
      if (body.startsWith("@@") || body.startsWith("+") || body.startsWith("-")) {
        out.push({ file: cur.file, patch: body });
      }
    }
    cur = null;
    curBody = [];
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      flush();
      cur = { file: line.slice(6), patch: "" };
      continue;
    }
    if (cur && !line.startsWith("--- a/")) curBody.push(line);
  }
  flush();
  return out;
}

/**
 * The diff restricted to `files`, with an honest manifest header.
 *
 * `if_paths` used to only decide *whether* a review ran: agents always received
 * the entire PR diff, so a review scoped to `src/**` still saw (and paid for,
 * and could comment on) the website/ and dist/ changes (issue #47).
 */
export function scopeDiff(files: string[], parsed: DiffFile[], totalInScope: number): string {
  const wanted = new Set(files);
  const picked = parsed.filter((p) => wanted.has(p.file));
  const body = picked.map((p) => `--- a/${p.file}\n+++ b/${p.file}\n${p.patch}`).join("\n\n");
  if (totalInScope <= 0 || picked.length === totalInScope) return body;
  const omitted = totalInScope - picked.length;
  if (picked.length === 0) {
    // Should not happen when fileNames and the diff come from the same call, so
    // say so plainly instead of telling the model to judge an empty prompt.
    return (
      `# OpenReview scope note: NO patch text is available for the ${totalInScope} in-scope ` +
      `changed file(s) this review matched (${files.slice(0, 5).join(", ")}${files.length > 5 ? ", …" : ""}). ` +
      `They may be binary or too large for GitHub to render. Report no findings rather than guessing.`
    );
  }
  return (
    `${body}\n\n# OpenReview scope note: ${picked.length} of ${totalInScope} in-scope changed ` +
    `file(s) are included, matched against if_paths. ${omitted} omitted. Judge only the ` +
    `files above.`
  );
}

/**
 * Commentable line ranges of a unified patch, in new-file coordinates
 * (issue #53). GitHub only accepts inline comments on lines that are part of
 * the diff, so a model-invented line number must be checked against these —
 * otherwise one bad position 422s the whole `createReview` batch and every
 * finding is lost. Parsed from `@@ -a,b +c,d @@` headers; a `+c,0` hunk
 * (pure deletion) contributes no commentable lines.
 */
export function parseHunkRanges(patch: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (const line of patch.split("\n")) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m) continue;
    const start = Number(m[1]);
    const len = m[2] === undefined ? 1 : Number(m[2]);
    if (len > 0) out.push({ start, end: start + len - 1 });
  }
  return out;
}

/** True when `line` falls inside any commentable range. */
export function lineInRanges(line: number, ranges: { start: number; end: number }[]): boolean {
  return ranges.some((r) => line >= r.start && line <= r.end);
}

export function dedupeFindings<T extends { file: string; line?: number; comment: string }>(
  findings: T[]
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const f of findings) {
    const k = `${f.file}:${f.line ?? 0}:${f.comment.slice(0, 80)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f);
  }
  return out;
}

/**
 * Drop findings matching decided-item patterns (rebutted items that must not
 * resurrect). Each pattern is a case-insensitive regex against
 * "<file> <comment>". Runs after dedupe, before noise controls and verdict
 * math — suppressed findings neither show nor vote.
 */
export function applySuppression<T extends { file: string; comment: string }>(
  findings: T[],
  patterns: string[]
): { visible: T[]; suppressed: number } {
  if (patterns.length === 0) return { visible: findings, suppressed: 0 };
  const res = patterns.map((s) => new RegExp(s, "i"));
  const visible = findings.filter((f) => !res.some((re) => re.test(`${f.file} ${f.comment}`)));
  return { visible, suppressed: findings.length - visible.length };
}

/**
 * A review where only some agents produced a usable result must not report a
 * clean pass: we did not get the whole picture (issue #46). Blocking verdicts
 * are preserved — a degraded review can still escalate.
 */
export function applyDegradedFloor(verdict: Verdict, counted: number, total: number): Verdict {
  if (counted <= 0 || counted >= total) return verdict;
  return verdict === "approve" ? "comment" : verdict;
}

export type Verdict = "approve" | "comment" | "request_changes";

export type NoiseProfile = "quiet" | "balanced" | "assertive";

// Presets for noise control. balanced ≈ historical behavior (no effective
// filtering: floor 0, cap above the display limits). Severity stays owned by
// verdict.min_severity; profiles only add confidence + cap.
export const NOISE_PRESETS: Record<NoiseProfile, { min_confidence: number; max_findings: number }> = {
  quiet: { min_confidence: 0.85, max_findings: 3 },
  balanced: { min_confidence: 0, max_findings: 50 },
  assertive: { min_confidence: 0, max_findings: 100 },
};

export type NoiseSettings = {
  min_confidence: number;
  max_findings: number;
};

export function resolveNoise(opts: {
  profile?: NoiseProfile;
  min_confidence?: number;
  max_findings?: number;
}): NoiseSettings {
  const preset = NOISE_PRESETS[opts.profile ?? "balanced"];
  return {
    min_confidence: opts.min_confidence ?? preset.min_confidence,
    max_findings: opts.max_findings ?? preset.max_findings,
  };
}

export function applyNoiseControls<T extends { confidence: number; severity: string }>(
  findings: T[],
  settings: NoiseSettings
): { visible: T[]; dropped: number } {
  const kept = findings.filter((f) => (f.confidence ?? 0.7) >= settings.min_confidence);
  const rank: Record<string, number> = { high: 0, medium: 1, suggestion: 2 };
  kept.sort(
    (a, b) => rank[a.severity] - rank[b.severity] || (b.confidence ?? 0.7) - (a.confidence ?? 0.7)
  );
  const visible = kept.slice(0, Math.max(1, settings.max_findings));
  return { visible, dropped: findings.length - visible.length };
}

export function decideReviewVerdict(
  mode: Verdict,
  minSeverity: "suggestion" | "medium" | "high",
  findings: { severity: "high" | "medium" | "suggestion" }[]
): Verdict {
  const rank = { suggestion: 0, medium: 1, high: 2 } as const;
  const need = rank[minSeverity];
  const hasBlocking = findings.some((f) => rank[f.severity] >= need);
  if (!hasBlocking) return "approve";
  return mode;
}

/**
 * Combine per-review verdicts (issue #45). Fail-closed: without a quorum of
 * approvals the result is the most severe verdict on the table, so a lone
 * `request_changes` is never outvoted into `approve` and the result never
 * depends on the order reviews were declared in.
 * - any_blocking / max_severity: most severe verdict wins (max_severity is a
 *   documented alias — both are the same operation on verdict enums).
 * - majority: `approve` iff a quorum (> half) approved — which is the whole
 *   point of opting into `majority`, so 3 approvals DO outvote 1 request_changes
 *   here. Without that quorum the most severe verdict wins, and ties never
 *   resolve toward `approve`. Before this rule, ['approve','comment',
 *   'request_changes'] resolved to `approve`.
 */
export function combineVerdicts(
  verdicts: Verdict[],
  strategy: "any_blocking" | "max_severity" | "majority"
): Verdict {
  if (verdicts.length === 0) return "comment";
  const rank: Record<Verdict, number> = { approve: 0, comment: 1, request_changes: 2 };
  const mostSevere = () =>
    verdicts.reduce((a, b) => (rank[b] > rank[a] ? b : a), verdicts[0]);
  if (strategy === "majority") {
    const approvals = verdicts.filter((v) => v === "approve").length;
    // Quorum rule: without a real majority of approvals, `approve` is unreachable.
    if (approvals * 2 > verdicts.length) return "approve";
    return mostSevere();
  }
  return mostSevere();
}

type Semver = [number, number, number];

function parseSemver(s: string): Semver | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(s.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function cmpSemver(a: Semver, b: Semver): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

// Per-review provider ballots (issue #12). Each distinct provider used by a
// review's agents casts one ballot: its own verdict over its own findings.
// - any: most severe ballot wins (identical to the old pooled behavior).
// - all: unanimous to escalate (minimum severity wins).
// - majority: median ballot; even-count ties break toward more severe.
export function combineBallots(
  ballots: Verdict[],
  strategy: "any" | "all" | "majority"
): Verdict {
  if (ballots.length === 0) return "approve";
  if (ballots.length === 1) return ballots[0];
  const rank = { approve: 0, comment: 1, request_changes: 2 } as const;
  if (strategy === "all") {
    if (ballots.every((v) => v === "request_changes")) return "request_changes";
    if (ballots.every((v) => v !== "approve")) return "comment";
    return "approve";
  }
  if (strategy === "majority") {
    const sorted = [...ballots].sort((a, b) => rank[a] - rank[b]);
    return sorted[Math.ceil((sorted.length - 1) / 2)];
  }
  return [...ballots].sort((a, b) => rank[b] - rank[a])[0];
}

// Supports ">=1.2.3", ">1.2.3", "=1.2.3", "1.2.3", "^1.2.3", "~1.2.3".
export function satisfiesActionVersion(requires: string, running: string): boolean {
  const req = requires.trim();
  const runningV = parseSemver(running);
  if (!runningV) return true; // unknown runner version -> don't block
  const m = /^(>=|>|=|\^|~)?\s*v?(\d+\.\d+\.\d+(?:[-+].*)?)$/.exec(req);
  if (!m) return true; // unparseable constraint -> don't block (validated elsewhere)
  const floor = parseSemver(m[2]);
  if (!floor) return true;
  const op = m[1] ?? "=";
  const c = cmpSemver(runningV, floor);
  switch (op) {
    case ">": return c > 0;
    case ">=": return c >= 0;
    case "^": return c >= 0 && runningV[0] === floor[0];
    case "~": return c >= 0 && runningV[0] === floor[0] && runningV[1] === floor[1];
    default: return c === 0;
  }
}

// Best-effort running version: exact tag ref (v0.3.0) or explicit env override.
// Floating refs (v1, main) can't be resolved locally -> null means "skip the check".
export function runningActionVersion(env: NodeJS.ProcessEnv): string | null {
  if (env["OPENREVIEW_ACTION_VERSION"]) return env["OPENREVIEW_ACTION_VERSION"] as string;
  const ref = env["GITHUB_ACTION_REF"] ?? "";
  if (/^v?\d+\.\d+\.\d+/.test(ref)) return ref;
  return null;
}
