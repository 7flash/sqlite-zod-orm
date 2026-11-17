/**
 * Differential query matrix (seed 0x4f524d; each failure names its replayable spec).
 * Oracle SQL is authored independently of QueryBuilder.toSQL().
 */
import { expect, test } from "bun:test";
import { Database as SQLite } from "bun:sqlite";
import { QueryBuilder } from "../src/builder";
import { buildWhereClause } from "../src/helpers";
import { Database, z } from "../src";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SEED = 0x4f524d;
type Row = {
  id: number; name: string | null; age: number | null;
  score: number | null; active: number | null; at: string | null;
  big: string | null; payload: string | null; deletedAt: string | null;
};
const choices = ["A", "a", "Alice", "ALICE", "é", "漢字", "a_b", "a%b", "", null];
const fields = ["name", "age", "score", "active", "at", "big", "payload", "deletedAt"] as const;
type Field = typeof fields[number];
const qid = (field: string) => `"${field.replaceAll('"', '""')}"`;
const asBind = (value: unknown): any =>
  value instanceof Date ? value.toISOString() : typeof value === "boolean" ? Number(value) : value;
function seeded() {
  const db = new SQLite(":memory:");
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY, name TEXT, age INTEGER, score REAL,
      active INTEGER, at TEXT, big TEXT, payload TEXT, deletedAt TEXT
    );
    CREATE TABLE posts (
      id INTEGER PRIMARY KEY, author INTEGER REFERENCES users(id),
      title TEXT, deletedAt TEXT
    );
    CREATE TABLE comments (
      id INTEGER PRIMARY KEY, post INTEGER REFERENCES posts(id),
      body TEXT, deletedAt TEXT
    );
  `);
  const users = db.query(`INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const posts = db.query(`INSERT INTO posts VALUES (?, ?, ?, ?)`);
  const comments = db.query(`INSERT INTO comments VALUES (?, ?, ?, ?)`);
  db.transaction(() => {
    for (let i = 1; i <= 240; i++) {
      users.run(i, choices[i % choices.length] as any, i % 9 === 0 ? null : i % 37,
        i % 11 === 0 ? null : (i % 19) / 2,
        i % 13 === 0 ? null : i % 2,
        i % 17 === 0 ? null : new Date(Date.UTC(2020 + i % 5, i % 12, 1 + i % 28)).toISOString(),
        i % 7 === 0 ? null : (9007199254740991n + BigInt(i % 11)).toString(),
        i % 8 === 0 ? null : JSON.stringify({ tag: choices[i % 9], n: i % 5 }),
        i % 10 === 0 ? "2026-01-01T00:00:00.000Z" : null);
    }
    for (let i = 1; i <= 480; i++) posts.run(i, 1 + (i % 240), `P${i % 20}`, i % 12 === 0 ? "2026-01-01" : null);
    for (let i = 1; i <= 960; i++) comments.run(i, 1 + (i % 480), `C${i % 10}`, i % 14 === 0 ? "2026-01-01" : null);
  })();
  const query = () => new QueryBuilder<Row>(
    "users",
    (sql, params) => db.query(sql).all(...params),
    (sql, params) => db.query(sql).get(...params),
  );
  const oracle = (predicate: string, params: any[] = [], tail = ` ORDER BY "id" ASC`) =>
    db.query(`SELECT * FROM users WHERE ${predicate}${tail}`).all(...params) as Row[];
  return { db, query, oracle };
}
function rows(actual: any[], expected: any[]) {
  // Both queries explicitly sort by unique id; compare all selected stored values.
  expect(actual).toEqual(expected);
}
function xorshift(seed: number) {
  let x = seed;
  return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return x >>> 0; };
}
const rng = xorshift(SEED);
const sample: Record<Field, any[]> = {
  name: [null, "A", "a", "ALICE", "é", "漢字", "a_b", "a%b", ""],
  age: [null, 0, 1, 18, 36, 40],
  score: [null, 0, 0.5, 5, 9.5],
  active: [null, false, true, 0, 1],
  at: [null, "2021-01-01T00:00:00.000Z", "2024-12-31T00:00:00.000Z"],
  big: [null, "9007199254740991", "9007199254740995"],
  payload: [null, '{"tag":"A","n":0}', '{"tag":"a","n":1}'],
  deletedAt: [null, "2026-01-01T00:00:00.000Z"],
};
const ops = ["eq", "$ne", "$gt", "$gte", "$lt", "$lte", "$in", "$notIn", "$between", "$like", "$isNull", "$isNotNull"] as const;
type Operator = typeof ops[number];
function comparison(field: Field, operator: Operator, value: any) {
  const col = qid(field);
  if (operator === "$isNull") return { clause: `${col} IS NULL`, params: [] };
  if (operator === "$isNotNull") return { clause: `${col} IS NOT NULL`, params: [] };
  if (operator === "eq" && value === null) return { clause: `${col} IS NULL`, params: [] };
  if (operator === "$ne" && value === null) return { clause: `${col} IS NOT NULL`, params: [] };
  if (operator === "$in" || operator === "$notIn") {
    if (!value.length) return { clause: operator === "$in" ? "0=1" : "1=1", params: [] };
    return { clause: `${col} ${operator === "$in" ? "IN" : "NOT IN"} (${value.map(() => "?").join(",")})`, params: value.map(asBind) };
  }
  if (operator === "$between") return { clause: `${col} BETWEEN ? AND ?`, params: value.map(asBind) };
  const symbol: Record<string, string> = { eq: "=", $ne: "!=", $gt: ">", $gte: ">=", $lt: "<", $lte: "<=", $like: "LIKE" };
  return { clause: `${col} ${symbol[operator]} ?`, params: [asBind(value)] };
}
function valueFor(field: Field, operator: Operator, n: number) {
  const values = sample[field];
  const value = values[n % values.length];
  if (operator === "$in" || operator === "$notIn")
    return n % 5 === 0 ? [] : [value, values[(n + 2) % values.length], values[(n + 3) % values.length]];
  if (operator === "$between") return [values[(n + 1) % values.length], values[(n + 3) % values.length]];
  if (operator === "$like") return n % 4 === 0 ? "%a%" : n % 4 === 1 ? "a_b" : n % 4 === 2 ? "a%b" : "%";
  return value;
}
function criteria(field: Field, operator: Operator, value: any): Record<string, any> {
  return { [field]: operator === "eq" ? value : { [operator]: value } };
}
for (let i = 0; i < 3072; i++) {
  const field = fields[i % fields.length]!;
  const operator = ops[Math.floor(i / fields.length) % ops.length]!;
  const value = valueFor(field, operator, rng() % 1000);
  const spec = JSON.stringify({ seed: SEED, i, field, operator, value });
  test(`query matrix ${spec}`, () => {
    const { db, query, oracle } = seededOnce;
    const condition = comparison(field, operator, value);
    rows(query().where(criteria(field, operator, value) as any).orderBy("id").raw().all(),
      oracle(condition.clause, condition.params));
  });
}
// A single file handle keeps the matrix fast and guarantees the same rows on both sides.
const seededOnce = seeded();

