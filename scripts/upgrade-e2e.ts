#!/usr/bin/env bun
/**
 * Upgrade check on a real database file, across real installed versions.
 *
 *   bun scripts/upgrade-e2e.ts [--from 3.34.0] [--to local|<version>] [--keep]
 *
 * 1. Installs the old version from npm in its own folder and builds a database
 *    with it the way apps do: relations, timestamps, soft deletes, JSON,
 *    dates, booleans, enums, optional fields, a soft-deleted row.
 * 2. Reads every table back through the old ORM.
 * 3. Opens the same file with the new version (this repository, or a version
 *    from npm), reads everything back through the new ORM and compares field
 *    by field; the raw SQLite rows must be unchanged by opening it.
 * 4. Writes with the new version (partial update keeps other fields, soft
 *    delete, restore, cascade) and checks the result.
 * 5. Two processes on the file: one listens with .on(), the other writes.
 * Prints PASS/FAIL per check; exit code 1 when any fails.
 */
import { spawnSync } from "bun";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const repo = path.resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const from = option("--from", "3.34.0");
const to = option("--to", "local");
const work = mkdtempSync(path.join(tmpdir(), "szo-upgrade-"));
const dbFile = path.join(work, "app.db").replace(/\\/g, "/");

function sh(cwd: string, cmd: string[]) {
  const r = spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const out = r.stdout.toString() + r.stderr.toString();
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} (in ${cwd}) failed:\n${out}`);
  return r.stdout.toString();
}
function install(dir: string, version: string) {
  mkdirSync(dir, { recursive: true });
  if (version === "local") {
    // The package entry is dist/: build it so "local" means the working tree.
    sh(repo, ["bun", "run", "build"]);
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "e2e", private: true, type: "module" }));
    mkdirSync(path.join(dir, "node_modules"), { recursive: true });
    symlinkSync(repo, path.join(dir, "node_modules", "sqlite-zod-orm"), "junction");
  } else {
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "e2e", private: true, type: "module", dependencies: { "sqlite-zod-orm": version } }));
    sh(dir, ["bun", "install", "--no-cache"]);
  }
}

// The schema an app would have. Written once, run by both versions.
const SCHEMA = `
import { Database, z } from "sqlite-zod-orm";
export const open = (file, extra = {}) => new Database(file, {
  users: z.object({
    name: z.string(),
    email: z.string(),
    score: z.number().default(0),
    active: z.boolean().default(true),
    role: z.enum(["admin", "member"]).default("member"),
    bio: z.string().optional(),
    joined: z.date(),
    settings: z.object({ theme: z.string(), tags: z.array(z.string()) }),
  }),
  posts: z.object({
    title: z.string(),
    body: z.string(),
    rating: z.number().optional(),
    published: z.boolean().default(false),
    user_id: z.number(),
  }),
  comments: z.object({
    text: z.string(),
    post_id: z.number(),
  }),
}, {
  relations: { posts: { user_id: "users" }, comments: { post_id: "posts" } },
  cascade: { posts: ["comments"] },
  timestamps: true,
  softDeletes: true,
  ...extra,
});
const plain = (v) => v instanceof Date ? { $date: v.toISOString() } : typeof v === "bigint" ? { $bigint: String(v) }
  : Array.isArray(v) ? v.map(plain) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x !== "function").map(([k, x]) => [k, plain(x)])) : v;
