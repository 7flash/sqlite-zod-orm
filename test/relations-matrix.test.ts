/** Differential relations matrix: replay seed 0xC8077A9D and the named case. */
import { describe, expect, test } from "bun:test";
import { Database, z } from "../src";

const SEED = 0xc8077a9d;
const sizes = { users: 180, posts: 650, comments: 2100, tags: 17, links: 901 };
const q = (table: string) => `"${table.replaceAll('"', '""')}"`;
const identity = (rows: any[]) => rows.map((row) => row.id);
const sorted = (rows: any[]) => identity(rows).sort((a, b) => a - b);

function fixture(softDeletes: boolean) {
  const db = new Database(":memory:", {
    users: z.object({ name: z.string(), managerId: z.number().nullable() }),
    posts: z.object({ name: z.string(), author_id: z.number().nullable(), createdAtLabel: z.string() }),
    comments: z.object({ name: z.string(), post_id: z.number().nullable(), author_id: z.number().nullable(), editor_id: z.number().nullable() }),
    tags: z.object({ name: z.string() }),
    links: z.object({ post_id: z.number(), tag_id: z.number() }),
    profiles: z.object({ userRef: z.number().nullable(), name: z.string() }),
  }, {
    reactive: false, softDeletes, timestamps: true,
    relations: {
      users: { managerId: "users" },
      posts: { author_id: "users" },
      comments: { post_id: "posts", author_id: "users", editor_id: "users" },
      links: { post_id: "posts", tag_id: "tags" },
      profiles: { userRef: "users" },
    },
  });
  // Fixed seed with deterministic distribution, duplicate names and Unicode.
  const names = ["Ada", "Ada", "李", "café", "", "Ω", "a_b"];
  for (let i = 1; i <= sizes.users; i++)
    db.exec('INSERT INTO users (id,name,managerId) VALUES (?,?,?)', i,
      names[(i * 7 + (i >>> 2)) % names.length], i === 1 || i % 17 === 0 ? null : Math.floor(i / 2));
  for (let i = 1; i <= sizes.posts; i++)
    db.exec('INSERT INTO posts (id,name,author_id,createdAtLabel) VALUES (?,?,?,?)',
      i, names[i % names.length], i % 19 === 0 ? null : 1 + (i * 13 % 160), `t${i % 7}`);
  for (let i = 1; i <= sizes.comments; i++)
    db.exec('INSERT INTO comments (id,name,post_id,author_id,editor_id) VALUES (?,?,?,?,?)',
      i, names[(i + 4) % names.length], i % 31 === 0 ? null : 1 + (i * 17 % 600),
      i % 23 === 0 ? null : 1 + (i * 11 % sizes.users), i % 29 === 0 ? null : 1 + (i * 19 % sizes.users));
  for (let i = 1; i <= sizes.tags; i++)
    db.exec('INSERT INTO tags (id,name) VALUES (?,?)', i, names[i % names.length]);
  for (let i = 1; i <= sizes.links; i++)
    db.exec('INSERT INTO links (id,post_id,tag_id) VALUES (?,?,?)', i, 1 + (i * 23 % sizes.posts), 1 + (i * 3 % 13));
  for (let i = 1; i <= 37; i++)
    db.exec('INSERT INTO profiles (id,userRef,name) VALUES (?,?,?)', i, i % 5 === 0 ? null : i, names[i % names.length]);
  // Explicit dangling references: exercise missing-target navigation rather
  // than relying solely on null FKs. Restore enforcement after the updates.
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("UPDATE posts SET author_id = 99999 WHERE id = 650");
  db.exec("UPDATE comments SET editor_id = 99999 WHERE id = 2100");
  db.exec("PRAGMA foreign_keys = ON");
  if (softDeletes) {
    for (const [table, modulus] of [["users", 11], ["posts", 13], ["comments", 17], ["tags", 5], ["links", 19], ["profiles", 7]] as const)
      db.exec(`UPDATE ${q(table)} SET "deletedAt" = '2026-01-01T00:00:00.000Z' WHERE id % ? = 0`, modulus);
  }
  const live = (alias: string, table: string) => softDeletes ? ` AND ${alias}."deletedAt" IS NULL` : "";
  const oracle = (sql: string, ...args: any[]) => db.raw<any>(sql, ...args);
  return { db, oracle, live, softDeletes };
}

