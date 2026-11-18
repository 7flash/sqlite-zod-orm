/**
 * Operation-level ORM overhead against handwritten bun:sqlite.
 *
 * Usage:
 *   bun bench/overhead.ts
 *   bun bench/overhead.ts --rows 1000 --out /tmp/overhead.json
 *   bun bench/overhead.ts --check bench/baseline.json
 *
 * Each row count is the size of the pre-seeded "posts" table. Both databases
 * are separate in-memory SQLite databases with the same schema, indexes,
 * trigger journal (when reactive), and data, seeded via raw SQL outside the
 * timers. Each side is exercised using its own statement/connection cache.
 * "ops/s" means logical row operations for insertMany (batch=N), and API
 * invocations for other cases. Timed ORM writes include their documented
 * validation and row return; raw SQL intentionally does neither.
 *
 * No deps beyond those already used by the project.
 */
import { Database as BunSqlite } from "bun:sqlite";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Database, z } from "../src/index";

const schemas = {
  users: z.object({ name: z.string() }),
  posts: z.object({
    user_id: z.number(),
    title: z.string(),
    score: z.number(),
    category: z.string(),
    meta: z.object({ source: z.string(), index: z.number() }),
    active: z.boolean(),
  }),
  comments: z.object({ post_id: z.number(), user_id: z.number(), body: z.string() }),
};
type Settings = { reactive: boolean; timestamps: boolean; softDeletes: boolean };
type Result = {
  key: string;
  rows: number;
  reactive: boolean;
  timestamps: boolean;
  softDeletes: boolean;
  operation: string;
  iterations: number;
  unitsPerIteration: number;
  unit: "ops" | "rows";
  ormMs: number;
  rawMs: number;
  ormOpsPerSecond: number;
  rawOpsPerSecond: number;
  ratio: number;
};
const counts = [1_000, 10_000, 100_000];
const args = process.argv.slice(2);
let rowCounts = counts;
let explicitRows = false;
let output = "bench/overhead-results.json";
let baseline: string | undefined;
for (let i = 0; i < args.length; i++) {
  const flag = args[i];
  if (flag === "--rows") {
    const value = args[++i];
    if (!value) throw new Error("--rows requires comma-separated positive integers");
    rowCounts = value.split(",").map(Number);
    explicitRows = true;
    if (rowCounts.some(n => !Number.isSafeInteger(n) || n < 1))
      throw new Error("--rows requires positive integers");
  } else if (flag === "--out") {
    output = args[++i] ?? (() => { throw new Error("--out requires a path"); })();
  } else if (flag === "--check") {
    baseline = args[++i] ?? (() => { throw new Error("--check requires a path"); })();
  } else {
    throw new Error(`Unknown flag: ${flag ?? ""}`);
  }
}
// A checked run compares exactly the row counts present in the supplied
// baseline unless --rows explicitly requests a broader scope. The 4.2.1
// baseline contains 1k and 10k; 100k is intentionally available for an
// unchecked exploratory run (or with its own measured baseline).
if (baseline && !explicitRows) {
  const reference = JSON.parse(readFileSync(baseline, "utf8")) as {
    results?: { rows: number }[];
  };
  if (Array.isArray(reference.results) && reference.results.length) {
    rowCounts = [...new Set(reference.results.map((result) => result.rows))].sort((a, b) => a - b);
  }
}
const ISO = "2026-01-01T00:00:00.000Z";
const now = () => performance.now();
const choose = (n: number, max: number) => Math.min(n, max);
const post = (i: number) => ({
  user_id: i % 256 + 1,
  title: `post-${i}`,
  score: i % 1_000,
  category: `c${i % 4}`,
  meta: { source: "tick", index: i },
  active: (i % 2) === 0,
});
const postArgs = (i: number, opts: Settings) => {
  const item = post(i);
  return [
    item.user_id, item.title, item.score, item.category,
    JSON.stringify(item.meta), Number(item.active),
    ...(opts.timestamps ? [ISO, ISO] : []),
  ];
};
const live = (opts: Settings, alias = "") =>
  opts.softDeletes ? ` AND ${alias}"deletedAt" IS NULL` : "";