export const readAll = (db) => ({
  users: db.users.select().orderBy("id").all().map(plain),
  posts: db.posts.select().orderBy("id").all().map(plain),
  comments: db.comments.select().orderBy("id").all().map(plain),
});
`;
const CREATE = `
import { open, readAll } from "./schema.mjs";
const db = open(${JSON.stringify(dbFile)});
const ada = db.users.insert({ name: "Ada", email: "ada@example.com", score: 42.5, joined: new Date("2024-02-29T12:34:56.789Z"), settings: { theme: "dark", tags: ["a", "b"] }, bio: "line1\\nline2 'quoted' \\"double\\" 🚀" });
const bob = db.users.insert({ name: "Bob", email: "bob@example.com", active: false, role: "admin", joined: new Date("2020-01-01T00:00:00.000Z"), settings: { theme: "light", tags: [] } });
const gone = db.users.insert({ name: "Gone", email: "gone@example.com", joined: new Date(0), settings: { theme: "x", tags: ["z"] } });
for (let i = 0; i < 20; i++) {
  const p = db.posts.insert({ title: "Post " + i, body: "Body " + i, rating: i % 3 === 0 ? undefined : i / 4, published: i % 2 === 0, user_id: i % 2 ? ada.id : bob.id });
  for (let j = 0; j < 3; j++) db.comments.insert({ text: "c" + i + "-" + j, post_id: p.id });
}
db.posts.insert({ title: "by gone", body: "x", user_id: gone.id });
db.users.delete(gone.id);
db.users.update(bob.id, { score: 7 });
console.log(JSON.stringify(readAll(db)));
db.close();
`;
const READ = `
import { open, readAll } from "./schema.mjs";
const db = open(${JSON.stringify(dbFile)});
console.log(JSON.stringify(readAll(db)));
db.close();
`;
const RAW = `
import { Database } from "bun:sqlite";
const db = new Database(${JSON.stringify(dbFile)}, { readonly: true });
const out = {};
for (const { name } of db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_changes' ORDER BY name").all())
  out[name] = db.query('SELECT * FROM "' + name + '" ORDER BY rowid').all();
out.__schema = db.query("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
console.log(JSON.stringify(out));
db.close();
`;
const WRITE = `
import { open, readAll } from "./schema.mjs";
const db = open(${JSON.stringify(dbFile)});
const fail = (m) => { console.log(JSON.stringify({ error: m })); process.exit(0); };
const ada = db.users.select().where({ email: "ada@example.com" }).get();
db.users.update(ada.id, { score: 99 });
const after = db.users.select().where({ id: ada.id }).get();
if (after.score !== 99) fail("partial update did not set score");
if (after.name !== "Ada" || after.settings.theme !== "dark" || after.bio !== ada.bio || after.joined.getTime() !== ada.joined.getTime()) fail("partial update changed other fields: " + JSON.stringify(after));
const before = db.comments.select().all().length;
const post = db.posts.select().where({ title: "Post 1" }).get();
db.posts.delete(post.id);
const hidden = db.comments.select().all().length;
db.posts.restore(post.id);
const back = db.comments.select().all().length;
const gone = db.users.select().where({ email: "gone@example.com" }).get();
const trashed = db.users.select().withTrashed ? db.users.select().withTrashed().where({ email: "gone@example.com" }).get() : "n/a";
const range = db.posts.select().where({ rating: { $gte: 1, $lt: 3 } }).all().length;
const bulk = db.posts.update({ published: true }).where({ rating: { $gte: 1, $lt: 3 } }).exec();
console.log(JSON.stringify({ commentsBefore: before, commentsWhilePostDeleted: hidden, commentsAfterRestore: back,
  goneVisible: !!gone, goneTrashedVisible: trashed === "n/a" ? "n/a" : !!trashed, range, bulk: typeof bulk === "number" ? bulk : bulk?.changes ?? bulk }));
db.close();
`;
const LISTEN = `
import { open } from "./schema.mjs";
const db = open(${JSON.stringify(dbFile)}, { pollInterval: 10 });
const seen = [];
db.comments.on("insert", (row) => seen.push(row.id));
console.log("ready");
const end = Date.now() + 8000;
while (seen.length < 50 && Date.now() < end) await Bun.sleep(20);
console.log(JSON.stringify({ seen: seen.length }));
db.close();
process.exit(0);
`;
const BURST = `
import { open } from "./schema.mjs";
const db = open(${JSON.stringify(dbFile)});
const post = db.posts.select().where({ title: "Post 2" }).get();
for (let i = 0; i < 50; i++) { db.comments.insert({ text: "live " + i, post_id: post.id }); await Bun.sleep(2); }
db.close();
`;

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
function check(name: string, ok: boolean, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail.split("\n")[0]!.slice(0, 160)})` : ""}`);
}
function diff(a: any, b: any, at = ""): string[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) === !Array.isArray(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    return keys.flatMap((k) => diff(a[k], b[k], `${at}.${k}`));
  }
  return [`${at}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`];
}

const oldDir = path.join(work, "old"), newDir = path.join(work, "new");
console.log(`work: ${work}\nold: sqlite-zod-orm@${from}; new: ${to === "local" ? `this repository (${JSON.parse(await Bun.file(path.join(repo, "package.json")).text()).version})` : to}`);
install(oldDir, from);
install(newDir, to);
for (const dir of [oldDir, newDir]) {
  for (const [file, code] of Object.entries({ "schema.mjs": SCHEMA, "create.mjs": CREATE, "read.mjs": READ, "raw.mjs": RAW, "write.mjs": WRITE, "listen.mjs": LISTEN, "burst.mjs": BURST }))
    writeFileSync(path.join(dir, file), code);
}
const json = (dir: string, file: string) => JSON.parse(sh(dir, ["bun", file]).trim().split("\n").pop()!);

let created: any, oldRead: any, rawBefore: any;
try {
  created = json(oldDir, "create.mjs");
  oldRead = json(oldDir, "read.mjs");
  rawBefore = json(oldDir, "raw.mjs");
  check(`old version ${from} builds the database`, true, `${created.users.length} users, ${created.posts.length} posts, ${created.comments.length} comments visible`);
} catch (e) {
  check(`old version ${from} builds the database`, false, String(e));
  process.exit(1);
}

let newRead: any;
try {
  newRead = json(newDir, "read.mjs");
  check("new version opens the old file", true);
} catch (e) {
  check("new version opens the old file", false, String(e));
  process.exit(1);
}
const rawAfter = json(newDir, "raw.mjs");
const rawDataDiff = diff({ ...rawBefore, __schema: undefined }, { ...rawAfter, __schema: undefined });
check("opening does not change any stored row", rawDataDiff.length === 0, rawDataDiff.slice(0, 8).join("\n"));
const schemaDiff = diff(rawBefore.__schema, rawAfter.__schema);
check("schema changes on open (listed, not a failure)", true, schemaDiff.length ? `${schemaDiff.length} change(s): ${schemaDiff.slice(0, 3).join("; ")}` : "none");
const readDiff = diff(oldRead, newRead);
check("every field reads back the same as with the old version", readDiff.length === 0, readDiff.slice(0, 10).join("\n"));
check("soft-deleted user stays hidden", !newRead.users.some((u: any) => u.email === "gone@example.com"));
const ada = newRead.users.find((u: any) => u.name === "Ada");
check("types survive: date, boolean, JSON, unicode text",
  ada?.joined?.$date === "2024-02-29T12:34:56.789Z" && ada?.active === true && ada?.settings?.tags?.join() === "a,b" && ada?.bio?.includes("🚀"),
  JSON.stringify(ada).slice(0, 200));

const w = json(newDir, "write.mjs");
check("partial update keeps the other fields", !w.error, w.error ?? "score set, name/settings/bio/joined unchanged");
if (!w.error) {
  check("soft delete hides a post's comments; restore brings them back", w.commentsWhilePostDeleted === w.commentsBefore - 3 && w.commentsAfterRestore === w.commentsBefore, `${w.commentsBefore} -> ${w.commentsWhilePostDeleted} -> ${w.commentsAfterRestore}`);
  check("range filter and ranged bulk update agree", w.range === w.bulk, `select ${w.range}, bulk update ${w.bulk}`);
}

// Two processes on one file.
const listener = Bun.spawn(["bun", "listen.mjs"], { cwd: newDir, stdout: "pipe", stderr: "pipe" });
const reader = listener.stdout.getReader();
let buffer = "";
while (!buffer.includes("ready")) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += new TextDecoder().decode(value);
}
sh(newDir, ["bun", "burst.mjs"]);
while (true) { const { value, done } = await reader.read(); if (done) break; buffer += new TextDecoder().decode(value); }
await listener.exited;
const live = JSON.parse(buffer.trim().split("\n").pop() ?? "{}");
check("a second process's 50 inserts reach .on() listeners", live.seen === 50, `${live.seen ?? "no"} events; stderr: ${(await new Response(listener.stderr).text()).slice(0, 200)}`);

// Downgrade: can the old version still read the file after the new one wrote to it?
try {
  json(oldDir, "read.mjs");
  check("old version still opens the file afterwards (informational)", true);
} catch (e) {
  check("old version still opens the file afterwards (informational)", true, `no: ${String(e).split("\n").slice(1, 3).join(" ")}`);
}

const failed = checks.filter((c) => !c.ok);
writeFileSync(path.join(work, "result.json"), JSON.stringify({ from, to, checks, readDiff, schemaDiff }, null, 2));
console.log(`\n${checks.length - failed.length}/${checks.length} pass (${from} -> ${to}); details: ${path.join(work, "result.json")}`);
if (!args.includes("--keep") && failed.length === 0) try { rmSync(work, { recursive: true, force: true }); } catch {}
process.exit(failed.length ? 1 : 0);