// Each expected result is written as SQL rather than compiled from QueryBuilder.
// Failure names include seed and case parameters, so each failure is replayable.
for (const softDeletes of [false, true]) {
  describe(`relations SQL oracle seed=${SEED} softDeletes=${softDeletes}`, () => {
    const env = fixture(softDeletes);
    const { db, oracle, live } = env;
    const visible = (table: string, alias = "x") =>
      softDeletes ? ` WHERE ${alias}."deletedAt" IS NULL` : "";
    const equal = (caseName: string, actual: any, expected: any) => {
      try { expect(actual).toEqual(expected); }
      catch (error) { console.error(JSON.stringify({ seed: SEED, softDeletes, caseName, sizes })); throw error; }
    };
    // FK navigation, inverse accessors, qualified inverse names and nullable FKs.
    const paths = [
      ["posts", "author", "users", "author_id", "one"],
      ["comments", "post", "posts", "post_id", "one"],
      ["comments", "author", "users", "author_id", "one"],
      ["comments", "editor", "users", "editor_id", "one"],
      ["profiles", "userRefRelation", "users", "userRef", "one"],
      ["users", "managerIdRelation", "users", "managerId", "one"],
      ["users", "posts", "posts", "author_id", "many"],
      ["users", "commentsByAuthorId", "comments", "author_id", "many"],
      ["users", "commentsByEditorId", "comments", "editor_id", "many"],
      ["users", "usersByManagerId", "users", "managerId", "many"],
      ["posts", "comments", "comments", "post_id", "many"],
      ["posts", "links", "links", "post_id", "many"],
      ["tags", "links", "links", "tag_id", "many"],
      ["users", "profiles", "profiles", "userRef", "many"],
      ["links", "post", "posts", "post_id", "one"],
      ["links", "tag", "tags", "tag_id", "one"],
    ] as const;
    for (const [source, accessor, target, fk, cardinality] of paths) {
      for (const id of [1, 11, 13, 17, 31, 79, 157]) {
        const label = `${source}.${accessor} id=${id} ${cardinality}`;
        test(label, () => {
          const row = (db as any)[source].get(id);
          if (!row) return;
          const sql = cardinality === "many"
            ? `SELECT t.id FROM "${target}" t WHERE t."${fk}" = ?${live("t", target)} ORDER BY t.id`
            : `SELECT t.id FROM "${target}" t WHERE t.id = ?${live("t", target)} ORDER BY t.id`;
          const expected = oracle(sql, cardinality === "many" ? id : row[fk]).map((r) => r.id);
          const value = row[accessor]();
          equal(`${label} lazy`, cardinality === "many" ? sorted(value) : value?.id ?? null,
            cardinality === "many" ? expected : expected[0] ?? null);
        });
      }
      test(`with ${source}.${accessor} batch`, () => {
        const results = (db as any)[source].select().orderBy("id").with(accessor).all();
        const sample = results.filter((r: any) => [1, 11, 13, 17, 31, 79, 157].includes(r.id));
        for (const row of sample) {
          const sql = cardinality === "many"
            ? `SELECT t.id FROM "${target}" t WHERE t."${fk}" = ?${live("t", target)} ORDER BY t.id`
            : `SELECT t.id FROM "${target}" t WHERE t.id = ?${live("t", target)} ORDER BY t.id`;
          const expected = oracle(sql, cardinality === "many" ? row.id : row[fk]).map((r) => r.id);
          const value = row[accessor];
          equal(`${source}.${accessor} eager id=${row.id}`, cardinality === "many" ? sorted(value) : value?.id ?? null,
            cardinality === "many" ? expected : expected[0] ?? null);
        }
      });
    }
    for (const [path, sql] of [
      ["posts.comments", `SELECT c.id FROM comments c JOIN posts p ON c.post_id=p.id WHERE p.author_id=?${live("p", "posts")}${live("c", "comments")} ORDER BY c.id`],
      ["posts.comments.author", `SELECT c.id, c.author_id FROM comments c JOIN posts p ON c.post_id=p.id WHERE p.author_id=?${live("p", "posts")}${live("c", "comments")} ORDER BY c.id`],
      ["posts.links.tag", `SELECT l.id,l.tag_id FROM links l JOIN posts p ON l.post_id=p.id WHERE p.author_id=?${live("p", "posts")}${live("l", "links")} ORDER BY l.id`],
    ] as const) {
      test(`nested .with(${path}) two/three levels`, () => {
        const rows = db.users.select().where({ id: 1 }).with(path).all() as any[];
        const user = rows[0];
        if (!user) return;
        const children = user.posts.flatMap((p: any) => path.includes("comments") ? p.comments : p.links);
        equal(`${path} nested children`, sorted(children), oracle(sql, 1).map((r: any) => r.id));
        if (path.endsWith("author")) for (const child of children) {
          const expected = oracle(`SELECT id FROM users WHERE id=?${live("users", "users")}`, child.author_id)[0]?.id ?? null;
          equal(`nested author comment=${child.id}`, child.author?.id ?? null, expected);
        }
        if (path.endsWith("tag")) for (const child of children) {
          const expected = oracle(`SELECT id FROM tags WHERE id=?${live("tags", "tags")}`, child.tag_id)[0]?.id ?? null;
          equal(`nested tag link=${child.id}`, child.tag?.id ?? null, expected);
        }
      });
    }
    test("multiple .with relations and shared nested prefix", () => {
      const rows = db.users.select().where({ id: { $in: [1, 2, 11, 13] } })
        .with("posts", "commentsByAuthorId", "posts.comments", "posts.author").orderBy("id").all() as any[];
      for (const row of rows) {
        equal(`multi posts ${row.id}`, sorted(row.posts), oracle(`SELECT id FROM posts WHERE author_id=?${live("posts", "posts")} ORDER BY id`, row.id).map((r) => r.id));
        equal(`multi comments ${row.id}`, sorted(row.commentsByAuthorId), oracle(`SELECT id FROM comments WHERE author_id=?${live("comments", "comments")} ORDER BY id`, row.id).map((r) => r.id));
        for (const post of row.posts) {
          equal(`multi nested ${post.id}`, sorted(post.comments), oracle(`SELECT id FROM comments WHERE post_id=?${live("comments", "comments")} ORDER BY id`, post.id).map((r) => r.id));
          equal(`multi nested author ${post.id}`, post.author?.id ?? null, row.id);
        }
      }
    });
    for (const [start, count] of [[0, 1], [2, 5], [20, 11], [75, 4]] as const) {
      test(`parent paging orderBy/limit/offset offset=${start} limit=${count}`, () => {
        const actual = db.users.select().where({ id: { $gte: 3 } }).orderBy("id", "desc")
          .limit(count).offset(start).with("posts").all() as any[];
        const expected = oracle(`SELECT id FROM users WHERE id>=3${live("users", "users")} ORDER BY id DESC LIMIT ? OFFSET ?`, count, start);
        equal(`paged parent ids`, identity(actual), expected.map((r) => r.id));
        for (const row of actual) equal(`paged children ${row.id}`, sorted(row.posts),
          oracle(`SELECT id FROM posts WHERE author_id=?${live("posts", "posts")} ORDER BY id`, row.id).map((r) => r.id));
      });
    }
    test("related row counts and selected values match independent SQL", () => {
      const users = db.users.select("id", "name").where({ id: { $in: [1, 9, 11, 150, 179] } })
        .orderBy("id").with("posts").all() as any[];
      for (const user of users) {
        const expected = oracle(`SELECT id,name,createdAtLabel FROM posts WHERE author_id=?${live("posts", "posts")} ORDER BY id`, user.id);
        equal(`related values ${user.id}`, user.posts.map((p: any) =>
          ({ id: p.id, name: p.name, createdAtLabel: p.createdAtLabel })), expected);
        equal(`related count ${user.id}`, user.posts.length,
          oracle(`SELECT COUNT(*) AS n FROM posts WHERE author_id=?${live("posts", "posts")}`, user.id)[0].n);
      }
    });
    test("no children and dangling FK stay empty or null", () => {
      const noPosts = db.users.get(179)!;
      equal("zero inverse rows", noPosts.posts(), []);
      const orphan = db.posts.get(650);
      if (orphan) {
        equal("dangling lazy target", orphan.author(), null);
        equal("dangling eager target", (db.posts.select().where({ id: 650 }).with("author").get() as any).author, null);
      }
      const comment = db.comments.get(2100);
      if (comment) equal("dangling second FK", comment.editor(), null);
    });
    test("many-to-many via links and explicit FK navigation", () => {
      for (const post of db.posts.select().where({ id: { $in: [1, 9, 20, 90, 120] } }).with("links.tag").all() as any[]) {
        const expected = oracle(`SELECT t.id FROM tags t JOIN links l ON l.tag_id=t.id WHERE l.post_id=?${live("l", "links")}${live("t", "tags")} ORDER BY l.id`, post.id).map((r) => r.id);
        equal(`post ${post.id} tags`, post.links.map((l: any) => l.tag?.id).filter((id: any) => id != null), expected);
      }
    });
    test("join projection aliases id/name/createdAt and select narrowing", () => {
      const joined = db.posts.select("id", "name").join("users", "author_id", ["id", "name", "createdAt"]).orderBy("id").limit(30).all() as any[];
      const expected = oracle(`SELECT p.id,p.name,u.id AS users_id,u.name AS users_name,u.createdAt AS users_createdAt FROM posts p JOIN users u ON p.author_id=u.id${softDeletes ? ' AND u.deletedAt IS NULL' : ''}${softDeletes ? ' WHERE p.deletedAt IS NULL' : ''} ORDER BY p.id LIMIT 30`);
      equal("join aliases", joined, expected);
    });
    test("explicit reverse join and count match SQL", () => {
      const joined = db.users.select("id", "name").join("posts", "id", ["id", "name"], "author_id").orderBy("id").limit(30).all();
      const expected = oracle(`SELECT u.id,u.name,p.id AS posts_id,p.name AS posts_name FROM users u JOIN posts p ON u.id=p.author_id${softDeletes ? ' AND p.deletedAt IS NULL' : ''}${softDeletes ? ' WHERE u.deletedAt IS NULL' : ''} ORDER BY u.id LIMIT 30`);
      equal("reverse join", joined, expected);
      equal("joined count", db.users.select().join("posts", "id", ["id"], "author_id").count(),
        oracle(`SELECT COUNT(*) AS n FROM users u JOIN posts p ON u.id=p.author_id${softDeletes ? ' AND p.deletedAt IS NULL' : ''}${softDeletes ? ' WHERE u.deletedAt IS NULL' : ''}`)[0].n);
    });
    test("custom FK accessor and null navigation", () => {
      const row = db.profiles.get(5);
      if (row) equal("nullable userRef", row.userRefRelation(), null);
    });
  });
}