function createRaw(opts: Settings): BunSqlite {
  const db = new BunSqlite(":memory:");
  const suffix = `${opts.timestamps ? ', "createdAt" TEXT, "updatedAt" TEXT' : ""}${opts.softDeletes ? ', "deletedAt" TEXT' : ""}`;
  db.run(`CREATE TABLE "users" (id INTEGER PRIMARY KEY AUTOINCREMENT, "name" TEXT${suffix})`);
  db.run(`CREATE TABLE "posts" (id INTEGER PRIMARY KEY AUTOINCREMENT, "user_id" INTEGER, "title" TEXT, "score" INTEGER, "category" TEXT, "meta" TEXT, "active" INTEGER${suffix}, FOREIGN KEY ("user_id") REFERENCES "users"(id) ON DELETE SET NULL)`);
  db.run(`CREATE TABLE "comments" (id INTEGER PRIMARY KEY AUTOINCREMENT, "post_id" INTEGER, "user_id" INTEGER, "body" TEXT${suffix}, FOREIGN KEY ("post_id") REFERENCES "posts"(id) ON DELETE SET NULL, FOREIGN KEY ("user_id") REFERENCES "users"(id) ON DELETE SET NULL)`);
  db.run('CREATE INDEX "idx_posts_score" ON "posts" ("score")');
  db.run('CREATE INDEX "idx_posts_user_id" ON "posts" ("user_id")');
  db.run('CREATE INDEX "idx_comments_post_id" ON "comments" ("post_id")');
  db.run("PRAGMA foreign_keys = ON");
  if (opts.reactive) {
    db.run('CREATE TABLE "_changes" (id INTEGER PRIMARY KEY AUTOINCREMENT, tbl TEXT NOT NULL, op TEXT NOT NULL, row_id INTEGER NOT NULL)');
    for (const table of ["users", "posts", "comments"]) {
      for (const [op, row] of [["insert", "NEW"], ["update", "NEW"], ["delete", "OLD"]] as const) {
        db.run(`CREATE TRIGGER "_trg_${table}_${op}" AFTER ${op.toUpperCase()} ON "${table}"
          BEGIN INSERT INTO "_changes" (tbl, op, row_id) VALUES ('${table}', '${op}', ${row}.id); END`);
      }
    }
  }
  return db;
}

function seed(db: BunSqlite, size: number, opts: Settings): void {
  const timeCols = opts.timestamps ? ', "createdAt", "updatedAt"' : "";
  const timeArgs = opts.timestamps ? ", ?, ?" : "";
  const user = db.prepare(`INSERT INTO users ("name"${timeCols}) VALUES (?${timeArgs})`);
  const article = db.prepare(
    `INSERT INTO posts ("user_id", "title", "score", "category", "meta", "active"${timeCols}) VALUES (?, ?, ?, ?, ?, ?${timeArgs})`,
  );
  const comment = db.prepare(
    `INSERT INTO comments ("post_id", "user_id", "body"${timeCols}) VALUES (?, ?, ?${timeArgs})`,
  );
  const tx = db.transaction(() => {
    for (let i = 1; i <= 256; i++)
      user.run(`user-${i}`, ...(opts.timestamps ? [ISO, ISO] : []));
    for (let i = 0; i < size; i++) {
      article.run(...postArgs(i, opts));
      if (i % 8 === 0)
        comment.run(i + 1, i % 256 + 1, `comment-${i}`, ...(opts.timestamps ? [ISO, ISO] : []));
    }
  });
  tx();
}

// Handwritten SQL is also prepared once per distinct SQL text, just like
// the ORM's existing per-connection statement cache.
const rawStatementCaches = new WeakMap<BunSqlite, Map<string, ReturnType<BunSqlite["prepare"]>>>();
function rawStmt(db: BunSqlite, sql: string): ReturnType<BunSqlite["prepare"]> {
  let statements = rawStatementCaches.get(db);
  if (!statements) {
    statements = new Map();
    rawStatementCaches.set(db, statements);
  }
  let stmt = statements.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    statements.set(sql, stmt);
  }
  return stmt;
}

