import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
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
      const rel = path.relative(process.cwd(), full).replace(/\\/g, "/");
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

function readCapped(file: string, cap: number): string | null {
  try {
    const content = readFileSync(file, "utf8");
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
  const parts: string[] = [];
  let used = 0;
  const budget = input.maxContextChars;
  const push = (text: string): boolean => {
    if (used + text.length > budget) return false;
    parts.push(text);
    used += text.length;
    return true;
  };

  let fullCount = 0;
  let extraCount = 0;
  let callerCount = 0;

  // 1. Full content of changed in-scope files.
  const changedContents = new Map<string, string>();
  if (input.includeFullFiles) {
    for (const f of input.scopedFiles) {
      const content = readCapped(f, 12000);
      if (content === null) continue;
      changedContents.set(f, content);
      if (push(`--- full file: ${f} ---\n${content}`)) fullCount++;
      else break;
    }
  } else {
    for (const f of input.scopedFiles) {
      const content = readCapped(f, 12000);
      if (content !== null) changedContents.set(f, content);
    }
  }

  // 2. Extra context_files globs.
  if (input.contextFiles.length > 0) {
    const all = walkFiles(input.repoRoot, input.ignore);
    const matched = all.filter(
      (f) => matchesAny(f, input.contextFiles) && !changedContents.has(f)
    );
    for (const f of matched.slice(0, 10)) {
      const content = readCapped(f, 8000);
      if (content === null) continue;
      if (push(`--- context file: ${f} ---\n${content}`)) extraCount++;
      else break;
    }
  }

  // 3. Call-site excerpts for defined symbols (outside their own file).
  if (changedContents.size > 0) {
    const all = walkFiles(input.repoRoot, input.ignore);
    const candidates = all.filter((f) => !changedContents.has(f)).slice(0, 400);
    const fileContents = new Map<string, string>();
    for (const [file, content] of changedContents) {
      for (const name of extractDefinedNames(content)) {
        const word = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
        for (const other of candidates) {
          let otherContent = fileContents.get(other);
          if (otherContent === undefined) {
            otherContent = readCapped(other, 60000) ?? "";
            fileContents.set(other, otherContent);
          }
          const idx = otherContent.search(word);
          if (idx >= 0 && other !== file) {
            const excerpt = excerptAround(otherContent, idx);
            if (push(`--- callers of ${name} in ${other} ---\n${excerpt}`)) callerCount++;
            else break;
          }
          if (callerCount >= 12) break;
        }
        if (used >= budget || callerCount >= 12) break;
      }
      if (used >= budget || callerCount >= 12) break;
    }
  }

  const stats = `context: ${fullCount} full files, ${extraCount} extra files, ${callerCount} caller excerpts, ${used}/${budget} chars`;
  core.info(stats);
  if (parts.length === 0) return { block: "", stats };
  return { block: `<context>\n${parts.join("\n\n")}\n</context>`, stats };
}
