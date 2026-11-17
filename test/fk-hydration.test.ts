import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Database } from "../src";
import { parseRelationsConfig } from "../src/schema";

describe("FK hydration preserves stored fields", () => {
  test("agentRef stays numeric through reads, writes, and navigation", () => {
    const db = new Database(":memory:", {
      agents: z.object({ name: z.string() }),
      coin_creation_grants: z.object({ agentRef: z.number(), active: z.boolean() }),
      actions: z.object({ agentRef: z.number() }),
      positions: z.object({ agentRef: z.number().nullable() }),
    }, { relations: {
      coin_creation_grants: { agentRef: "agents" },
      actions: { agentRef: "agents" }, positions: { agentRef: "agents" },
    } });
    try {
      const first = db.agents.insert({ name: "first" });
      const second = db.agents.insert({ name: "second" });
      const grant = db.coin_creation_grants.insert({ agentRef: first.id, active: true });
      const assertScalar = (row: typeof grant, id: number) => {
        const scalar: number = row.agentRef;
        expect(scalar).toBe(id);
        expect(typeof scalar).toBe("number");
        expect(row.agentRefRelation()!.id).toBe(id);
      };
      assertScalar(grant, first.id);
      assertScalar(db.coin_creation_grants.get(grant.id)!, first.id);
      assertScalar(db.coin_creation_grants.select().get()!, first.id);
      const projected = db.coin_creation_grants.select("id", "active").get()! as any;
      expect(projected.agentRef).toBeUndefined();
      expect(projected.agentRefRelation()).toBeNull();
      const eager = db.coin_creation_grants.select().with("agentRefRelation").get()! as any;
      expect(eager.agentRef).toBe(first.id);
      // Eager loading attaches the row itself (README: posts[0].user), not the lazy accessor.
      expect(eager.agentRefRelation.id).toBe(first.id);
      expect(db.coin_creation_grants.select("agentRef").get()!.agentRef).toBe(first.id);
      expect(db.coin_creation_grants.select("agentRef").raw().get()!.agentRef).toBe(first.id);
      assertScalar(db.coin_creation_grants.update(grant.id, { agentRef: second.id })!, second.id);
      assertScalar(db.coin_creation_grants.get(grant.id)!, second.id);
      expect(first.coin_creation_grants()).toHaveLength(0);
      expect(second.coin_creation_grants()[0]!.agentRef).toBe(second.id);
      const action = db.actions.insert({ agentRef: second.id });
      const position = db.positions.insert({ agentRef: second.id });
      expect(action.agentRef).toBe(second.id);
      expect(position.agentRef).toBe(second.id);
      expect(action.agentRefRelation()!.id).toBe(second.id);
      expect(position.agentRefRelation()!.id).toBe(second.id);
      expect(second.actions()[0]!.agentRef).toBe(second.id);
      expect(second.positions()[0]!.agentRef).toBe(second.id);
      const unattached = db.positions.insert({ agentRef: null });
      expect(unattached.agentRef).toBeNull();
      expect(unattached.agentRefRelation()).toBeNull();
      expect(db.positions.get(unattached.id)!.agentRef).toBeNull();
      grant.agentRef = second.id;
      grant.agentRef = first.id;
      assertScalar(grant, first.id);
      assertScalar(db.coin_creation_grants.get(grant.id)!, first.id);
    } finally { db.close(); }
  });

  test("forward and inverse collisions preserve fields with typed accessors", () => {
    const db = new Database(":memory:", {
      authors: z.object({ books: z.string(), booksRelation: z.string() }),
      books: z.object({ author_id: z.number(), author: z.string(), authorRelation: z.string() }),
    }, { relations: { books: { author_id: "authors" } } });
    try {
      const author = db.authors.insert({ books: "scalar", booksRelation: "also scalar" });
      const book = db.books.insert({ author_id: author.id, author: "scalar", authorRelation: "also scalar" });
      expect(book.author).toBe("scalar");
      expect(book.authorRelation).toBe("also scalar");
      expect(book.authorRelationRelation()!.id).toBe(author.id);
      expect(author.books).toBe("scalar");
      expect(author.booksRelation).toBe("also scalar");
      expect(author.booksRelationRelation()[0]!.author_id).toBe(author.id);
      const loaded = db.authors.select().with("booksRelationRelation").get()! as any;
      expect(loaded.books).toBe("scalar");
      expect(loaded.booksRelationRelation[0].author_id).toBe(author.id);
    } finally { db.close(); }
  });

  test("ordinary author_id retains author() and books()", () => {
    const db = new Database(":memory:", {
      authors: z.object({ name: z.string() }), books: z.object({ author_id: z.number() }),
    }, { relations: { books: { author_id: "authors" } } });
    try {
      const author = db.authors.insert({ name: "author" });
      const book = db.books.insert({ author_id: author.id });
      expect(book.author()!.id).toBe(author.id);
      expect(book.author_id).toBe(author.id);
      expect(author.books()[0]!.id).toBe(book.id);
    } finally { db.close(); }
  });

  test("entity methods are reserved and ambiguous navigation is rejected", () => {
    const schemas = {
      parents: z.object({}),
      children: z.object({ update_id: z.number(), parent_id: z.number(), parent: z.number() }),
    };
    expect(parseRelationsConfig({ children: { update_id: "parents" } }, schemas)[0]!.relationshipField)
      .toBe("updateRelation");
    for (const name of ["createdAt", "updatedAt", "deletedAt"]) {
      const inverse = parseRelationsConfig({ [name]: { parent_id: "parents" } }, {
        parents: z.object({}),
        [name]: z.object({ parent_id: z.number() }),
      }).find((relation) => relation.type === "one-to-many");
      expect(inverse?.relationshipField).toBe(`${name}Relation`);
    }
    expect(() => parseRelationsConfig({ children: { parent_id: "parents", parent: "parents" } }, schemas))
      .toThrow("conflicting navigation accessor");
  });

  test("generated columns retain their values alongside typed inverse accessors", () => {
    const db = new Database(":memory:", {
      parents: z.object({ name: z.string() }),
      createdAt: z.object({ parent_id: z.number() }),
      updatedAt: z.object({ parent_id: z.number() }),
      deletedAt: z.object({ parent_id: z.number() }),
    }, {
      timestamps: true,
      softDeletes: true,
      relations: {
        createdAt: { parent_id: "parents" },
        updatedAt: { parent_id: "parents" },
        deletedAt: { parent_id: "parents" },
      },
    });
    try {
      const parent = db.parents.insert({ name: "parent" });
      db.createdAt.insert({ parent_id: parent.id });
      db.updatedAt.insert({ parent_id: parent.id });
      db.deletedAt.insert({ parent_id: parent.id });
      const fetched = db.parents.get(parent.id)!;
      expect(typeof Reflect.get(fetched, "createdAt")).toBe("string");
      expect(typeof Reflect.get(fetched, "updatedAt")).toBe("string");
      expect(Reflect.get(fetched, "deletedAt")).toBeNull();
      expect(fetched.createdAtRelation()).toHaveLength(1);
      expect(fetched.updatedAtRelation()).toHaveLength(1);
      expect(fetched.deletedAtRelation()).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});