function selectIn(db: BunSqlite, table: string, fk: string, ids: number[], opts: Settings) {
  const rows: Record<string, any>[] = [];
  for (let offset = 0; offset < ids.length; offset += 900) {
    const batch = ids.slice(offset, offset + 900);
    const placeholders = batch.map(() => "?").join(", ");
    rows.push(...rawStmt(db,
      `SELECT * FROM "${table}" WHERE "${fk}" IN (${placeholders})${live(opts)} ORDER BY "id"`,
    ).all(...batch) as Record<string, any>[]);
  }
  return rows;
}
function rawWith(db: BunSqlite, opts: Settings, levels: 1 | 2): any[] {
  const parents = rawStmt(db, `SELECT * FROM "users" WHERE "id" <= ?${live(opts)}`).all(12) as any[];
  const children = selectIn(db, "posts", "user_id", parents.map(r => r.id), opts);
  const byUser = new Map<number, any[]>();
  for (const child of children) {
    if (!byUser.has(child.user_id)) byUser.set(child.user_id, []);
    byUser.get(child.user_id)!.push(child);
  }
  for (const parent of parents) parent.posts = byUser.get(parent.id) ?? [];
  if (levels === 2) {
    const comments = selectIn(db, "comments", "post_id", children.map(r => r.id), opts);
    const byPost = new Map<number, any[]>();
    for (const comment of comments) {
      if (!byPost.has(comment.post_id)) byPost.set(comment.post_id, []);
      byPost.get(comment.post_id)!.push(comment);
    }
    for (const child of children) child.comments = byPost.get(child.id) ?? [];
  }
  return parents;
}
function sample(iterations: number, task: (index: number) => unknown, warm = true, rounds = 1): number {
  if (warm) task(0); // statement warm-up; both sides do the same work
  const elapsed: number[] = [];
  for (let round = 0; round < rounds; round++) {
    const start = now();
    for (let i = 0; i < iterations; i++) task(i);
    elapsed.push(Math.max(now() - start, 0.000001));
  }
  elapsed.sort((a, b) => a - b);
  return elapsed[Math.floor(elapsed.length / 2)]!;
}
function keyFor(r: Pick<Result, "rows" | "reactive" | "timestamps" | "softDeletes" | "operation">): string {
  return `${r.rows}|reactive=${Number(r.reactive)}|timestamps=${Number(r.timestamps)}|softDeletes=${Number(r.softDeletes)}|${r.operation}`;
}

const results: Result[] = [];
const header = [
  "rows".padStart(7), "react".padEnd(5), "ts/soft".padEnd(7),
  "operation".padEnd(19), "ORM ops/s".padStart(13),
  "raw ops/s".padStart(13), "ORM/raw".padStart(9),
].join(" | ");
console.log(header);
console.log("-".repeat(header.length));

