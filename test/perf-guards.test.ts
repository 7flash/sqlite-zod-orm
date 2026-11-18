import { describe, expect, test } from "bun:test";
import { Database, z } from "../src/index";

describe("hot-path SQL guards", () => {
  test("insertMany looks up one prepared INSERT and hydrates in bounded batches", () => {
    const db = new Database(":memory:", {
      events: z.object({
        code: z.string(),
        n: z.number(),
        details: z.object({ flag: z.boolean(), label: z.string() }),
      }),
    }, { reactive: true, timestamps: true, softDeletes: true });
    try {
      const ctx = (db as any)._ctx;
      const original = ctx._stmt;
      const sql: string[] = [];
      ctx._stmt = (statement: string) => {
        sql.push(statement);
        return original(statement);
      };
      const count = 910; // two 900-element chunks, not 910 point lookups
      const rows = Array.from({ length: count }, (_, i) => ({
        code: `e${i}`, n: i,
        details: { flag: i % 2 === 0, label: `label-${i}` },
      }));
      const result = db.events.insertMany(rows);
      expect(result.length).toBe(count);
      expect(result[0]!.code).toBe("e0");
      expect(result[count - 1]!.details.label).toBe(`label-${count - 1}`);
      expect(result[0]!.createdAt).toBeTruthy();
      expect(sql.filter(s => s.startsWith('INSERT INTO "events"')).length).toBe(1);
      expect(sql.filter(s => s.startsWith('SELECT * FROM "events"')).length).toBe(2);
      const selected = db.events.select().where({ n: 12 }).get();
      expect(selected!.details).toEqual(rows[12]!.details);
      expect(selected!.createdAt).toBe(result[12]!.createdAt);
    } finally {
      db.close();
    }
  });

  for (const softDeletes of [false, true]) {
    test(`nested .with loads a bounded number of statements (softDeletes=${softDeletes})`, () => {
      const db = new Database(":memory:", {
        users: z.object({ name: z.string() }),
        posts: z.object({ user_id: z.number(), title: z.string() }),
        comments: z.object({ post_id: z.number(), user_id: z.number(), body: z.string() }),
      }, {
        reactive: false, softDeletes,
        relations: {
          posts: { user_id: "users" },
          comments: { post_id: "posts", user_id: "users" },
        },
      });
      try {
        const users = db.users.insertMany(
          Array.from({ length: 8 }, (_, i) => ({ name: `u${i}` })),
        );
        const posts = db.posts.insertMany(
          Array.from({ length: 32 }, (_, i) => ({
            user_id: users[i % users.length]!.id, title: `p${i}`,
          })),
        );
        db.comments.insertMany(
          Array.from({ length: 64 }, (_, i) => ({
            post_id: posts[i % posts.length]!.id,
            user_id: users[i % users.length]!.id,
            body: `c${i}`,
          })),
        );
        const ctx = (db as any)._ctx;
        const original = ctx._stmt;
        const selects: string[] = [];
        ctx._stmt = (sql: string) => {
          if (sql.startsWith("SELECT ")) selects.push(sql);
          return original(sql);
        };
        const eager = db.users.select().with("posts.comments.user").all();
        // root + users.posts + posts.comments + comments.user, with no
        // redundant lookup of a FK already included in the loaded comment.
        expect(selects.length).toBe(4);
        expect(eager.length).toBe(8);
        for (const user of eager) {
          expect(user.posts.length).toBe(4);
          for (const p of user.posts) {
            expect(p.comments.length).toBe(2);
            expect(p.comments[0]!.user?.name).toMatch(/^u[0-7]$/);
          }
        }
        selects.length = 0;
        const forward = db.posts.select().with("user").all();
        expect(selects.length).toBe(2); // post rows have their FK
        expect(forward[0]!.user?.id).toBe(users[0]!.id);

        selects.length = 0;
        // When the selection lacks its FK, fall back to a batched FK query.
        const projected = db.posts.select("id").with("user").all();
        expect(selects.length).toBe(3);
        expect(projected[0]!.user?.id).toBe(users[0]!.id);
      } finally {
        db.close();
      }
    });
  }

  test("update(id) without hooks uses one UPDATE + one readback; assignment does too", () => {
    for (const softDeletes of [false, true]) {
      const db = new Database(":memory:", {
        items: z.object({ title: z.string(), score: z.number() }),
      }, { reactive: true, timestamps: true, softDeletes });
      try {
        const entity = db.items.insert({ title: "initial", score: 1 });
        const ctx = (db as any)._ctx;
        const original = ctx._stmt;
        const sql: string[] = [];
        ctx._stmt = (statement: string) => {
          sql.push(statement);
          return original(statement);
        };

        const result = db.items.update(entity.id, { title: "updated" });
        expect(result?.title).toBe("updated");
        expect(result?.updatedAt).toBeTruthy();
        expect(sql.filter(q => q.startsWith('UPDATE "items"'))).toHaveLength(1);
        expect(sql.filter(q => q.startsWith('SELECT * FROM "items"'))).toHaveLength(1);
        expect(sql.some(q => q.includes("changes()"))).toBe(false);
        expect(sql).toHaveLength(2);

        sql.length = 0;
        entity.title = "assigned";
        expect(db.items.get(entity.id)?.title).toBe("assigned");
        // The extra get above is for the assertion, not the assignment.
        expect(sql.filter(q => q.startsWith('UPDATE "items"'))).toHaveLength(1);
        expect(sql.filter(q => q.startsWith('SELECT * FROM "items"'))).toHaveLength(2);
        expect(sql.some(q => q.includes("changes()"))).toBe(false);
      } finally {
        db.close();
      }
    }
  });

  test("afterUpdate keeps accurate changes() and reflects AFTER trigger values", () => {
    const calls: string[] = [];
    const db = new Database(":memory:", {
      items: z.object({ title: z.string() }),
    }, { hooks: { items: { afterUpdate: (row: any) => calls.push(row.title) } } });
    try {
      const entity = db.items.insert({ title: "initial" });
      const ctx = (db as any)._ctx;
      ctx.db.run(`CREATE TRIGGER uppercase_title AFTER UPDATE ON "items"
        WHEN NEW.title != upper(NEW.title)
        BEGIN UPDATE "items" SET title = upper(NEW.title) WHERE id = NEW.id; END`);
      ctx.db.run(`CREATE TRIGGER ignore_title BEFORE UPDATE ON "items"
        WHEN NEW.title = 'ignore'
        BEGIN SELECT RAISE(IGNORE); END`);
      const original = ctx._stmt;
      const sql: string[] = [];
      ctx._stmt = (statement: string) => {
        sql.push(statement);
        return original(statement);
      };

      const returned = db.items.update(entity.id, { title: "mixed" });
      expect(returned?.title).toBe("MIXED");
      expect(calls).toEqual(["MIXED"]);
      expect(sql.filter(q => q.includes("changes()"))).toHaveLength(1);
      expect(sql.filter(q => q.startsWith('SELECT * FROM "items"'))).toHaveLength(1);
      sql.length = 0;
      const unchanged = db.items.update(entity.id, { title: "ignore" });
      expect(unchanged?.title).toBe("MIXED");
      expect(calls).toEqual(["MIXED"]); // BEFORE trigger suppressed the write
      expect(sql.filter(q => q.includes("changes()"))).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("plain reads avoid timing callbacks and select().get uses statement.get", () => {
    const db = new Database(":memory:", {
      items: z.object({
        label: z.string(),
        meta: z.object({ nested: z.object({ a: z.string(), b: z.number() }) }),
        tags: z.array(z.string()),
        enabled: z.boolean(),
      }),
    }, { reactive: false });
    try {
      const entity = db.items.insert({
        label: "one", meta: { nested: { a: "x", b: 42 } },
        tags: ["a", "b"], enabled: true,
      });
      const ctx = (db as any)._ctx;
      ctx._m = () => { throw new Error("instrumentation on a non-debug connection"); };
      const original = ctx._stmt;
      let gets = 0;
      let alls = 0;
      ctx._stmt = (statement: string) => {
        const prepared = original(statement);
        return {
          get: (...args: any[]) => { gets++; return prepared.get(...args); },
          all: (...args: any[]) => { alls++; return prepared.all(...args); },
          run: (...args: any[]) => prepared.run(...args),
        };
      };
      const firstBuilder = db.items.select();
      const secondBuilder = db.items.select();
      // The executor, SQL resolver and relation loader are shared by all
      // builders for a table, instead of allocating a set of closures per read.
      expect((firstBuilder as any).executor).toBe((secondBuilder as any).executor);
      expect((firstBuilder as any).eagerLoader).toBe((secondBuilder as any).eagerLoader);
      const single = firstBuilder.where({ id: entity.id }).get();
      expect(single?.meta).toEqual({ nested: { a: "x", b: 42 } });
      expect(single?.tags).toEqual(["a", "b"]);
      expect(single?.enabled).toBe(true);
      expect(gets).toBe(1);
      expect(alls).toBe(0);
      expect(db.items.get(entity.id)?.label).toBe("one");
      expect(gets).toBe(2);
      const multiple = secondBuilder.all();
      expect(multiple).toHaveLength(1);
      expect(alls).toBe(1);
      expect(single).not.toBe(multiple[0]);
      // Ordinary read entities keep the original independently-persisting API.
      single!.label = "changed";
      expect(db.items.get(entity.id)?.label).toBe("changed");
      expect(db.items.insert({ label: "two", meta: { nested: { a: "y", b: 3 } },
        tags: ["c"], enabled: false }).label).toBe("two");
    } finally {
      db.close();
    }
  });

  test("nested date and boolean revival is not bypassed by JSON-only fast paths", () => {
    const db = new Database(":memory:", {
      records: z.object({
        info: z.object({ when: z.date(), flag: z.boolean(), label: z.string() }),
      }),
    });
    try {
      const instant = new Date("2026-01-02T03:04:05.000Z");
      const entity = db.records.insert({ info: { when: instant, flag: true, label: "ISO" } });
      const reread = db.records.get(entity.id)!;
      expect(reread.info.when).toBeInstanceOf(Date);
      expect(reread.info.when.toISOString()).toBe(instant.toISOString());
      expect(reread.info.flag).toBe(true);
      expect(reread.info.label).toBe("ISO");
    } finally {
      db.close();
    }
  });

  test("eager loading chunks large parent ID sets", () => {
    const db = new Database(":memory:", {
      parents: z.object({ name: z.string() }),
      children: z.object({ parent_id: z.number(), name: z.string() }),
    }, {
      reactive: false,
      relations: { children: { parent_id: "parents" } },
    });
    try {
      const parents = db.parents.insertMany(
        Array.from({ length: 910 }, (_, i) => ({ name: `p${i}` })),
      );
      db.children.insertMany(parents.map(p => ({ parent_id: p.id, name: "kid" })));
      const ctx = (db as any)._ctx;
      const original = ctx._stmt;
      let reads = 0;
      ctx._stmt = (sql: string) => {
        if (sql.startsWith("SELECT ")) reads++;
        return original(sql);
      };
      const loaded = db.parents.select().with("children").all();
      expect(loaded.length).toBe(910);
      expect(loaded.every(p => p.children.length === 1)).toBe(true);
      expect(reads).toBe(3); // root SELECT plus ceil(910/900) relation SELECTs
    } finally {
      db.close();
    }
  });
});
