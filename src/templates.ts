import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";
import * as YAML from "yaml";
import * as core from "@actions/core";
import { logInfo } from "./logger.js";
import { OpenReviewConfig, type OpenReviewConfig as Config } from "./config.js";

type PartialConfig = Partial<{
  [K in keyof Config]: Config[K] | undefined;
}>;

export type ResolvedTemplate = {
  source: string;
  sha: string | null; // commit SHA for remote refs; null for local/built-in
  config: PartialConfig;
};

export type TemplateContext = {
  actionDir: string; // dir containing templates/ (GITHUB_ACTION_PATH at runtime)
  configDir: string; // dir of the config file being resolved
  env: NodeJS.ProcessEnv;
};

export function templateContextFor(configPath: string, env: NodeJS.ProcessEnv): TemplateContext {
  const fromAction = env["GITHUB_ACTION_PATH"];
  // Fallback when GITHUB_ACTION_PATH is unset (local validate): the entry file is
  // always dist/index.js or dist-src/<entry>.js, so repo root is one level up.
  // (Deliberately argv-based, not import.meta: keeps the ncc bundle single-file.)
  const fromEntry = process.argv[1]
    ? path.resolve(path.dirname(process.argv[1]), "..")
    : process.cwd();
  return {
    actionDir: fromAction || fromEntry,
    configDir: path.dirname(path.resolve(configPath)),
    env,
  };
}

function parsePartial(raw: unknown): PartialConfig {
  // Templates are full-shaped configs; validate loosely here, strictly after merge.
  return OpenReviewConfig.deepPartial().parse(raw) as PartialConfig;
}

export type { PartialConfig };

export function parseConfigLoose(raw: unknown): PartialConfig {
  return parsePartial(raw);
}

async function loadYamlFile(file: string): Promise<unknown> {
  return YAML.parse(await readFile(file, "utf8"));
}

function builtinPath(ctx: TemplateContext, name: string): string | null {
  if (!/^[a-z0-9-]+$/.test(name)) return null;
  for (const ext of ["yml", "yaml"]) {
    const p = path.join(ctx.actionDir, "templates", `${name}.${ext}`);
    if (existsSync(p)) return p;
  }
  return null;
}

function localPath(ctx: TemplateContext, ref: string): string {
  const rel = ref.replace(/^file:/, "");
  return path.resolve(ctx.configDir, rel);
}

const GITHUB_REF = /^github:([^/\s]+)\/([^/\s@]+)(?:\/([^@\s]+))?@(.+)$/;

async function fetchRemote(
  owner: string,
  repo: string,
  filePath: string,
  sha: string,
  ctx: TemplateContext
): Promise<unknown> {
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${sha}/${filePath}`;
  const headers: Record<string, string> = {
    "user-agent": "OpenReview/1.0 (github-action)",
    accept: "text/plain",
  };
  const token =
    ctx.env["INPUT_GITHUB-TOKEN"] || ctx.env["GITHUB_TOKEN"] || ctx.env["GH_TOKEN"];
  if (token) headers["authorization"] = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (!res.ok)
    throw new Error(`template fetch failed ${res.status} for ${owner}/${repo}@${sha.slice(0, 7)}/${filePath}`);
  return YAML.parse(await res.text());
}

/** Resolve one extends entry to a partial config (no recursion here; caller loops). */
async function resolveOne(
  entry: string,
  ctx: TemplateContext
): Promise<ResolvedTemplate> {
  // Built-in: openreview/<name>[@<version>] (version informational; ships with the action)
  const builtin = /^openreview[/:]([^@\s]+)(?:@(\S+))?$/.exec(entry);
  if (builtin) {
    const file = builtinPath(ctx, builtin[1]);
    if (!file) throw new Error(`unknown built-in template '${builtin[1]}' (see templates/ + docs)`);
    logInfo(`Template ${entry}: built-in ${file}`);
    return { source: entry, sha: null, config: parsePartial(await loadYamlFile(file)) };
  }
  // Remote: github:owner/repo[/path]@sha:<hex>|@<40-hex> (immutable pin REQUIRED)
  const gh = GITHUB_REF.exec(entry);
  if (gh) {
    const [, owner, repo, p, ref] = gh;
    const sha = ref.replace(/^sha:/, "");
    if (!/^[0-9a-f]{40}$/i.test(sha)) {
      throw new Error(
        `template '${entry}': remote refs must pin an immutable commit SHA (@sha:<40-hex>). Branch tags auto-update and would silently change your reviews.`
      );
    }
    const filePath = p || "openreview-template.yml";
    logInfo(`Template ${entry}: remote ${owner}/${repo}@${sha.slice(0, 7)}/${filePath}`);
    return { source: entry, sha, config: parsePartial(await fetchRemote(owner, repo, filePath, sha, ctx)) };
  }
  // Local file: ./x.yml, ../x.yml, /abs/x.yml, file:x.yml
  if (/^(\.|file:|\/)/.test(entry)) {
    const file = localPath(ctx, entry);
    if (!existsSync(file)) throw new Error(`template file not found: ${file} (from '${entry}')`);
    logInfo(`Template ${entry}: local ${file}`);
    return { source: entry, sha: null, config: parsePartial(await loadYamlFile(file)) };
  }
  throw new Error(
    `template '${entry}': unknown form. Use openreview:<name>[@v], github:<owner>/<repo>[/path]@sha:<hex>, or ./local.yml`
  );
}

/** Merge overlay onto base. Child wins; reviews merge by id; arrays replace. */
export function mergeConfigs(base: PartialConfig, over: PartialConfig): PartialConfig {
  const mergedReviews = [...(base.reviews ?? [])];
  for (const r of over.reviews ?? []) {
    const i = mergedReviews.findIndex((x) => x.id === r.id);
    if (i >= 0) mergedReviews[i] = r;
    else mergedReviews.push(r);
  }
  return {
    version: over.version ?? base.version,
    requires_action: over.requires_action ?? base.requires_action,
    defaults: { ...(base.defaults ?? {}), ...(over.defaults ?? {}) },
    providers: { ...(base.providers ?? {}), ...(over.providers ?? {}) },
    reviews: mergedReviews.length > 0 ? mergedReviews : base.reviews ?? over.reviews,
    global_verdict: { ...(base.global_verdict ?? {}), ...(over.global_verdict ?? {}) },
  } as PartialConfig;
}

const MAX_DEPTH = 5;

/**
 * Resolve an extends chain (in order) into one merged partial config.
 * Templates may nest (depth ≤ 5); cycles and repeat visits are rejected.
 */
export async function resolveExtends(
  entries: string[],
  ctx: TemplateContext,
  seen: string[] = [],
  depth = 0
): Promise<{ merged: PartialConfig; sources: ResolvedTemplate[] }> {
  if (depth > MAX_DEPTH) throw new Error("template extends nesting too deep (max 5)");
  let merged: PartialConfig = {};
  const sources: ResolvedTemplate[] = [];
  for (const entry of entries) {
    if (seen.includes(entry)) throw new Error(`template extends cycle detected at '${entry}'`);
    const resolved = await resolveOne(entry, ctx);
    sources.push(resolved);
    const nested = resolved.config.extends as string[] | undefined;
    if (nested && nested.length > 0) {
      const inner = await resolveExtends(nested, ctx, [...seen, entry], depth + 1);
      sources.push(...inner.sources);
      merged = mergeConfigs(merged, inner.merged);
    }
    const { extends: _ignored, ...rest } = resolved.config;
    merged = mergeConfigs(merged, rest);
  }
  return { merged, sources };
}