for (const rows of rowCounts) {
  for (const reactive of [false, true]) {
    for (const withFlags of [false, true]) {
      const opts: Settings = { reactive, timestamps: withFlags, softDeletes: withFlags };
      const orm = new Database(":memory:", schemas, {
        ...opts, relations: { posts: { user_id: "users" }, comments: { post_id: "posts", user_id: "users" } },
        indexes: { posts: ["score", "user_id"], comments: ["post_id"] },
      });
      const raw = createRaw(opts);
      try {
        // Use the actual ORM connection for raw seeding, so both datasets
        // include the same trigger overhead but no ORM validation.
        seed((orm as any)._ctx.db as BunSqlite, rows, opts);
        seed(raw, rows, opts);
        const o = orm as any;
        const mainWhere = ` WHERE "id" = ?${opts.softDeletes ? ' AND "deletedAt" IS NULL' : ""}`;
        const rawGet = raw.prepare(`SELECT * FROM "posts"${mainWhere}`);
        const rawRange = raw.prepare(
          `SELECT * FROM "posts" WHERE "score" >= ? AND "score" < ?${live(opts)}`,
        );
        const rawCount = raw.prepare(`SELECT COUNT(*) AS n FROM "posts"${opts.softDeletes ? ' WHERE "deletedAt" IS NULL' : ""}`);
        const rawPluck = raw.prepare(`SELECT "score" FROM "posts"${opts.softDeletes ? ' WHERE "deletedAt" IS NULL' : ""}`);
        const rawUpdate = raw.prepare(`UPDATE "posts" SET "title" = ?${opts.timestamps ? ', "updatedAt" = ?' : ""} WHERE "id" = ?${opts.softDeletes ? ' AND "deletedAt" IS NULL' : ""}`);
        const rawBulk = raw.prepare(`UPDATE "posts" SET "title" = ?${opts.timestamps ? ', "updatedAt" = ?' : ""} WHERE "score" >= ? AND "score" < ?${live(opts)}`);
        const rawChanges = raw.prepare("SELECT changes() AS n");
        const rawDelete = raw.prepare(opts.softDeletes
          ? 'UPDATE "posts" SET "deletedAt" = ? WHERE "id" = ? AND "deletedAt" IS NULL'
          : 'DELETE FROM "posts" WHERE "id" = ?');
        const insertCols = `"user_id", "title", "score", "category", "meta", "active"${opts.timestamps ? ', "createdAt", "updatedAt"' : ""}`;
        const bindCount = opts.timestamps ? 8 : 6;
        const rawInsert = raw.prepare(`INSERT INTO "posts" (${insertCols}) VALUES (${Array(bindCount).fill("?").join(", ")})`);
        const rawUpsert = raw.prepare(
          `INSERT INTO "posts" ("id", ${insertCols}) VALUES (?, ${Array(bindCount).fill("?").join(", ")}) ON CONFLICT("id") DO UPDATE SET "title" = excluded."title"${opts.timestamps ? ', "updatedAt" = excluded."updatedAt"' : ""}`,
        );

        function record(
          operation: string, iterations: number, ormFn: (i: number) => unknown,
          rawFn: (i: number) => unknown, unitsPerIteration = 1, warm = true,
        ): void {
          // Repeat non-mutating reads; mutations deliberately execute once
          // so delete/insert semantics and table sizes remain comparable.
          const readOnly = new Set([
            "get(id)", "select.where(range)", "with(one level)",
            "with(two levels)", "count", "pluck",
          ]).has(operation);
          const rounds = readOnly ? 3 : 1;
          const ormMs = sample(iterations, ormFn, warm, rounds);
          const rawMs = sample(iterations, rawFn, warm, rounds);
          const ops = iterations * unitsPerIteration;
          const ormOpsPerSecond = ops * 1000 / ormMs;
          const rawOpsPerSecond = ops * 1000 / rawMs;
          const result: Result = {
            key: "", rows, ...opts, operation, iterations, unitsPerIteration,
            unit: unitsPerIteration === 1 ? "ops" : "rows",
            ormMs, rawMs, ormOpsPerSecond, rawOpsPerSecond,
            ratio: ormOpsPerSecond / rawOpsPerSecond,
          };
          result.key = keyFor(result);
          results.push(result);
          console.log([
            String(rows).padStart(7), String(Number(reactive)).padEnd(5),
            String(Number(withFlags)).padEnd(7), operation.padEnd(19),
            ormOpsPerSecond.toFixed(1).padStart(13),
            rawOpsPerSecond.toFixed(1).padStart(13),
            result.ratio.toFixed(3).padStart(9),
          ].join(" | "));
        }
        const gets = choose(rows, 1_000);
        record("get(id)", gets,
          i => o.posts.get(i % rows + 1),
          i => rawGet.get(i % rows + 1));
        record("select.where(range)", 15,
          i => o.posts.select().where({ score: { $gte: i % 20 * 10, $lt: i % 20 * 10 + 10 } }).all(),
          i => rawRange.all(i % 20 * 10, i % 20 * 10 + 10));
        record("with(one level)", 3,
          () => o.users.select().where({ id: { $lte: 12 } }).with("posts").all(),
          () => rawWith(raw, opts, 1));
        record("with(two levels)", 3,
          () => o.users.select().where({ id: { $lte: 12 } }).with("posts.comments").all(),
          () => rawWith(raw, opts, 2));
        record("update(id)", choose(rows, 300),
          i => o.posts.update(i % rows + 1, { title: `u-${i}` }),
          i => rawUpdate.run(`u-${i}`, ...(opts.timestamps ? [ISO] : []), i % rows + 1));
        // A game-tick-style read + change, measured against two handwritten
        // prepared calls. The ORM still returns the post-write entity.
        record("tick(get+update)", choose(rows, 300),
          i => {
            const row = o.posts.get(i % rows + 1);
            if (row) o.posts.update(row.id, { title: `${row.title}-t` });
          },
          i => {
            const row = rawGet.get(i % rows + 1) as { id: number; title: string } | null;
            if (row) rawUpdate.run(`${row.title}-t`, ...(opts.timestamps ? [ISO] : []), row.id);
          }, 1, false);
        record("bulk update", 3,
          i => o.posts.update({ title: `bulk-${i}` }).where({ score: { $gte: 390, $lt: 400 } }).exec(),
          i => {
            rawBulk.run(`bulk-${i}`, ...(opts.timestamps ? [ISO] : []), 390, 400);
            return rawChanges.get();
          });
        record("delete", 25,
          i => o.posts.delete(rows - i),
          i => rawDelete.run(...(opts.softDeletes ? [ISO] : []), rows - i),
          1, false);
        record("upsert", 75,
          i => o.posts.upsert({ id: i % rows + 1 }, { title: `up-${i}` }),
          i => rawUpsert.run(i % rows + 1,
            ...(function () {
              const vals = postArgs(i % rows, opts);
              vals[1] = `up-${i}`;
              if (opts.timestamps) vals[7] = ISO;
              return vals;
            })()),
        );
        record("count", 100,
          () => o.posts.count(),
          () => rawCount.get());
        record("pluck", 3,
          () => o.posts.select().pluck("score"),
          () => rawPluck.all().map((row: any) => row.score));
        const entity = o.posts.get(1)!;
        record("entity assignment", 100,
          i => { entity.title = `assignment-${i}`; },
          i => rawUpdate.run(`assignment-${i}`, ...(opts.timestamps ? [ISO] : []), 1),
          1, false);
        const inserts = choose(rows, 500);
        record("insert", inserts,
          i => o.posts.insert(post(rows + i + 100)),
          i => rawInsert.run(...postArgs(rows + i + 100, opts)));
        // A full-size batch is intentional: this measures hydration cost at
        // 1k/10k/100k, not just a tiny fixed batch on differently sized DBs.
        const fullBatch = Array.from({ length: rows }, (_, i) => post(rows * 3 + i));
        record("insertMany", 1,
          () => o.posts.insertMany(fullBatch),
          () => {
            const tx = raw.transaction(() => {
              for (let i = 0; i < rows; i++) rawInsert.run(...postArgs(rows * 3 + i, opts));
            });
            tx();
          }, rows, false);
      } finally {
        orm.close();
        raw.close(true);
      }
    }
  }
}