test("regression: OR preserves AND within each branch, and global AND scope", () => {
  const { query, oracle } = seededOnce;
  const condition = { age: { $gte: 10 }, $or: [
    { name: "A", active: true },
    { name: "a", age: { $lt: 20 } },
  ] };
  rows(query().where(condition as any).orderBy("id").raw().all(),
    oracle(`"age" >= ? AND (("name" = ? AND "active" = ?) OR ("name" = ? AND "age" < ?))`,
      [10, "A", 1, "a", 20]));
});
test("regression: nested callback OR AND object and raw clauses all apply", () => {
  const { query, oracle } = seededOnce;
  rows(query().where({ active: true } as any)
    .where((c, f, op) => op.or(op.eq(c.name, "A"), op.eq(c.name, "a")))
    .whereRaw(`"age" >= ?`, [10]).orderBy("id").raw().all(),
    oracle(`"active" = ? AND ("name" = ? OR "name" = ?) AND "age" >= ?`, [1, "A", "a", 10]));
});
test("regression: null equality and inequality match SQL IS NULL / IS NOT NULL", () => {
  const { query, oracle } = seededOnce;
  rows(query().where({ name: null }).orderBy("id").raw().all(), oracle(`"name" IS NULL`));
  rows(query().where({ name: { $ne: null } }).orderBy("id").raw().all(), oracle(`"name" IS NOT NULL`));
});
test("regression: empty OR does not broaden reads or bulk writes", () => {
  const { query } = seededOnce;
  expect(query().where({ $or: [] } as any).raw().all()).toEqual([]);
  const where = buildWhereClause({ $or: [] });
  expect(where.clause).toContain("1 = 0");
  expect(seededOnce.db.query(`SELECT COUNT(*) AS n FROM users ${where.clause}`).get()).toEqual({ n: 0 });
  expect(() => buildWhereClause({ $or: [{}] })).toThrow();
  expect(() => query().where({ $or: [{}] } as any)).toThrow();
  expect(() => buildWhereClause({ $unexpected: 1 })).toThrow();
  expect(() => query().where({ $unexpected: 1 } as any)).toThrow();
});
test("regression: bigint predicates use the same TEXT representation as persisted bigints", () => {
  const { query, oracle } = seededOnce;
  const big = 9007199254740995n;
  rows(query().where({ big: { $in: [big] } } as any).orderBy("id").raw().all(),
    oracle(`"big" IN (?)`, [big.toString()]));
  rows(query().where({ big: { $gte: big } } as any).orderBy("id").raw().all(),
    oracle(`"big" >= ?`, [big.toString()]));
});
test("regression: multi-operator range is identical in select and bulk WHERE helper", () => {
  const condition = { age: { $gte: 10, $lt: 20 } };
  const compiled = buildWhereClause(condition);
  expect(compiled.values).toEqual([10, 20]);
  expect(seededOnce.db.query(`SELECT id FROM users ${compiled.clause} ORDER BY id`).all(...compiled.values))
    .toEqual(seededOnce.db.query(`SELECT id FROM users WHERE age >= ? AND age < ? ORDER BY id`).all(10, 20));
  rows(seededOnce.query().where(condition).orderBy("id").raw().all(),
    seededOnce.oracle(`"age" >= ? AND "age" < ?`, [10, 20]));
});
test("regression: exists with LIMIT and OFFSET compares the actual subquery", () => {
  const { query } = seededOnce;
  expect(query().orderBy("id").limit(1).offset(239).exists()).toBe(true);
  expect(query().orderBy("id").limit(1).offset(240).exists()).toBe(false);
  expect(query().limit(0).exists()).toBe(false);
});
test("IN empty, NOT IN empty, long lists and qualified ordering", () => {
  const { query, oracle } = seededOnce;
  rows(query().whereIn("id", []).orderBy("id").raw().all(), []);
  rows(query().whereNotIn("id", []).orderBy("id").raw().all(), oracle("1=1"));
  const list = Array.from({ length: 2000 }, (_, i) => i + 1);
  rows(query().whereIn("id", list).orderBy("id").raw().all(),
    oracle(`"id" IN (${list.map(() => "?").join(",")})`, list));
  for (const field of fields) {
    for (const direction of ["asc", "desc"] as const) {
      const expected = seededOnce.db.query(`SELECT * FROM users ORDER BY ${qid(field)} ${direction}, id ASC`).all();
      rows(query().orderBy(field, direction).orderBy("id").raw().all(), expected);
    }
  }
});
test("IN and NOT IN subqueries preserve independent inner filters", () => {
  const { db, query, oracle } = seededOnce;
  const posts = () => new QueryBuilder<{ author: number; title: string; deletedAt: string | null }>(
    "posts", (sql, params) => db.query(sql).all(...params),
    (sql, params) => db.query(sql).get(...params),
  );
  const sub = () => posts().select("author").where({ deletedAt: null, title: "P1" });
  rows(query().whereIn("id", sub() as any).orderBy("id").raw().all(),
    oracle(`"id" IN (SELECT author FROM posts WHERE deletedAt IS NULL AND title = ?)`, ["P1"]));
  rows(query().whereNotIn("id", sub() as any).orderBy("id").raw().all(),
    oracle(`"id" NOT IN (SELECT author FROM posts WHERE deletedAt IS NULL AND title = ?)`, ["P1"]));
});
test("LIKE wildcards and explicit ESCAPE via whereRaw", () => {
  const { query, oracle } = seededOnce;
  for (const pattern of ["a_b", "a%b", "a\\_b", "a\\%b", "%é%", "%漢%"]) {
    const escape = pattern.includes("\\") ? ` ESCAPE '\\'` : "";
    rows(query().whereRaw(`"name" LIKE ?${escape}`, [pattern]).orderBy("id").raw().all(),
      oracle(`"name" LIKE ?${escape}`, [pattern]));
  }
});
test("limit/offset/get/first and pagination edge cases", () => {
  const { query, oracle } = seededOnce;
  for (const [limit, offset] of [[0, 0], [1, 0], [5, 9], [200, 239], [20, 999]] as const) {
    const expected = oracle("1=1", [], ` ORDER BY id LIMIT ${limit} OFFSET ${offset}`);
    rows(query().orderBy("id").limit(limit).offset(offset).raw().all(), expected);
  }
  expect(query().where({ id: 1 }).raw().get()).toEqual(oracle(`id = ?`, [1])[0] as any);
  expect(query().where({ id: 999 }).raw().first()).toBeNull();
  expect(() => query().limit(-1).all()).toThrow();
  expect(() => query().offset(-1).all()).toThrow();
  expect(() => query().paginate(0, 5)).toThrow();
  expect(() => query().paginate(1, 0)).toThrow();
  for (const page of [1, 2, 25, 49]) {
    const result = query().orderBy("id").raw().paginate(page, 5);
    expect(result.total).toBe(240);
    expect(result.pages).toBe(48);
    rows(result.data, oracle("1=1", [], ` ORDER BY id LIMIT 5 OFFSET ${(page - 1) * 5}`));
  }
});
test("groupBy, countGrouped, all aggregates and HAVING", () => {
  const { db, query } = seededOnce;
  const where = { age: { $gte: 9 } };
  const cond = `"age" >= ?`;
  const params = [9];
  const scalar = query().where(where);
  expect(scalar.count()).toBe((db.query(`SELECT COUNT(*) AS n FROM users WHERE ${cond}`).get(...params) as any).n);
  for (const field of fields) {
    expect(scalar.sum(field)).toBe((db.query(`SELECT TOTAL(${qid(field)}) AS n FROM users WHERE ${cond}`).get(...params) as any).n);
    expect(scalar.avg(field)).toBe((db.query(`SELECT AVG(${qid(field)}) AS n FROM users WHERE ${cond}`).get(...params) as any).n ?? 0);
    expect(scalar.min(field)).toBe((db.query(`SELECT MIN(${qid(field)}) AS n FROM users WHERE ${cond}`).get(...params) as any).n);
    expect(scalar.max(field)).toBe((db.query(`SELECT MAX(${qid(field)}) AS n FROM users WHERE ${cond}`).get(...params) as any).n);
  }
  const grouped = query().where(where).groupBy("active").orderBy("active").raw();
  const expected = db.query(`SELECT active, COUNT(*) AS count FROM users WHERE ${cond} GROUP BY active ORDER BY active`).all(...params);
  expect(grouped.countGrouped()).toEqual(expected as any);
  expect(grouped.count()).toBe(expected.length);
  const having = query().where(where).groupBy("active").having({ "COUNT(*)": { $gt: 30 } }).orderBy("active").raw();
  expect(having.countGrouped()).toEqual(db.query(`SELECT active, COUNT(*) AS count FROM users WHERE ${cond} GROUP BY active HAVING COUNT(*) > ? ORDER BY active`).all(9, 30) as any);
  expect(() => grouped.sum("score")).toThrow();
});
test("joins from users to posts and posts to comments (including tombstone filtering)", () => {
  const { db, query } = seededOnce;
  const sql = `SELECT users.id, posts.title AS posts_title FROM users
    JOIN posts ON users.id = posts.author AND posts.deletedAt IS NULL
    WHERE users.deletedAt IS NULL AND users.id <= 20 ORDER BY users.id, posts.id`;
  const expected = db.query(sql).all();
  const actual = query().select("id").join("posts", "id", ["title"], "author")
    .where({ deletedAt: { $isNull: true }, id: { $lte: 20 } } as any)
    .whereRaw(`posts.deletedAt IS NULL`).orderBy("users.id" as any)
    .orderBy("posts.id" as any).raw().all();
  expect(actual).toEqual(expected as any);
  const count = db.query(`SELECT COUNT(*) AS n FROM posts JOIN comments ON posts.id = comments.post WHERE posts.id < 20`).get() as any;
  expect(count.n).toBeGreaterThan(0);
});
test("bulk SQL WHERE compiler matches exact update and delete ids, counts and values", () => {
  const { db } = seededOnce;
  db.exec(`CREATE TABLE bulk AS SELECT * FROM users`);
  const condition = { age: { $gte: 10, $lt: 20 }, $or: [
    { active: true, name: "A" }, { name: "a", score: { $gte: 2 } },
  ] };
  const { clause, values } = buildWhereClause(condition);
  const expectedIds = (db.query(`SELECT id FROM bulk WHERE age >= ? AND age < ? AND ((active = ? AND name = ?) OR (name = ? AND score >= ?)) ORDER BY id`).all(10,20,1,"A","a",2) as any[]).map(x => x.id);
  const result = db.query(`UPDATE bulk SET score = ? ${clause}`).run(777, ...values);
  expect(result.changes).toBe(expectedIds.length);
  const affected = (db.query(`SELECT id FROM bulk WHERE score = 777 ORDER BY id`).all() as any[]).map(x => x.id);
  expect(affected).toEqual(expectedIds);
  const del = db.query(`DELETE FROM bulk ${clause}`).run(...values);
  expect(del.changes).toBe(expectedIds.length);
  const remaining = (db.query(`SELECT id FROM bulk ORDER BY id`).all() as any[]).map(x => x.id);
  expect(remaining).toEqual(Array.from({length: 240}, (_, i) => i+1).filter(id => !expectedIds.includes(id)));
});
test("ORM update().where().exec and delete().where().exec respect same SQL oracle on same file", () => {
  const dir = mkdtempSync(join(tmpdir(), "orm-query-matrix-"));
  const filename = join(dir, "queries.sqlite");
  const orm = new Database(filename, {
    users: z.object({ name: z.string(), age: z.number(), active: z.boolean(), score: z.number() }),
    posts: z.object({ author: z.number(), title: z.string() }),
    comments: z.object({ post: z.number(), body: z.string() }),
  }, { softDeletes: true, reactive: false, relations: {
    posts: { author: "users" }, comments: { post: "posts" },
  } });
  const sql = new SQLite(filename);
  try {
    for (let i = 0; i < 220; i++) {
      orm.users.insert({ name: i % 2 ? "A" : "a", age: i % 40, active: i % 3 === 0, score: i % 9 });
    }
    const condition = { age: { $gte: 10, $lt: 20 }, $or: [
      { name: "A", active: true }, { name: "a", score: { $gte: 4 } },
    ] };
    const matching = (sql.query(`SELECT id FROM users WHERE "deletedAt" IS NULL AND age >= 10 AND age < 20
      AND ((name = 'A' AND active = 1) OR (name = 'a' AND score >= 4)) ORDER BY id`).all() as any[]).map(r => r.id);
    expect(orm.users.select().where(condition as any).orderBy("id").raw().all().map((r: any) => r.id)).toEqual(matching);
    const updated = orm.users.update({ score: 999 }).where(condition as any).exec();
    expect(updated).toBe(matching.length);
    expect((sql.query(`SELECT id FROM users WHERE score = 999 AND "deletedAt" IS NULL ORDER BY id`).all() as any[]).map(r => r.id)).toEqual(matching);
    const deleted = orm.users.delete().where(condition as any).exec();
    expect(deleted).toBe(matching.length);
    expect((sql.query(`SELECT COUNT(*) AS n FROM users WHERE score = 999 AND "deletedAt" IS NOT NULL`).get() as any).n).toBe(matching.length);
    expect(orm.users.select().withTrashed().where({ score: 999 }).raw().all().every((r: any) => r.deletedAt !== null)).toBe(true);
    expect(orm.users.select().where({ score: 999 }).count()).toBe(0);
    const user = orm.users.insert({ name: "rel", age: 1, active: true, score: 1 });
    const post = orm.posts.insert({ author: user.id, title: "hello" });
    orm.comments.insert({ post: post.id, body: "hi" });
    expect((orm.users.select().where({ id: user.id }).with("posts").get() as any).posts.length).toBe(1);
    expect((orm.posts.select().where({ id: post.id }).with("comments").get() as any).comments.length).toBe(1);
    orm.posts.delete(post.id);
    expect((orm.users.select().where({ id: user.id }).with("posts").get() as any).posts.length).toBe(0);
    const joined = orm.posts.select("id").join("users", "author", ["name"]).orderBy("posts.id" as any).raw().all();
    const expectedJoin = sql.query(`SELECT posts.id, users.name AS users_name FROM posts JOIN users
      ON posts.author = users.id AND users.deletedAt IS NULL WHERE posts.deletedAt IS NULL ORDER BY posts.id`).all();
    expect(joined).toEqual(expectedJoin as any);
  } finally {
    sql.close();
    orm.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
