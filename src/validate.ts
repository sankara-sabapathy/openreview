import { readFile } from "node:fs/promises";
import * as YAML from "yaml";
import { parseConfig } from "./config.js";
import { templateContextFor, resolveExtends, mergeConfigs, parseConfigLoose } from "./templates.js";

const file = process.argv[2] ?? ".github/openreview.yml";
const raw = YAML.parse(await readFile(file, "utf8"));
const loose = parseConfigLoose(raw);
const extendsEntries = (loose.extends as string[] | undefined) ?? [];
let cfg;
if (extendsEntries.length === 0) {
  cfg = parseConfig(raw);
} else {
  const ctx = templateContextFor(file, process.env as any);
  const { merged, sources } = await resolveExtends(extendsEntries, ctx);
  const { extends: _ignored, ...top } = loose;
  cfg = parseConfig(mergeConfigs(merged, top) as unknown);
  console.log(
    `templates: ${sources.map((s) => (s.sha ? `${s.source} @${s.sha.slice(0, 7)}` : s.source)).join(", ")}`
  );
}
console.log(`OK: ${file} — version ${cfg.version}, ${cfg.reviews.length} review(s): ${cfg.reviews.map((r) => r.id).join(", ")}`);
for (const [name, p] of Object.entries(cfg.providers))
  console.log(`  provider ${name}: kind=${p.kind} model=${p.model}`);
