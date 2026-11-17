import { expect, test } from "bun:test";
import { join } from "node:path";
import { checkSource, upgradeCheck } from "../src/upgrade-check";

const app = join(import.meta.dir, "fixtures", "upgrade-app");

test("finds every affected pattern in the fixture app, and nothing in the clean file", () => {
  const findings = upgradeCheck(app);
  const bySection = (n: number) => findings.filter((f) => f.section === n).map((f) => `${f.file}:${f.line}`);
  expect(findings.every((f) => f.file === "src/db.ts")).toBe(true);
  expect(bySection(12)).toEqual(["src/db.ts:12"]);
  expect(bySection(13)).toEqual(["src/db.ts:17"]);
  expect(bySection(11)).toEqual(["src/db.ts:23", "src/db.ts:29"]);
  expect(bySection(18)).toEqual(["src/db.ts:24", "src/db.ts:28"]);
  expect(bySection(16)).toEqual(["src/db.ts:32"]);
  expect(bySection(17)).toEqual(["src/db.ts:31"]);
  expect(bySection(19)).toEqual(["src/db.ts:5"]);
  expect(findings.filter((f) => f.severity === "error")).toHaveLength(5);
});

test("plain 4.0-compatible code produces no findings", () => {
  const code = `import { Database, z } from "sqlite-zod-orm";
const db = new Database("a.db", { users: z.object({ name: z.string() }) }, { hooks: { users: { afterInsert: async () => {} } } });
db.transaction(() => { db.users.insert({ name: "a" }); });
db.users.select().where({ name: "a" }).orderBy("name", "desc").all();
db.users.select("name").groupBy("name").countGrouped();`;
  expect(checkSource("ok.ts", code)).toEqual([]);
});

test("the CLI exits 1 when something must change and prints JSON on request", async () => {
  const run = Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "upgrade-check", app, "--json"]);
  expect(run.exitCode).toBe(1);
  const parsed = JSON.parse(new TextDecoder().decode(run.stdout));
  expect(parsed.length).toBe(12);
});
