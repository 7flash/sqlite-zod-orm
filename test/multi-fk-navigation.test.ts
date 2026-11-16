import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Database } from "../src";
import { parseRelationsConfig } from "../src/schema";

describe("FK-qualified inverse navigation", () => {
  test("three references to agents stay distinct in lazy and eager reads", () => {
    const schemas = {
      agents: z.object({ name: z.string() }),
      grants: z.object({
        authorRef: z.number(), agentRef: z.number(),
        auditorRef: z.number().nullable(), label: z.string(),
      }),
    };
    const config = { grants: {
      authorRef: "agents", agentRef: "agents", auditorRef: "agents",
    } } as const;
    const parsed = parseRelationsConfig(config, schemas);
    const inverses = parsed.filter((r) => r.type === "one-to-many");
    expect(inverses.map((r) => [r.relationshipField, r.foreignKey])).toEqual([
      ["grantsByAuthorRef", "authorRef"],
      ["grantsByAgentRef", "agentRef"],
      ["grantsByAuditorRef", "auditorRef"],
    ]);

    const db = new Database(":memory:", schemas, {
      relations: config, cascade: { agents: ["grants"] },
    });
    try {
      const ada = db.agents.insert({ name: "Ada" });
      const ben = db.agents.insert({ name: "Ben" });
      const cy = db.agents.insert({ name: "Cy" });
      const first = db.grants.insert({
        label: "first", authorRef: ada.id, agentRef: ben.id, auditorRef: cy.id,
      });
      const second = db.grants.insert({
        label: "second", authorRef: ben.id, agentRef: ada.id, auditorRef: null,
      });
      const third = db.grants.insert({
        label: "third", authorRef: ada.id, agentRef: ben.id, auditorRef: ada.id,
      });
      expect(first.authorRefRelation()!.id).toBe(ada.id);
      expect(first.agentRefRelation()!.id).toBe(ben.id);
      expect(first.auditorRefRelation()!.id).toBe(cy.id);
      expect(second.auditorRefRelation()).toBeNull();
      expect(db.grants.get(third.id)!.auditorRefRelation()!.id).toBe(ada.id);
      const ids = (rows: { id: number }[]) => rows.map((r) => r.id).sort();
      expect(ids(ada.grantsByAuthorRef())).toEqual([first.id, third.id]);
      expect(ids(ada.grantsByAgentRef())).toEqual([second.id]);
      expect(ids(ada.grantsByAuditorRef())).toEqual([third.id]);
      expect(ids(cy.grantsByAuditorRef())).toEqual([first.id]);
      expect(ben.grantsByAuditorRef()).toEqual([]);

      // Typed methods have distinct return types, including on fetched rows.
      const typed: number = db.agents.get(ada.id)!.grantsByAuthorRef()[0]!.authorRef;
      expect(typed).toBe(ada.id);
      const eager = db.agents.select()
        .with("grantsByAuthorRef", "grantsByAgentRef", "grantsByAuditorRef")
        .all() as any[];
      const byId = (id: number) => eager.find((a) => a.id === id)!;
      expect(ids(byId(ada.id).grantsByAuthorRef)).toEqual([first.id, third.id]);
      expect(ids(byId(ada.id).grantsByAgentRef)).toEqual([second.id]);
      expect(ids(byId(ada.id).grantsByAuditorRef)).toEqual([third.id]);
      expect(ids(byId(ben.id).grantsByAuthorRef)).toEqual([second.id]);
      expect(ids(byId(ben.id).grantsByAuditorRef)).toEqual([]);
      expect(ids(byId(cy.id).grantsByAuditorRef)).toEqual([first.id]);
      expect(db.raw("PRAGMA foreign_key_list(grants)").map((r: any) => r.from).sort())
        .toEqual(["agentRef", "auditorRef", "authorRef"]);

      expect(() => db.grants.select().join(db.agents, ["name"])).toThrow(
        /Ambiguous automatic join.*authorRef.*agentRef.*auditorRef.*Use join/,
      );
      expect(() => db.agents.select().join(db.grants, ["label"])).toThrow(
        /Ambiguous automatic join/,
      );
      expect(() => db.grants.select().where({ agents: ada } as any).all())
        .toThrow(/Ambiguous relationship/);
      const joined = db.grants.select("label")
        .join("agents", "authorRef", ["name"]).all() as any[];
      expect(joined.find((r) => r.label === "first")!.agents_name).toBe("Ada");
      db.agents.delete(ada.id);
      expect(db.grants.select().all()).toEqual([]);
    } finally { db.close(); }
  });

  test("nodes.nodes_id self-reference retains both accessors and correct grouping", () => {
    const schema = { nodes: z.object({
      name: z.string(), nodes_id: z.number().nullable(),
    }) };
    const config = { nodes: { nodes_id: "nodes" } } as const;
    expect(parseRelationsConfig(config, schema).map((r) => [r.relationshipField, r.foreignKey]))
      .toEqual([["nodes", "nodes_id"], ["nodesByNodesId", "nodes_id"]]);
    const db = new Database(":memory:", schema, { relations: config });
    try {
      const root = db.nodes.insert({ name: "root", nodes_id: null });
      const child = db.nodes.insert({ name: "child", nodes_id: root.id });
      const grandchild = db.nodes.insert({ name: "grandchild", nodes_id: child.id });
      expect(root.nodes()).toBeNull();
      expect(child.nodes()!.id).toBe(root.id);
      expect(grandchild.nodes()!.id).toBe(child.id);
      expect(root.nodes_id).toBeNull();
      expect(child.nodes_id).toBe(root.id);
      expect(root.nodesByNodesId().map((r) => r.id)).toEqual([child.id]);
      expect(child.nodesByNodesId().map((r) => r.id)).toEqual([grandchild.id]);
      expect(grandchild.nodesByNodesId()).toEqual([]);
      const loaded = db.nodes.select().with("nodesByNodesId").all() as any[];
      expect(loaded.find((r) => r.id === root.id)!.nodesByNodesId[0].id).toBe(child.id);
      expect(loaded.find((r) => r.id === child.id)!.nodesByNodesId[0].id).toBe(grandchild.id);
      expect(loaded.find((r) => r.id === grandchild.id)!.nodesByNodesId).toEqual([]);
    } finally { db.close(); }
  });
});
