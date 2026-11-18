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
