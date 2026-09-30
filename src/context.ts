import { readFileSync, existsSync, readdirSync, statSync, lstatSync, realpathSync } from "node:fs";
import * as path from "node:path";
import * as core from "@actions/core";
import { matchesAny } from "./reviewer.js";

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "dist-src",
  "website/build",
  ".docusaurus",
  "coverage",
  ".next",
  "vendor",
  "__pycache__",
]);

const SKIP_EXT = new Set([
  ".lock",
  ".snap",
  ".map",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".pdf",
  ".zip",
  ".woff",
  ".woff2",
  ".ttf",
  ".ico",
]);

export type ContextInput = {
  repoRoot: string;
  scopedFiles: string[]; // changed, in-scope files for this review
  contextFiles: string[]; // extra globs from review config
  includeFullFiles: boolean;
  maxContextChars: number;
  ignore: string[];
};

function walkFiles(root: string, ignore: string[], out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(root, e);
    // Never descend into or through symlinks: lstat the link itself, so a
    // symlinked intermediate directory can never escape the repo.
    try {
      if (lstatSync(full).isSymbolicLink()) continue;
    } catch {
      continue;
    }
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(e)) continue;
      walkFiles(full, ignore, out);
    } else {
      // Paths are repo-relative from the walk root (not process.cwd()).
      const rel = path.relative(root, full).replace(/\\/g, "/");
      if (SKIP_EXT.has(path.extname(e))) continue;
      if (ignore.length > 0 && matchesAny(rel, ignore)) continue;
      try {
        if (statSync(full).size > 200_000) continue; // skip huge files
      } catch {
        continue;
      }
      out.push(rel);
    }
  }
  return out;
}

function readCapped(root: string, rel: string, cap: number): string | null {
  const full = path.resolve(root, rel);
  // Containment on the REAL path (resolves symlinked intermediate dirs too, and
  // the root itself — e.g. /tmp -> /private/tmp on macOS):
  // never read outside the repo (config + file list are PR-controlled).
  let realRoot: string;
  try {
    realRoot = realpathSync(path.resolve(root));
  } catch {
    return null;
  }
  let real: string;
  try {
    real = realpathSync(full);
  } catch {
    return null;
  }
  const normRoot = realRoot + path.sep;
  if (real !== realRoot && !real.startsWith(normRoot)) return null;
  try {
    const content = readFileSync(real, "utf8");
    return content.length > cap ? content.slice(0, cap) + "\n...[file truncated]" : content;
  } catch {
    return null;
  }
}

// Top-level defined names: export function|const|class|interface|type X,
// def X / class X (python), ^func X (go), ^(public|private)? (class|function) X (php/java-ish).
const DEF_RES = [
  /export\s+(?:async\s+)?(?:function|const|let|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
  /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
  /^(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/gm,
  /^def\s+([A-Za-z_]\w*)/gm,
  /^class\s+([A-Za-z_]\w*)/gm,
  /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm,
];

export function extractDefinedNames(content: string, limit = 20): string[] {
  const names = new Set<string>();
  for (const re of DEF_RES) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null && names.size < limit) {
      if (m[1].length >= 3) names.add(m[1]);
    }
  }
  return [...names];
}

function isCommentLine(line: string): boolean {
  // Conservative: only unambiguous full-line comments. Prefixes like # -- %
  // are deliberately NOT treated as comments (C preprocessor, --count, 100%).
  // Missing a caller for precision is worse than an extra excerpt here, so
  // Python # comments may still match — acceptable noise.
  const t = line.trimStart();
  return t.startsWith("//") || t.startsWith("/*") || t.startsWith("*");
}

function lineAt(content: string, index: number): number {
  const lines = content.split("\n");
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    count += lines[i].length + 1;
    if (count > index) return i;
  }
  return -1;
}

/** Find up to `tries` code (non-comment) matches of word, returning char indices. */
function findCodeMatches(content: string, word: RegExp, tries = 6): number[] {
  const out: number[] = [];
  const g = new RegExp(word.source, "g");
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = g.exec(content)) !== null && out.length < tries && guard++ < 200) {
    const line = lineAt(content, m.index);
    if (line >= 0 && !isCommentLine(content.split("\n")[line])) out.push(m.index);
    if (m.index === g.lastIndex) g.lastIndex++; // avoid zero-width stall
  }
  return out;
}

function excerptAround(content: string, index: number, radius = 5): string {
  const lines = content.split("\n");
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    count += lines[i].length + 1;
    if (count > index) {
      const from = Math.max(0, i - radius);
      const to = Math.min(lines.length, i + radius + 1);
      return lines
        .slice(from, to)
        .map((l, k) => `${from + k + 1}: ${l}`)
        .join("\n");
    }
  }
  return "";
}

/**
 * Build a <context> block: full changed files + extra globs + call-site
 * excerpts for top-level symbols defined in changed files. Bounded by budget.
 */
