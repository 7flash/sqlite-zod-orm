import { expect, test } from "bun:test";
import { Database, z } from "../src/index";
function chain(softDeletes = false, hooks: any = {}) {
  return new Database(":memory:", {
    roots: z.object({ name: z.string() }), branches: z.object({ root_id: z.number().nullable() }),
    leaves: z.object({ branch_id: z.number().nullable() }),
  }, {
    reactive: false, softDeletes, hooks,
    relations: { branches: { root_id: "roots" }, leaves: { branch_id: "branches" } },
    cascade: { roots: ["branches"], branches: ["leaves"] },
  });
}
function seed(db: ReturnType<typeof chain>) {
  const root = db.roots.insert({ name: "r" });
  const branch = db.branches.insert({ root_id: root.id });
  const leaf = db.leaves.insert({ branch_id: branch.id });
  return { root, branch, leaf };
}
test("three levels, row hooks once, child before parent", () => {
  const events: string[] = [];
  const hooks = Object.fromEntries(["roots", "branches", "leaves"].map((table) => [table, {
    beforeDelete: (id: number) => { events.push(`before:${table}:${id}`); },
    afterDelete: (id: number) => { events.push(`after:${table}:${id}`); },
  }]));
  const db = chain(false, hooks);
  const { root, branch, leaf } = seed(db);
  db.roots.delete(root.id);
  for (const table of ["roots", "branches", "leaves"])
    expect(db.raw(`SELECT id FROM "${table}"`)).toEqual([]);
  expect(events).toEqual([`before:roots:${root.id}`, `before:branches:${branch.id}`,
    `before:leaves:${leaf.id}`, `after:leaves:${leaf.id}`, `after:branches:${branch.id}`, `after:roots:${root.id}`]);
  db.close();
});
test("entity.delete traverses a self-referential cycle once", () => {
  const db = new Database(":memory:", { nodes: z.object({ parent_id: z.number().nullable() }) }, {
    reactive: false, relations: { nodes: { parent_id: "nodes" } }, cascade: { nodes: ["nodes"] },
  });
  const a = db.nodes.insert({ parent_id: null });
  const b = db.nodes.insert({ parent_id: a.id });
  db.nodes.update(a.id, { parent_id: b.id });
  db.nodes.get(a.id)!.delete();
  expect(db.raw("SELECT id FROM nodes")).toEqual([]);
  db.close();
});
test("two-table cycle visits both rows once", () => {
  const events: string[] = [];
  const db = new Database(":memory:", {
    alphas: z.object({ beta_id: z.number().nullable() }), betas: z.object({ alpha_id: z.number().nullable() }),
  }, {
    reactive: false, relations: { alphas: { beta_id: "betas" }, betas: { alpha_id: "alphas" } },
    cascade: { alphas: ["betas"], betas: ["alphas"] },
    hooks: { alphas: { afterDelete: () => { events.push("a"); } },
             betas: { afterDelete: () => { events.push("b"); } } },
  });
  const a = db.alphas.insert({ beta_id: null });
  const b = db.betas.insert({ alpha_id: a.id });
  db.alphas.update(a.id, { beta_id: b.id });
  db.alphas.delete(a.id);
  for (const table of ["alphas", "betas"])
    expect(db.raw(`SELECT id FROM "${table}"`)).toEqual([]);
  expect(events).toEqual(["b", "a"]);
  db.close();
});
test("soft cascades retain rows, including grandchildren", () => {
  const events: string[] = [];
  const db = chain(true, { leaves: { afterDelete: () => { events.push("leaf"); } } });
  const { root, branch, leaf } = seed(db);
  db.roots.delete(root.id);
  for (const [table, id] of [["roots", root.id], ["branches", branch.id], ["leaves", leaf.id]] as const)
    expect(db.raw<{ deletedAt: string | null }>(`SELECT "deletedAt" FROM "${table}" WHERE id = ?`, id)[0]?.deletedAt).toBeTruthy();
  db.roots.delete(root.id);
  expect(events).toEqual(["leaf"]);
  db.close();
});
for (const mode of ["throw", "veto"] as const) {
  test(`descendant ${mode} rolls back the full cascade`, () => {
    // Before-hooks run inside the cascade transaction, so a throw or a veto
    // rolls everything back; after-hooks run after commit (like upsert's).
    const db = chain(false, { leaves: {
      beforeDelete: mode === "veto" ? () => false as const : () => { throw new Error("stop"); },
    } });
    const { root, branch, leaf } = seed(db);
    expect(() => db.roots.delete(root.id)).toThrow(mode === "throw" ? "stop" : "Cascade cancelled");
    for (const [table, id] of [["roots", root.id], ["branches", branch.id], ["leaves", leaf.id]] as const)
      expect(db.raw(`SELECT id FROM "${table}" WHERE id = ?`, id)).toHaveLength(1);
    db.close();
  });
}
test("nullable FK is nulled only for hard deletes without configured cascade", () => {
  for (const softDeletes of [false, true]) {
    const db = new Database(":memory:", {
      parents: z.object({ name: z.string() }), children: z.object({ parent_id: z.number().nullable() }),
    }, { reactive: false, softDeletes, relations: { children: { parent_id: "parents" } } });
    const p = db.parents.insert({ name: "p" });
    const c = db.children.insert({ parent_id: p.id });
    db.parents.delete(p.id);
    expect(db.raw<{ parent_id: number | null }>("SELECT parent_id FROM children WHERE id = ?", c.id)[0]?.parent_id).toBe(softDeletes ? p.id : null);
    db.close();
  }
});

test("a cascade entry naming an unknown or unrelated table is refused at startup", () => {
  const schemas = { authors: z.object({ name: z.string() }), books: z.object({ title: z.string(), author_id: z.number() }) };
  const open = (opts: any) => () => new Database(":memory:", schemas, { reactive: false, ...opts }).close();
  expect(open({ cascade: { writers: ["books"] } })).toThrow("cascade: unknown table 'writers'");
  expect(open({ relations: { books: { author_id: "authors" } }, cascade: { authors: ["pamphlets"] } }))
    .toThrow("cascade: unknown table 'pamphlets'");
  expect(open({ cascade: { authors: ["books"] } })).toThrow("has no relation to 'authors'");
  expect(open({ relations: { books: { author_id: "authors" } }, cascade: { authors: ["books"] } })).not.toThrow();
});