const report = {
  format: "sqlite-zod-orm-overhead-v1",
  generatedAt: new Date().toISOString(),
  bun: Bun.version,
  notes: "ops/s is logical rows/s for insertMany and invocations/s otherwise; direct SQL includes identical change-journal triggers.",
  results,
};
mkdirSync(dirname(resolve(output)), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
console.log(`\nJSON: ${output}`);

if (baseline) {
  const old = JSON.parse(readFileSync(baseline, "utf8")) as { format?: string; results?: Result[] };
  if (old.format !== report.format || !Array.isArray(old.results))
    throw new Error(`Unrecognized baseline format: ${baseline}`);
  const previous = new Map(old.results.map(result => [result.key, result]));
  const failures: string[] = [];
  for (const result of results) {
    const base = previous.get(result.key);
    if (!base && result.operation === "tick(get+update)") {
      // This newly introduced metric cannot be compared with a historical
      // baseline. Continue checking every pre-existing operation unchanged.
      console.log(`UNBASELINED (new metric): ${result.key}`);
    } else if (!base || !Number.isFinite(base.ratio) || base.ratio <= 0) {
      failures.push(`missing/invalid baseline ${result.key}`);
    } else if (result.ratio < base.ratio * 0.85) {
      failures.push(`${result.key}: ${result.ratio.toFixed(3)} vs ${base.ratio.toFixed(3)} (${((1 - result.ratio / base.ratio) * 100).toFixed(1)}% worse)`);
    }
  }
  if (failures.length > 0) {
    console.error(`OVERHEAD REGRESSION: ${failures.length} case(s) exceeded 15% or lack baseline:`);
    for (const failure of failures) console.error(`  ${failure}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS: all ${results.length} ORM/raw ratios within 15% of baseline`);
  }
}