export function buildContextBlock(input: ContextInput): { block: string; stats: string } {
  const budget = input.maxContextChars;
  if (budget <= 0) {
    const stats = "context: disabled (max_context_chars <= 0)";
    core.info(stats);
    return { block: "", stats };
  }
  const parts: string[] = [];
  let used = 0;
  // Account for "\n\n" separators + "<context>\n" / "\n</context>" wrapper (21 chars
  // total) so the final prompt never exceeds the budget.
  const WRAPPER_OVERHEAD = 21;
  const push = (text: string): boolean => {
    const cost = text.length + 2; // part + separator
    if (used + cost + WRAPPER_OVERHEAD > budget) {
      // Truncate instead of dropping when a useful chunk would fit.
      const room = budget - used - WRAPPER_OVERHEAD - 2 - 24;
      if (room > 200) {
        const cut = text.slice(0, room) + "\n...[part truncated]";
        parts.push(cut);
        used += cut.length + 2;
        return true;
      }
      return false;
    }
    parts.push(text);
    used += cost;
    return true;
  };
  const pushed = new Set<string>(); // files actually in the prompt (differs from read set)

  let fullCount = 0;
  let extraCount = 0;
  let callerCount = 0;
  const warnings: string[] = [];

  // 1. Full content of changed in-scope files.
  const changedContents = new Map<string, string>();
  if (input.includeFullFiles) {
    for (const f of input.scopedFiles) {
      const content = readCapped(input.repoRoot, f, 12000);
      if (content === null) continue;
      changedContents.set(f, content);
      if (push(`--- full file: ${f} ---\n${content}`)) {
        fullCount++;
        pushed.add(f);
      } else break;
    }
  } else {
    for (const f of input.scopedFiles) {
      const content = readCapped(input.repoRoot, f, 12000);
      if (content !== null) changedContents.set(f, content);
    }
  }

  // Single repo walk reused by extras + callers (was up to 3 walks before).
  const needWalk = input.contextFiles.length > 0 || changedContents.size > 0;
  const all = needWalk ? walkFiles(input.repoRoot, input.ignore) : [];

  // 2. Extra context_files: explicit paths read directly (never silently dropped
  // by walk filters); globs resolved through the walk.
  if (input.contextFiles.length > 0) {
    const matched = new Set<string>();
    for (const pattern of input.contextFiles) {
      const isGlob = /[*?[\]{}!]/.test(pattern);
      if (!isGlob) {
        const direct = readCapped(input.repoRoot, pattern, 8000);
        if (direct !== null) {
          if (!pushed.has(pattern) && !matched.has(pattern)) {
            matched.add(pattern);
            if (push(`--- context file: ${pattern} ---\n${direct}`)) {
              extraCount++;
              pushed.add(pattern);
            }
          }
        } else {
          warnings.push(`context_files: '${pattern}' not found or unreadable`);
        }
        continue;
      }
      for (const f of all) {
        if (matched.size >= 10) break;
        if (matchesAny(f, [pattern]) && !pushed.has(f) && !matched.has(f)) {
          const content = readCapped(input.repoRoot, f, 8000);
          if (content === null) continue;
          matched.add(f);
          if (push(`--- context file: ${f} ---\n${content}`)) {
            extraCount++;
            pushed.add(f);
          } else break;
        }
      }
    }
  }

  // 3. Call-site excerpts for defined symbols. Changed files are never caller
  // candidates (their content is already in the prompt or the diff); each file
  // is emitted at most once.
  if (changedContents.size > 0) {
    const candidates = all
      .filter((f) => !changedContents.has(f) && !pushed.has(f))
      .slice(0, 400);
    const emitted = new Set<string>();
    const fileContents = new Map<string, string>();
    for (const content of changedContents.values()) {
      for (const name of extractDefinedNames(content)) {
        const word = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
        for (const other of candidates) {
          if (emitted.has(other)) continue;
          let otherContent = fileContents.get(other);
          if (otherContent === undefined) {
            otherContent = readCapped(input.repoRoot, other, 60000) ?? "";
            fileContents.set(other, otherContent);
          }
          const hits = findCodeMatches(otherContent, word, 2);
          if (hits.length > 0) {
            const excerpt = excerptAround(otherContent, hits[0]);
            if (push(`--- callers of ${name} in ${other} ---\n${excerpt}`)) {
              callerCount++;
              emitted.add(other);
            } else break;
          }
          if (callerCount >= 12) break;
        }
        if (used >= budget || callerCount >= 12) break;
      }
      if (used >= budget || callerCount >= 12) break;
    }
  }

  let stats = `context: ${fullCount} full files, ${extraCount} extra files, ${callerCount} caller excerpts, ${used}/${budget} chars`;
  if (warnings.length > 0) {
    stats += `; warnings: ${warnings.join("; ")}`;
    for (const w of warnings) core.warning(`context: ${w}`);
  }
  core.info(stats);
  if (parts.length === 0) return { block: "", stats };
  return { block: `<context>\n${parts.join("\n\n")}\n</context>`, stats };
}
