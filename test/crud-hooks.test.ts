import { describe, expect, test } from "bun:test";
import { Database, z } from "../src/index";

function makeDb(hooks: any) {
  return new Database(
    ":memory:",
    { items: z.object({ value: z.string() }) },
    { hooks } as any,
  );
}

describe("lifecycle hooks", () => {
  test("async beforeDelete is rejected before deleting", () => {
    const db = makeDb({
      items: { beforeDelete: async () => true },
    });
    const item = db.items.insert({ value: "keep" });

    expect(() => db.items.delete(item.id)).toThrow(/must be synchronous/);
    expect(db.items.get(item.id)?.value).toBe("keep");
  });

  test("async afterInsert runs fire-and-forget; its rejection is logged, not thrown", async () => {
    const { spyOn } = await import("bun:test");
    const errors = spyOn(console, "error").mockImplementation(() => {});
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const db = makeDb({
        items: {
          afterInsert: async () => {
            throw new Error("async failure");
          },
        },
      });
      expect(() => db.items.insert({ value: "saved" })).not.toThrow();
      await new Promise((r) => setTimeout(r, 20));
      expect(db.items.select().all().map((row: any) => row.value)).toEqual(["saved"]);
      expect(unhandled).toEqual([]);
      expect(errors).toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", onUnhandled);
      errors.mockRestore();
    }
  });

  test("same-hook recursive writes fail instead of recursing indefinitely", () => {
    let db: any;
    db = makeDb({
      items: {
        beforeInsert: (data: any) => {
          db.items.insert({ value: "nested" });
          return data;
        },
      },
    });

    expect(() => db.items.insert({ value: "outer" }))
      .toThrow(/Recursive lifecycle hook/);
    expect(db.items.select().all()).toHaveLength(0);
  });

  test("returned data replaces mutations and is parsed by Zod", () => {
    const db = makeDb({
      items: {
        beforeInsert: (data: any) => {
          data.value = "mutated";
          return { value: "returned" };
        },
      },
    });

    expect(db.items.insert({ value: "original" }).value).toBe("returned");
  });

  test("insertMany runs insert hooks per row; after-hooks see committed rows", () => {
    let db: any;
    const counts: number[] = [];
    db = makeDb({
      items: {
        beforeInsert: (data: any) => ({ ...data, value: data.value.trim() }),
        afterInsert: () => counts.push(db.items.select().all().length),
      },
    });

    const rows = db.items.insertMany([
      { value: " first " },
      { value: " second " },
    ]);

    expect(rows.map((row: any) => row.value)).toEqual(["first", "second"]);
    expect(counts).toEqual([2, 2]);
  });
});
