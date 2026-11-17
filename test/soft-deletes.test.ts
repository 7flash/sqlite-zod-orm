import { expect, test } from "bun:test";
import { Database, z } from "../src";
function fixture(cascades = false) {
  return new Database(":memory:", {
    users: z.object({ email: z.string(), name: z.string() }),
    posts: z.object({ user_id: z.number(), title: z.string() }),
  }, {
    softDeletes: true, reactive: false,
    relations: { posts: { user_id: "users" } },
    unique: { users: [["email"]] },
    cascade: cascades ? { users: ["posts"] } : {},
  });
}
test("default reads and callback WHERE exclude trashed; opt-in and restore work", () => {
  const db = fixture();
  try {
    const u = db.users.insert({ email: "a@b", name: "A" });
    db.users.delete(u.id);
    expect(db.users.get(u.id)).toBeNull();
    expect(db.users.update(u.id, { name: "X" })).toBeNull();
    expect(db.users.update({ name: "X" }).where({ id: u.id }).exec()).toBe(0);
    expect(db.users.count()).toBe(0);
    expect(db.users.select().all()).toEqual([]);
    expect(db.users.select().get()).toBeNull();
    expect(db.users.select().count()).toBe(0);
    expect(db.users.select().exists()).toBe(false);
    const callback = db.users.select().where((c, f, op) => op.eq(c.email, "a@b"));
    expect(callback.all()).toEqual([]);
    expect(callback.count()).toBe(0);
    expect(callback.exists()).toBe(false);
    expect(db.users.select().withTrashed().count()).toBe(1);
    expect(db.users.select().onlyTrashed().get()?.id).toBe(u.id);
    db.users.restore(u.id);
    expect(db.users.get(u.id)?.id).toBe(u.id);
    expect(db.users.get(u.id)?.name).toBe("A");
    expect(db.users.select().onlyTrashed().count()).toBe(0);
  } finally { db.close(); }
});
test("joins, eager loading and lazy accessors exclude deleted relations", () => {
  const db = fixture();
  try {
    const u = db.users.insert({ email: "a@b", name: "A" });
    const p = db.posts.insert({ user_id: u.id, title: "P" });
    db.posts.delete(p.id);
    expect(u.posts()).toEqual([]);
    expect((db.users.select().with("posts").get() as any).posts).toEqual([]);
    expect(db.users.select().join("posts", "id", ["title"], "user_id").all()).toEqual([]);
    db.posts.restore(p.id);
    db.users.delete(u.id);
    expect(p.user()).toBeNull();
    expect(db.posts.select().join("users", "user_id", ["email"]).all()).toEqual([]);
  } finally { db.close(); }
});
test("upsert resurrects a retained unique key and an explicit id", () => {
  const db = fixture();
  try {
    const u = db.users.insert({ email: "a@b", name: "old" });
    db.users.delete(u.id);
    const restored = db.users.upsert({ email: "a@b" }, { name: "new" });
    expect(restored.id).toBe(u.id);
    expect(db.users.get(u.id)?.name).toBe("new");
    expect(db.users.select().count()).toBe(1);
    db.users.delete(u.id);
    expect(db.users.upsert({}, { id: u.id, name: "again" } as any).id).toBe(u.id);
    expect(db.users.select().withTrashed().count()).toBe(1);
  } finally { db.close(); }
});
test("entity cascade and builder bulk deletion retain tombstones", () => {
  const db = fixture(true);
  try {
    const u = db.users.insert({ email: "a@b", name: "A" });
    const p = db.posts.insert({ user_id: u.id, title: "P" });
    u.delete();
    expect(db.users.get(u.id)).toBeNull();
    expect(db.posts.get(p.id)).toBeNull();
    expect(db.posts.select().withTrashed().count()).toBe(1);
    expect(db.posts.delete().where({ id: p.id }).exec()).toBe(0);
    const other = db.users.insert({ email: "c@d", name: "C" });
    const child = db.posts.insert({ user_id: other.id, title: "Q" });
    expect(db.users.select().where({ id: other.id }).deleteAll()).toBe(1);
    expect(db.posts.get(child.id)).toBeNull();
    expect(db.users.select().withTrashed().count()).toBe(2);
    expect(db.users.select().count()).toBe(0);
  } finally { db.close(); }
});
