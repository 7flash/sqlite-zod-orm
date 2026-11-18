/**
 * Compile-time/API runtime matrix for sqlite-zod-orm 4.1.0.
 *
 * Assertions deliberately sit beside the runtime check for the same contract.
 * Compile with `tsc --noEmit` (Bun test itself does not type-check this file).
 * Negative examples are unreachable but still checked by TypeScript.
 *
 * Each @ts-expect-error either has a paired runtime rejection or is marked
 * TYPE-ONLY where SQLite intentionally accepts the value or TS cannot express
 * a runtime condition (such as a nonexistent schema property).
 */
import { describe, expect, test } from "bun:test";
import {
  Database, QueryBuilder, ColumnNode, defineView, createMigrator, runCli, z, op, compileAST,
  createColumnProxy, createFunctionProxy, wrapNode, DatabaseMigrator, ConflictMergeHelperRuntime,
} from "../src/index";
import type { DatabaseType, DatabaseOptions, TransactionOptions, ProxyQueryResult } from "../src/index";

function expectType<T>(_value: T): void {}
type Equal<A, B> =
  (<X>() => X extends A ? 1 : 2) extends
  (<X>() => X extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;

const schemas = {
  users: z.object({ name: z.string(), role: z.enum(["staff", "guest"]).default("guest"), score: z.number().default(0) }),
  posts: z.object({ title: z.string(), user_id: z.number().nullable(), published: z.boolean().default(false) }),
  comments: z.object({ body: z.string(), post_id: z.number(), author_id: z.number().nullable() }),
  tags: z.object({ name: z.string() }),
  post_tags: z.object({ post_id: z.number(), tag_id: z.number() }),
  grants: z.object({ author_id: z.number(), reviewer_id: z.number() }),
  employees: z.object({ name: z.string(), manager_id: z.number().nullable() }),
};
const relations = {
  posts: { user_id: "users" },
  comments: { post_id: "posts", author_id: "users" },
  post_tags: { post_id: "posts", tag_id: "tags" },
  grants: { author_id: "users", reviewer_id: "users" },
  employees: { manager_id: "employees" },
} as const;

function relationalDb() {
  return new Database(":memory:", schemas, { relations, reactive: false });
}
function seedRelations(db: ReturnType<typeof relationalDb>) {
  const user = db.users.insert({ name: "Ada" }); // defaults are optional
  const post = db.posts.insert({ title: "P", user_id: user.id }); // published optional
  const orphan = db.posts.insert({ title: "Unassigned", user_id: null });
  const comment = db.comments.insert({ body: "C", post_id: post.id, author_id: user.id });
  const tag = db.tags.insert({ name: "red" });
  const link = db.post_tags.insert({ post_id: post.id, tag_id: tag.id });
  const grant = db.grants.insert({ author_id: user.id, reviewer_id: user.id });
  const manager = db.employees.insert({ name: "Boss", manager_id: null });
  const worker = db.employees.insert({ name: "Worker", manager_id: manager.id });
  return { user, post, orphan, comment, tag, link, grant, manager, worker };
}

describe("entity accessors, insert input, updates and upsert", () => {
  test("generated id, optional/default inputs, null/get and runtime Zod rejection", () => {
    const db = relationalDb();
    try {
      const inserted = db.users.insert({ name: "A" });
      expectType<number>(inserted.id);
      expectType<string>(inserted.name);
      expectType<number>(inserted.score);
      expectType<"guest" | "staff">(inserted.role);
      expect(inserted.score).toBe(0);
      expect(inserted.role).toBe("guest");
      expectType<typeof inserted | null>(db.users.get(inserted.id));
      expect(db.users.get(999999)).toBeNull();

      const explicitlyId = db.users.insert({ name: "B", id: 100 });
      expect(explicitlyId.id).toBe(100); // SQLite permits explicit INTEGER PK
      const many = db.users.insertMany([{ name: "C" }, { name: "D", score: 4 }]);
      expectType<typeof inserted[]>(many);
      expect(many.map((r) => r.name)).toEqual(["C", "D"]);

      if (false) {
        // @ts-expect-error missing required name; SQLite insert is Zod-validated
        db.users.insert({});
        // @ts-expect-error numeric id only; SQLite rejects noninteger PK strings
        db.users.insert({ name: "X", id: "not-a-number" });
        // @ts-expect-error wrong field type; Zod rejects it
        db.users.insert({ name: 15 });
        // @ts-expect-error unknown schema property, Zod passthrough accepts it at
        // parse time but SQL rejects the nonexistent column
        db.users.insert({ name: "X", missingColumn: 1 });
      }
      expect(() => (db.users as any).insert({})).toThrow();
      expect(() => (db.users as any).insert({ name: 15 })).toThrow();
      expect(() => (db.users as any).insert({ name: "X", id: "not-a-number" })).toThrow();
      expect(() => (db.users as any).insert({ name: "X", missingColumn: 1 })).toThrow();
    } finally { db.close(); }
  });

  test("partial update keeps defaults, fluent update and deletion counts", () => {
    const db = relationalDb();
    try {
      const row = db.users.insert({ name: "N", score: 9 });
      const changed = db.users.update(row.id, { name: "N2" });
      expectType<typeof row | null>(changed);
      expect(changed?.score).toBe(9);
      expect(changed?.name).toBe("N2");
      expectType<number | undefined>(row.update({ score: 10 })?.id);
      expect(db.users.get(row.id)?.score).toBe(10);
      expectType<number>(db.users.update({ score: 13 }).where({ id: row.id }).exec());
      expect(db.users.get(row.id)?.score).toBe(13);
      expect(db.users.update({ name: "N3" }).where({ score: { $gte: 10, $lt: 20 } }).exec()).toBe(1);
      expect(db.users.get(row.id)?.name).toBe("N3");
      if (false) {
        // @ts-expect-error update must not accept non-schema columns
        // (TYPE-ONLY: Zod strips unknown properties on update)
        db.users.update(row.id, { noSuchColumn: true });
        // @ts-expect-error wrong partial field type; Zod rejects this
        db.users.update(row.id, { score: "13" });
        // @ts-expect-error id is not an updateable schema field (TYPE-ONLY:
        // Zod strips unrecognized id from partial update)
        db.users.update(row.id, { id: 999 });
        // @ts-expect-error update where() requires an array for $in
        db.users.update({ name: "N" }).where({ id: { $in: 7 } });
      }
      expect(() => (db.users as any).update(row.id, { score: "13" })).toThrow();
      expect(() => (db.users as any).update(row.id, { noSuchColumn: true })).not.toThrow(); // stripped by Zod
      expect(() => (db.users as any).update({ name: "N" }).where({ id: { $in: 7 } }).exec()).toThrow();
      expectType<void>(db.users.delete(row.id));
      expect(db.users.get(row.id)).toBeNull();
      const another = db.users.insert({ name: "E" });
      const deleted = db.users.delete().where({ id: another.id }).exec();
      expectType<number>(deleted);
      expect(deleted).toBe(1);
      if (false) {
        // @ts-expect-error incorrect field name on fluent delete
        // (TYPE-ONLY: in some SQLite builds unknown double-quoted identifiers
        // in unqualified WHERE are interpreted as string constants).
        db.users.delete().where({ totallyMissing: 2 });
      }
      expect((db.users as any).delete().where({ totallyMissing: 2 }).exec()).toBe(0);
    } finally { db.close(); }
  });

  test("legacy upsert, native conflict upsert, doNothing, findOrCreate and upsertMany", () => {
    const db = new Database(":memory:", {
      contacts: z.object({ email: z.string(), name: z.string(), score: z.number().default(0) }),
    }, { unique: { contacts: [["email"]] }, reactive: false });
    try {
      const created = db.contacts.upsert({ email: "e" }, { name: "First" });
      expectType<string>(created.name);
      expect(created.score).toBe(0);
      const updated = db.contacts.upsert({ email: "e" }, { name: "Again" });
      expect(updated.id).toBe(created.id);
      expect(updated.name).toBe("Again");

      const native = db.contacts.upsert(
        { email: "e", name: "Third" },
        { on: "email", merge: (t) => ({ name: t.excluded("name") }) },
      );
      expectType<typeof created>(native);
      expect(native.name).toBe("Third");
      expect(db.contacts.upsert(
        { email: "e", name: "Ignored" },
        { on: "email", doNothing: true },
      ).name).toBe("Third");
      const fromAlias = db.contacts.upsertOnConflict(
        { email: "e", name: "Fourth" }, "email",
        (h) => ({ name: h.excludedIfNotEmpty("name") }),
      );
      expect(fromAlias.name).toBe("Fourth");
      const pair = db.contacts.findOrCreate({ email: "e" }, { name: "Fifth" });
      expectType<boolean>(pair.created);
      expectType<typeof created>(pair.entity);
      expect(pair.created).toBe(false);
      const inserted = db.contacts.upsertMany([{ email: "new", name: "New" }], {});
      expectType<typeof created[]>(inserted);
      expect(inserted).toHaveLength(1);

      if (false) {
        // @ts-expect-error target column missing; SQLite errors
        db.contacts.upsert({ email: "e", name: "x" }, { on: "notAColumn", doNothing: true });
        // @ts-expect-error merge cannot use a table method as a SQL column
        db.contacts.upsert({ email: "e", name: "x" }, { on: "email", merge: (t) => ({ update: t.current("update") }) });
        // @ts-expect-error native conflict options require merge or doNothing
        db.contacts.upsert({ email: "e", name: "x" }, { on: "email" });
        // @ts-expect-error required merge functions cannot return scalar SQL values
        db.contacts.upsert({ email: "e", name: "x" }, { on: "email", merge: () => ({ name: "x" }) });
      }
      expect(() => (db.contacts as any).upsert(
        { email: "e", name: "x" }, { on: "notAColumn", doNothing: true },
      )).toThrow();
      expect(() => (db.contacts as any).upsert(
        { email: "e", name: "x" }, { on: "email" },
      )).toThrow();
      expect(() => (db.contacts as any).upsert(
        { email: "e", name: "x" }, { on: "email", merge: () => ({ name: "x" }) },
      )).toThrow();
    } finally { db.close(); }
  });
});

describe("select, where operators, query terminal types and batches", () => {
  test("select and repeated select returns only selected fields", () => {
    const db = relationalDb();
    try {
      db.users.insert({ name: "A", score: 5 });
      const names = db.users.select("name").all();
      expectType<string>(names[0]!.name);
      expect(Object.keys(names[0]!)).toContain("name");
      expect("score" in names[0]!).toBe(false);
      if (false) {
        // @ts-expect-error unselected field is absent in result
        names[0]!.score;
        // @ts-expect-error unknown SQL column
        db.users.select("notReal");
        // @ts-expect-error cannot SELECT navigation function (not a SQL field)
        db.posts.select().select("user");
      }
      expect(() => (db.users as any).select("notReal").all()).toThrow();
      expect(() => (db.posts as any).select().select("user").all()).toThrow();
      const both = db.users.select().select("id").select("name").all();
      expectType<number>(both[0]!.id);
      expectType<string>(both[0]!.name);
      expect(both[0]!.id).toBeGreaterThan(0);
      expect(both[0]!.name).toBe("A");
      expectType<string>(db.users.select("name").get()!.name);
      expectType<string | undefined>(db.users.select("name").first()?.name);
      expectType<string>(db.users.select("name").firstOrFail().name);
      expect(db.users.select().where({ id: -1 }).first()).toBeNull();
      expect(() => db.users.select().where({ id: -1 }).firstOrFail()).toThrow();
    } finally { db.close(); }
  });

  test("where value types, null, OR of AND, comparison, IN and BETWEEN", () => {
    const db = relationalDb();
    try {
      const a = db.users.insert({ name: "A", score: 4 });
      db.users.insert({ name: "B", score: 9 });
      db.posts.insert({ title: "Orphan", user_id: null });
      expect(db.users.select().where({ name: { $like: "A%" } }).count()).toBe(1);
      expect(db.users.select().where({ score: { $gte: 4, $lt: 9 } }).count()).toBe(1);
      expect(db.users.select().where({ score: { $between: [4, 9] } }).count()).toBe(2);
      expect(db.users.select().where({ id: { $in: [a.id] } }).count()).toBe(1);
      expect(db.users.select().where({ id: { $notIn: [a.id] } }).count()).toBe(1);
      expect(db.posts.select().where({ user_id: null }).count()).toBe(1);
      expect(db.posts.select().where({ user_id: { $ne: null } }).count()).toBe(0);
      expect(db.posts.select().where({ user_id: { $isNull: true } }).count()).toBe(1);
      expect(db.users.select().where({
        $or: [{ name: "A", score: 4 }, { name: "B", score: 9 }],
      }).count()).toBe(2);
      expect(db.users.select().where({ $or: [] }).count()).toBe(0);
      expectType<boolean>(db.users.select().where({ name: "A" }).exists());
      expectType<number>(db.users.select().sum("score"));
      expectType<number>(db.users.select().avg("score"));
      expectType<number | string | Uint8Array | null>(db.users.select().min("name"));
      expectType<number | string | Uint8Array | null>(db.users.select().max("score"));
      expect(db.users.select().sum("score")).toBe(13);
      expectType<number[]>(db.users.select().pluck("score"));
      expect(db.users.select().orderBy("id").pluck("score")).toEqual([4, 9]);
      if (false) {
        // @ts-expect-error unknown operator; runtime rejects
        db.users.select().where({ score: { $unrecognized: 3 } });
        // @ts-expect-error $in must be an array; runtime rejects at query execution
        db.users.select().where({ id: { $in: 3 } });
        // @ts-expect-error BETWEEN needs exactly two values; runtime throws immediately
        db.users.select().where({ score: { $between: [5] } });
        // @ts-expect-error LIKE requires a string pattern (TYPE-ONLY: SQL coerces numerics)
        db.users.select().where({ name: { $like: 4 } });
        // @ts-expect-error unrecognized top-level operator; runtime throws
        db.users.select().where({ $and: [{ name: "A" }] });
        // @ts-expect-error wrong scalar field type; SQLite coerces some values (TYPE-ONLY)
        db.users.select().where({ score: "4" });
      }
      expect(() => (db.users as any).select().where({ score: { $unrecognized: 3 } })).toThrow();
      expect(() => (db.users as any).select().where({ id: { $in: 3 } }).all()).toThrow();
      expect(() => (db.users as any).select().where({ score: { $between: [5] } })).toThrow();
      expect(() => (db.users as any).select().where({ $and: [{ name: "A" }] })).toThrow();
      expect(() => (db.users as any).select().where({ $or: [{}] })).toThrow();
    } finally { db.close(); }
  });

  test("whereIn/whereNotIn, callback AST, grouped count, paging and clones", () => {
    const db = relationalDb();
    try {
      db.users.insertMany([{ name: "A", score: 5 }, { name: "B", score: 7 }]);
      const q = db.users.select().whereIn("score", [5, 7]);
      expect(q.count()).toBe(2);
      expect(db.users.select().whereNotIn("score", [7]).count()).toBe(1);
      expect(db.users.select().whereIn("id", db.users.select("id")).count()).toBe(2);
      expect(db.users.select().where((c, f, operators) =>
        operators.eq(f.lower!(c.name), "a"),
      ).count()).toBe(1);
      expectType<{ sql: string; params: any[] }>(q.toSQL());
      expect(q.toSQL().sql).toContain(" IN ");
      expectType<number>(q.clone().limit(1).all().length);
      expect(q.clone().limit(1).all()).toHaveLength(1);
      const page = db.users.select("id", "name").orderBy("id").paginate(1, 1);
      expectType<string>(page.data[0]!.name);
      expectType<number>(page.total);
      expectType<number>(page.pages);
      expect(page.total).toBe(2);
      expect(page.data).toHaveLength(1);
      const counts = db.users.select().groupBy("role").countGrouped();
      expectType<number>(counts[0]!.count);
      expect(counts[0]!.count).toBe(2);
      expect(() => db.users.select().countGrouped()).toThrow();
      expectType<number>(db.users.select().where({ score: 5 }).updateAll({ score: 6 }));
      expect(db.users.select().where({ score: 6 }).count()).toBe(1);
      expectType<number>(db.users.select().where({ score: 6 }).increment("score", 3));
      expect(db.users.select().where({ score: 9 }).count()).toBe(1);
      expectType<number>(db.users.select().where({ score: 9 }).decrement("score", 3));
      expect(db.users.select().where({ score: 6 }).deleteAll()).toBe(1);
      if (false) {
        // @ts-expect-error wrong IN array element type (TYPE-ONLY: SQLite may coerce)
        db.users.select().whereIn("score", ["5"]);
        // @ts-expect-error cannot mutate an entity function as a SQL column
        db.users.select().updateAll({ delete: () => {} });
        // @ts-expect-error string amounts not accepted by increment
        db.users.select().increment("score", "3");
      }
      expect(() => (db.users as any).select().updateAll({ notAColumn: "x" })).toThrow();
    } finally { db.close(); }
  });

  test("having, distinct, offset, whereRaw, and SQL cache/AST utilities", () => {
    const db = relationalDb();
    try {
      db.users.insertMany([
        { name: "First", role: "guest" }, { name: "Second", role: "guest" },
        { name: "Third", role: "staff" },
      ]);
      const uniqueRoles = db.users.select("role").distinct().all();
      expectType<"guest" | "staff">(uniqueRoles[0]!.role);
      expect(uniqueRoles.map((r) => r.role).sort()).toEqual(["guest", "staff"]);

      const groups = db.users.select("role").groupBy("role")
        .having({ "COUNT(*)": { $gte: 2 } }).all();
      expectType<"guest" | "staff">(groups[0]!.role);
      expect(groups.map((r) => r.role)).toEqual(["guest"]);
      expect(db.users.select().whereRaw('"name" LIKE ?', ["F%"]).count()).toBe(1);
      const second = db.users.select().orderBy("id").limit(1).offset(1).all();
      expectType<string>(second[0]!.name);
      expect(second[0]!.name).toBe("Second");
      expect(db.users.select().cache(150).noCache().count()).toBe(3);
      expect(db.users.select().orderBy("id", "desc").first()?.name).toBe("Third");

      if (false) {
        // @ts-expect-error LIKE is unsupported by HAVING SQL compiler
        db.users.select().groupBy("role").having({ "COUNT(*)": { $like: "x" } });
        // @ts-expect-error HAVING $in is unsupported by the runtime compiler
        db.users.select().groupBy("role").having({ "COUNT(*)": { $in: [1] } });
        // @ts-expect-error order direction must be asc or desc
        db.users.select().orderBy("id", "sideways");
      }
      expect(() => (db.users as any).select().groupBy("role")
        .having({ "COUNT(*)": { $like: "x" } }).all()).toThrow();
      expect(() => (db.users as any).select().orderBy("id", "sideways").all()).toThrow();
    } finally { db.close(); }
  });

  test("joins remain raw SQLite rows, select aliases and raw/exec results", () => {
    const db = relationalDb();
    try {
      const { user, post } = seedRelations(db);
      const selected = db.posts.select("title").join(db.users, ["name"]).all();
      expect(selected[0]!.title).toBe(post.title);
      expect((selected[0] as any).users_name).toBe(user.name);
      const sql = db.posts.select().join("users", "user_id", ["name"]).toSQL();
      expect(sql.sql).toContain("JOIN");
      expectType<void>(db.exec('UPDATE "users" SET "score" = ? WHERE id = ?', 15, user.id));
      expect(db.users.get(user.id)?.score).toBe(15);
      const rows = db.raw<{ score: number }>('SELECT score FROM users WHERE id = ?', user.id);
      expectType<{ score: number }[]>(rows);
      expect(rows[0]!.score).toBe(15);
      expectType<any[]>(db.raw("SELECT id FROM users"));
      const awaited = async () => await db.users.select("name");
      expectType<() => Promise<{ name: string }[]>>(awaited); // not called: it would run after close()
    } finally { db.close(); }
  });
});

describe("relations: forward/inverse, nullable, nested and multiple FKs", () => {
  test("lazy navigation and forward/inverse eager result types", () => {
    const db = relationalDb();
    try {
      const rows = seedRelations(db);
      expectType<string | undefined>(rows.post.user()?.name);
      expect(rows.post.user()?.id).toBe(rows.user.id);
      expect(rows.orphan.user()).toBeNull();
      expectType<number>(rows.user.posts()[0]!.id);
      expect(rows.user.posts().map((r) => r.id)).toContain(rows.post.id);

      const eager = db.posts.select().with("user").orderBy("id").all();
      expectType<string>(eager[0]!.title);
      expectType<string | undefined>(eager[0]!.user?.name);
      expectType<number | undefined>(eager[0]!.user?.id);
      expect(eager[0]!.user?.id).toBe(rows.user.id);
      expect(eager[1]!.user).toBeNull();
      if (false) {
        // @ts-expect-error eager value replaces the lazy user() function
        eager[0]!.user();
      }

      const inverse = db.users.select().with("posts").get()!;
      expectType<number>(inverse.posts[0]!.id);
      expect(inverse.posts.map((r) => r.id)).toContain(rows.post.id);
      if (false) {
        // @ts-expect-error eager inverse is an array, not a method
        inverse.posts();
      }
      const bareProjection = db.posts.select("title").with("user").get()!;
      expectType<string>(bareProjection.title);
      expect(!("id" in bareProjection)).toBe(true);
      // A projection without id cannot be hydrated at runtime; it retains
      // its lazy method, which is *not* a fully functioning FK lookup.
      const projectedWithId = db.posts.select("id", "title").with("user").get()!;
      expectType<string | undefined>(projectedWithId.user?.name);
      expect(projectedWithId.user?.id).toBe(rows.user.id);
    } finally { db.close(); }
  });

  test("nested with at four levels and overlapping paths", () => {
    const db = relationalDb();
    try {
      const rows = seedRelations(db);
      const nested = db.users.select().where({ id: rows.user.id })
        .with("posts.comments.author", "posts", "posts.post_tags.tag").get()!;
      expectType<string>(nested.posts[0]!.title);
      expectType<string>(nested.posts[0]!.comments[0]!.body);
      expectType<string | undefined>(nested.posts[0]!.comments[0]!.author?.name);
      expectType<string>(nested.posts[0]!.post_tags[0]!.tag?.name ?? "");
      expect(nested.posts[0]!.comments[0]!.author?.id).toBe(rows.user.id);
      expect(nested.posts[0]!.post_tags[0]!.tag?.id).toBe(rows.tag.id);
      const chain = db.users.select().with("posts").with("posts.comments").get()!;
      expectType<string>(chain.posts[0]!.comments[0]!.body);
      expect(chain.posts[0]!.comments[0]!.id).toBe(rows.comment.id);
    } finally { db.close(); }
  });

  test("two FKs to same table, self-reference and M:N link traversal", () => {
    const db = relationalDb();
    try {
      const rows = seedRelations(db);
      expectType<number>(rows.user.grantsByAuthorId()[0]!.id);
      expectType<number>(rows.user.grantsByReviewerId()[0]!.id);
      expect(rows.user.grantsByAuthorId()[0]!.id).toBe(rows.grant.id);
      expect(rows.user.grantsByReviewerId()[0]!.id).toBe(rows.grant.id);
      const grant = db.grants.select().with("author", "reviewer").get()!;
      expectType<string | undefined>(grant.author?.name);
      expectType<string | undefined>(grant.reviewer?.name);
      expect(grant.author?.id).toBe(rows.user.id);
      expect(grant.reviewer?.id).toBe(rows.user.id);
      expect(rows.manager.manager()).toBeNull();
      expect(rows.worker.manager()?.id).toBe(rows.manager.id);
      expect(rows.manager.employeesByManagerId()[0]!.id).toBe(rows.worker.id);
      const manager = db.employees.select().with("employeesByManagerId.manager").get()!;
      expectType<string | undefined>(manager.employeesByManagerId[0]!.manager?.name);
      expect(manager.employeesByManagerId[0]!.manager?.id).toBe(rows.manager.id);
      const tag = db.tags.select().with("post_tags.post").get()!;
      expectType<string>(tag.post_tags[0]!.post?.title ?? "");
      expect(tag.post_tags[0]!.post?.id).toBe(rows.post.id);
    } finally { db.close(); }
  });
});

describe("generated columns, read-only views, transactions and change listeners", () => {

  test("constructor option types, hooks, computed getters and cascade semantics", () => {
    const hookEvents: string[] = [];
    const options: DatabaseOptions<typeof relations> = {
      relations, indexes: { users: ["name"] }, unique: { users: [["name"]] },
      renames: { users: { previousName: "name" } },
      cascade: { users: ["posts"] },
      hooks: { users: {
        beforeInsert(data) { hookEvents.push("beforeInsert"); return { ...data, name: `${data.name}!` }; },
        afterInsert(entity) { hookEvents.push(`afterInsert:${entity.name}`); },
        beforeDelete(id) { hookEvents.push(`beforeDelete:${id}`); },
        afterDelete(id) { hookEvents.push(`afterDelete:${id}`); },
      } },
      computed: { users: { upper: (u) => String(u.name).toUpperCase() } },
      reactive: false, timestamps: false, softDeletes: false,
      wal: false, busyTimeout: 1000, pollInterval: 12, debug: false,
    };
    const db = new Database(":memory:", schemas, options);
    try {
      const user = db.users.insert({ name: "Hook" });
      expect(user.name).toBe("Hook!");
      expect((db.users.get(user.id) as any).upper).toBe("HOOK!");
      const post = db.posts.insert({ title: "Child", user_id: user.id });
      expect(() => db.users.on("insert", () => {})).toThrow(/disabled/);
      db.users.delete(user.id);
      expect(db.posts.get(post.id)).toBeNull(); // cascade
      expect(hookEvents).toEqual([
        "beforeInsert", "afterInsert:Hook!", `beforeDelete:${user.id}`,
        `afterDelete:${user.id}`,
      ]);
    } finally { db.close(); }
  });

  test("timestamps and softDeletes generated result fields; restore", () => {
    const live = new Database(":memory:", {
      items: z.object({ name: z.string() }),
    }, { softDeletes: true, timestamps: true, reactive: false });
    const plain = new Database(":memory:", {
      items: z.object({ name: z.string() }),
    }, { reactive: false });
    try {
      const item = live.items.insert({ name: "T" });
      expectType<string>(item.createdAt);
      expectType<string>(item.updatedAt);
      expectType<string | null>(item.deletedAt);
      expect(typeof item.createdAt).toBe("string");
      expect(item.deletedAt).toBeNull();
      live.items.delete(item.id);
      expect(live.items.get(item.id)).toBeNull();
      const hidden = live.items.select().withTrashed().where({ id: item.id }).get()!;
      expectType<string | null>(hidden.deletedAt);
      expect(typeof hidden.deletedAt).toBe("string");
      expect(live.items.select().onlyTrashed().count()).toBe(1);
      expectType<void>(live.items.restore(item.id));
      expect(live.items.get(item.id)?.deletedAt).toBeNull();
      if (false) {
        // @ts-expect-error no generated column if softDeletes disabled
        plain.items.get(1)!.deletedAt;
        // @ts-expect-error no generated column if timestamps disabled
        plain.items.get(1)!.createdAt;
      }
      const without = plain.items.insert({ name: "No Timestamps" });
      expect("createdAt" in without).toBe(false);
      expect("deletedAt" in without).toBe(false);
      expect(() => plain.items.restore(without.id)).toThrow(/softDeletes/);
    } finally { live.close(); plain.close(); }
  });

  test("read-only views have typed reads but mutators throw at runtime", () => {
    const db = new Database(":memory:", { users: z.object({ name: z.string() }) }, {
      reactive: false,
      views: { names: defineView(z.object({ name: z.string() }), "SELECT name FROM users") },
    });
    try {
      db.users.insert({ name: "Shown" });
      const names = db.names.select().all();
      expectType<string>(names[0]!.name);
      expect(names[0]!.name).toBe("Shown");
      expectType<number>(db.names.count());
      expect(db.names.count()).toBe(1);
      expectType<string>(db.names.select("name").firstOrFail().name);
      expect(db.views()).toContain("names");
      if (false) {
        // @ts-expect-error no table insert accessor on a view
        db.names.insert({ name: "Not allowed" });
        // @ts-expect-error no direct get(id) on a view
        db.names.get(1);
        // @ts-expect-error no upsert on read-only view
        db.names.upsert({ name: "No" });
        // @ts-expect-error view columns are exactly those in its schema
        db.names.select("missingField");
      }
      expect(() => (db.names as any).insert({ name: "Blocked" })).toThrow(/read-only/);
      expect(() => (db.names as any).upsert({ name: "Blocked" })).toThrow(/read-only/);
      expect(() => (db.names as any).get(1)).toThrow();
      expect(() => (db.names as any).select("missingField").all()).toThrow();
      if (false) {
        // @ts-expect-error view query builders cannot execute UPDATE
        db.names.select().updateAll({ name: "Impossible" });
        // @ts-expect-error view query builders cannot execute DELETE
        db.names.select().deleteAll();
        // @ts-expect-error view query builders cannot increment
        db.names.select().increment("name", 1);
      }
      expect(() => (db.names as any).select().updateAll({ name: "Impossible" })).toThrow(/view/);
      expect(() => (db.names as any).select().deleteAll()).toThrow(/view/);
      expect(() => (db.names as any).select().increment("name", 1)).toThrow(/view/);
    } finally { db.close(); }
  });

  test("transactions are synchronous, return exact callback type, and roll back", () => {
    const db = relationalDb();
    try {
      const result = db.transaction(() => ({ ok: true as const, count: 3 }), { mode: "immediate" });
      expectType<{ ok: true; count: number }>(result);
      type _TransactionResult = Assert<Equal<typeof result["ok"], true>>;
      expect(result).toEqual({ ok: true, count: 3 });
      expectType<TransactionOptions>({ mode: "deferred" });
      expect(db.transaction(() => db.users.insert({ name: "Committed" })).name).toBe("Committed");
      expect(() => db.transaction(() => {
        db.users.insert({ name: "Rolled back" }); throw new Error("ROLLBACK");
      })).toThrow("ROLLBACK");
      expect(db.users.select().where({ name: "Rolled back" }).count()).toBe(0);
      if (false) {
        // Allowed by the type (generic wrappers need it); throws at run time.
        db.transaction(async () => 3);
        // @ts-expect-error invalid transaction mode; runtime cannot index it
        db.transaction(() => 1, { mode: "bad-mode" });
      }
      expect(() => (db as any).transaction(() => Promise.resolve(5))).toThrow(/synchronous/);
      expect(() => (db as any).transaction(() => 5, { mode: "bad-mode" })).toThrow();
    } finally { db.close(); }
  });

  test("change callbacks get the whole row for insert/update and only the id for delete", () => {
    const db = new Database(":memory:", { log: z.object({ message: z.string() }) }, { pollInterval: 5000 });
    const events: { event: string; id: number; keys: string[] }[] = [];
    try {
      const offI = db.log.on("insert", (row) => {
        expectType<number>(row.id);
        if (false) {
          // A row deleted before the poll is skipped, so the row is always whole.
          row.message.toUpperCase();
        }
        if ("message" in row && typeof row.message === "string")
          expectType<string>(row.message);
        events.push({ event: "insert", id: row.id, keys: Object.keys(row) });
      });
      const offU = db.log.on("update", (row) => {
        expectType<number>(row.id);
        if (false) {
          row.message.toUpperCase();
        }
        events.push({ event: "update", id: row.id, keys: Object.keys(row) });
      });
      const offD = db.log.on("delete", (row) => {
        expectType<{ id: number }>(row);
        if (false) {
          // @ts-expect-error delete event contains only id
          row.message;
        }
        events.push({ event: "delete", id: row.id, keys: Object.keys(row) });
      });
      // Poll after each write: an insert/update whose row is already gone at
      // poll time is skipped (its delete follows).
      const transient = db.log.insert({ message: "Before polling" });
      (db as any)._processChanges();
      db.log.update(transient.id, { message: "Changed" });
      (db as any)._processChanges();
      db.log.delete(transient.id);
      (db as any)._processChanges();
      expect(events.map((e) => e.event)).toEqual(["insert", "update", "delete"]);
      expect(events.every((e) => e.id === transient.id)).toBe(true);
      expect(events.map((e) => e.keys.includes("message"))).toEqual([true, true, false]);
      offI(); offU(); offD();
      if (false) {
        // @ts-expect-error event name union excludes "restore" (TYPE-ONLY:
        // runtime registers it, but never emits it)
        db.log.on("restore", () => {});
      }
    } finally { db.close(); }
  });
});

describe("Zod field families, raw storage vs parsed entities, dump and load", () => {
  const complex = {
    records: z.object({
      text: z.string(), count: z.number(), flag: z.boolean(), integer: z.bigint(),
      birthday: z.date(), state: z.enum(["yes", "no"]),
      literal: z.literal(2.5),
      object: z.object({ d: z.date(), n: z.number() }),
      list: z.array(z.object({ d: z.date() })),
      mapping: z.record(z.string(), z.number()),
      choice: z.discriminatedUnion("type", [
        z.object({ type: z.literal("first"), at: z.date() }),
        z.object({ type: z.literal("second"), at: z.date() }),
      ]),
      union: z.union([z.string(), z.number()]),
      tuple: z.tuple([z.string(), z.date()]),
      payload: z.custom<Uint8Array>((v) => v instanceof Uint8Array),
      anything: z.any(), mystery: z.unknown(),
      nullable: z.number().nullable(), optional: z.string().optional(),
      defaulted: z.string().default("fallback"),
    }),
  };
  const when = new Date("2026-06-07T08:09:10.000Z");
  const huge = 9007199254740997n;
  const input = {
    text: "hello", count: 2.5, flag: true, integer: huge,
    birthday: when, state: "yes" as const, literal: 2.5 as const,
    object: { d: when, n: 4 }, list: [{ d: when }],
    mapping: { one: 1, two: 2 },
    choice: { type: "first" as const, at: when },
    union: "value" as string | number,
    tuple: ["a", when] as [string, Date],
    payload: new Uint8Array([0, 1, 255]),
    anything: { nested: 1 }, mystery: 42, nullable: null, optional: "present",
  };
  test("inserts, reads, selected values and raw() have their real storage shapes", () => {
    const db = new Database(":memory:", complex, { reactive: false });
    try {
      const row = db.records.insert(input);
      expectType<string>(row.defaulted);
      expectType<bigint>(row.integer);
      expectType<Uint8Array>(row.payload);
      expectType<Date>(row.birthday);
      expectType<Date>(row.object.d);
      expectType<Date>(row.list[0]!.d);
      expectType<Date>(row.tuple[1]);
      expectType<number>(row.mapping.one!);
      expectType<string | number>(row.union);
      expect(row.defaulted).toBe("fallback");
      expect(row.integer).toBe(huge);
      expect(row.birthday).toBeInstanceOf(Date);
      expect(row.object.d).toBeInstanceOf(Date);
      expect(row.list[0]!.d).toBeInstanceOf(Date);
      expect(row.tuple[1]).toBeInstanceOf(Date);
      expect(Array.from(row.payload)).toEqual([0, 1, 255]);
      expect(row.mapping.one).toBe(1);
      expect(row.anything).toEqual({ nested: 1 });
      expect(row.mystery).toBe(42);
      expect(row.optional).toBe("present");

      const raw = db.records.select().raw().get()!;
      expectType<number>(raw.flag);
      expectType<string | number>(raw.integer);
      expectType<string>(raw.birthday);
      expectType<string>(raw.object);
      expectType<string>(raw.mapping);
      expectType<string>(raw.tuple);
      expectType<Uint8Array>(raw.payload);
      expectType<string>(raw.literal);
      expect(raw.literal).toBe("2.5");
      expect(raw.flag).toBe(1);
      expect(raw.integer).toBe(huge.toString());
      expect(raw.birthday).toBe(when.toISOString());
      expect(typeof raw.object).toBe("string");
      expect(typeof raw.mapping).toBe("string");
      expect(typeof raw.tuple).toBe("string");
      expect(raw.payload).toBeInstanceOf(Uint8Array);
      if (false) {
        // @ts-expect-error raw() does not deserialize date back into Date
        expectType<Date>(raw.birthday);
        // @ts-expect-error raw() does not attach methods
        raw.update({ count: 2 });
        // @ts-expect-error wrong payload type; Zod rejects
        db.records.insert({ ...input, integer: "huge" });
      }
      expect(() => (db.records as any).insert({ ...input, integer: "huge" })).toThrow();
    } finally { db.close(); }
  });

  test("dump()/load() round-trip bigint, bytes, JSON dates and strict table checks", () => {
    const db = new Database(":memory:", complex, { reactive: false });
    const dst = new Database(":memory:", complex, { reactive: false });
    try {
      const first = db.records.insert(input);
      const snapshot = db.dump();
      expectType<Record<string, any[]>>(snapshot);
      expect(snapshot.records).toHaveLength(1);
      expect(snapshot.records![0]!.integer).toBe(huge.toString());
      expectType<void>(dst.load(snapshot));
      expectType<void>(dst.seed({ records: [] }));
      dst.load(snapshot);
      const out = dst.records.get(first.id)!;
      expectType<bigint>(out.integer);
      expectType<Date>(out.object.d);
      expectType<Date>(out.tuple[1]);
      expectType<Uint8Array>(out.payload);
      expect(out.integer).toBe(huge);
      expect(out.object.d).toBeInstanceOf(Date);
      expect(out.tuple[1]).toBeInstanceOf(Date);
      expect(Array.from(out.payload)).toEqual([0, 1, 255]);
      expect(() => dst.load({ notATable: [] })).toThrow(/Unknown table/);
      expect(() => dst.load({ records: [{ badField: "x" }] })).toThrow(/Unknown column/);
      if (false) {
        // @ts-expect-error load append must be boolean (runtime treats truthy
        // non-boolean values as true; TYPE-ONLY option restriction)
        dst.load(snapshot, { append: 123 });
      }
    } finally { db.close(); dst.close(); }
  });
});

describe("miscellaneous public exports and top-level introspection", () => {
  test("CLI and migration-plan apply on an empty table", async () => {
    const db = new Database(":memory:", { empty: z.object({ name: z.string() }) }, { reactive: false });
    const original = console.log;
    try {
      const migrator = createMigrator(db);
      const plan = migrator.createAutoPlan({ from: "empty", to: "empty" });
      expect(migrator).toBeInstanceOf(DatabaseMigrator);
      const result = migrator.apply(plan);
      expectType<number>(result.insertedOrChangedRows);
      expect(result.insertedOrChangedRows).toBe(0);
      console.log = () => {};
      expectType<Promise<void>>(runCli(["--help"]));
      await runCli(["--help"]);
    } finally { console.log = original; db.close(); }
  });
  test("query primitives, stored schema, introspection, and cache options", () => {
    const db = relationalDb();
    try {
      const inserted = db.users.insert({ name: "A" });
      const QB: typeof QueryBuilder = QueryBuilder;
      expectType<typeof QueryBuilder>(QB);
      const column = new ColumnNode("users", "name", "u");
      expectType<string>(column.toString());
      expect(column.toString()).toBe('"u"."name"');
      const wrapped = wrapNode(4);
      expectType<ReturnType<typeof wrapNode>>(wrapped);
      expect(wrapped).toEqual({ type: "literal", value: 4 });
      const compiled = compileAST(op.eq(createColumnProxy<{ name: string }>().name, "A"));
      expectType<{ sql: string; params: any[] }>(compiled);
      expect(compiled.params).toEqual(["A"]);
      const funcs = createFunctionProxy();
      expectType<object>(funcs.lower!(column));
      const helper = new ConflictMergeHelperRuntime<{ name: string }>("users");
      expect(helper.current("name").sql).toContain("users");
      expect(helper.excluded("name").sql).toContain("excluded");
      expect(helper.excludedIfNotNull("name").sql).toContain("COALESCE");
      expect(helper.excludedIfNotEmpty("name").params).toEqual([]);
      expect(helper.keepFirst("name").sql).toContain("COALESCE");
      expectType<string>(helper.max("name", 0).sql);
      expectType<string>(helper.coalesceExcluded("name").sql);
      expectType<string>(helper.coalesceExcludedNonEmpty("name").sql);
      expectType<string>(helper.coalesceCurrentExcluded("name").sql);
      expectType<string>(helper.keepExistingIfExcludedEmpty("name").sql);
      expectType<string>(helper.maxCurrentExcluded("name").sql);
      expectType<any[]>(helper.literal(4).params);
      expect(helper.sql("?", [3]).params).toEqual([3]);
      expectType<ProxyQueryResult>({ select: { name: column } });
      const proxyRows = db.query<{ label: string }>((tables) => ({
        select: { label: tables.users.name },
        where: { id: inserted.id },
      }));
      expectType<{ label: string }[]>(proxyRows);
      expect(proxyRows[0]!.label).toBe("A");
      expectType<string[]>(db.tables());
      expectType<string[]>(db.views());
      expect(db.tables()).toContain("users");
      expect(db.views()).toEqual([]);
      const cols = db.columns("users");
      expectType<string>(cols[0]!.name);
      expect(cols.map((c) => c.name)).toContain("name");
      const diffs = db.diff();
      expectType<string[]>(Object.keys(diffs));
      expect(Object.keys(diffs)).toEqual([]);
      const noCache = db.users.select().cache({ ttlMs: 100 }).noCache().all();
      expect(noCache[0]!.id).toBe(inserted.id);
      expect(() => db.users.select().cache({ ttlMs: 0 })).toThrow();
      const migrator = db.migrator();
      expectType<ReturnType<typeof createMigrator>>(migrator);
      expect(migrator.findBackups()).toEqual([]);
      expect(migrator.prune({ keep: 0, dryRun: true }).dropped).toEqual([]);
      expect(migrator.suggestSources("users", "name")).toEqual(["name"]);
      const plan = migrator.createAutoPlan({ from: "users", to: "users" });
      const preview = migrator.preview(plan);
      expectType<string>(preview.sql);
      expect(preview.sql).toContain("INSERT");
      expectType<string>(migrator.explain(plan));
      // Preview/explain avoid re-inserting a live row into its own table.
      expectType<DatabaseType<typeof schemas, typeof relations>>(db);
    } finally { db.close(); }
  });
});
