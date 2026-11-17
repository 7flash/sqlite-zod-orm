// @ts-nocheck: deliberately written for sqlite-zod-orm 3.x, scanned by upgrade-check tests.
import { Database, z } from "sqlite-zod-orm";

export const db = new Database("app.db", {
  users: z.object({ name: z.string(), score: z.number(), big: z.bigint() }),
  posts: z.object({ title: z.string(), user_id: z.number() }),
}, {
  softDeletes: true,
  relations: { posts: { user_id: "users" } },
  cascade: { users: ["posts"] },
  hooks: {
    users: { beforeInsert: async (data) => data },
  },
});

export async function save(rows: any[]) {
  db.transaction(async () => {
    for (const row of rows) db.users.insert(row);
  });
}

export function report() {
  const byJson = db.users.select().where({ "json_extract(data, '$.name')": "a" }).all();
  const totals = db.users
    .select("name")
    .groupBy("name")
    .sum("score");
  const groups = db.users.select().groupBy("name").count();
  const sorted = db.users.select().orderBy("name", "DOWN").all();
  const mixed = db.users.select().where({ name: "a" }).where((c, f) => f.gt(c.score, 1)).all();
  db.users.restore(1);
  db.seed({ users: [] });
  return { byJson, totals, groups, sorted, mixed };
}
