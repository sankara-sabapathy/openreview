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
