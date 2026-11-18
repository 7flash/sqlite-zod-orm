#!/usr/bin/env bun
/**
 * Type-check real apps against this working tree's types, without touching them.
 *
 *   bun scripts/typecheck-apps.ts <app dir>... [--out DIR]
 *
 * For each app: runs `tsc --noEmit` twice with a temporary tsconfig (in DIR,
 * never in the app) that extends the app's own tsconfig. First with the app's
 * installed sqlite-zod-orm (the baseline), then with `paths` pointing
 * "sqlite-zod-orm" at this repository's src/index.ts. Reports errors that
 * appear only with this tree's types, i.e. what an upgrade would break.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
/** tsconfig files are JSON with comments and trailing commas. */
const stripJsonComments = (text: string) =>
  text.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_m, str) => str ?? "").replace(/,(\s*[}\]])/g, "$1");
import { tmpdir } from "node:os";
import path from "node:path";

const repo = path.resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const out = outIndex >= 0 ? path.resolve(args[outIndex + 1]!) : mkdtempSync(path.join(tmpdir(), "szo-apps-"));
const apps = args.filter((a, i) => !a.startsWith("--") && i !== outIndex + 1 || outIndex < 0 && !a.startsWith("--"));
mkdirSync(out, { recursive: true });
const tsc = path.join(repo, "node_modules", "typescript", "bin", "tsc");
const slash = (p: string) => p.replace(/\\/g, "/");

function errors(app: string, mode: "installed" | "tree"): string[] {
  const name = `${path.basename(app)}-${mode}.json`;
  const config: any = {
    extends: slash(path.join(app, "tsconfig.json")),
    compilerOptions: { noEmit: true, skipLibCheck: true, incremental: false, tsBuildInfoFile: null },
  };
  // An app tsconfig without "include" means "everything next to it"; from
  // this temporary file that would be the wrong folder, so say it explicitly.
  const own = JSON.parse(stripJsonComments(readFileSync(path.join(app, "tsconfig.json"), "utf8")));
  if (!own.include && !own.files) {
    config.include = [slash(path.join(app, "**/*"))];
    config.exclude = ["node_modules", "dist", "build", ".tradjs"].map((d) => slash(path.join(app, d)));
  }
  if (mode === "tree") {
    config.compilerOptions.paths = { "sqlite-zod-orm": [slash(path.join(repo, "src", "index.ts"))] };
  }
  const file = path.join(out, name);
  writeFileSync(file, JSON.stringify(config, null, 2));
  const r = Bun.spawnSync(["bun", tsc, "-p", file], { cwd: app, stdout: "pipe", stderr: "pipe" });
  return (r.stdout.toString() + r.stderr.toString()).split(/\r?\n/).filter((l) => /error TS\d+/.test(l))
    // Errors inside this repository's own sources are not the app's.
    .filter((l) => !slash(l).includes(slash(repo)));
}

let broken = 0;
for (const app of apps.map((a) => path.resolve(a))) {
  const before = errors(app, "installed");
  const after = errors(app, "tree");
  // Same place and error code = the same error, even if the message names
  // types differently; the temporary config file's own name is not a place.
  const strip = (l: string) => (l.match(/^(.*?): error (TS\d+)/)?.slice(1, 3).join(" ") ?? l)
    .replace(/[\w.-]+-(?:installed|tree)\.json/, "config");
  const seen = new Map<string, number>();
  for (const l of before) seen.set(strip(l), (seen.get(strip(l)) ?? 0) + 1);
  const added = after.filter((l) => {
    const n = seen.get(strip(l)) ?? 0;
    if (n > 0) { seen.set(strip(l), n - 1); return false; }
    return true;
  });
  const fixed = before.length - (after.length - added.length);
  console.log(`${added.length ? "NEW ERRORS" : "ok"}  ${path.basename(app)}: ${before.length} errors with its installed version, ${after.length} with this tree (${added.length} new, ${fixed} gone)`);
  for (const l of added.slice(0, 25)) console.log(`    ${l.slice(0, 260)}`);
  if (added.length) broken++;
}
process.exit(broken ? 1 : 0);
