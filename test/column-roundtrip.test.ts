import { expect, test } from "bun:test";
import { Database, z } from "../src/index";

test("bigint columns and Dates nested in JSON come back as their schema types", () => {
  const db = new Database(":memory:", {
    t: z.object({
      meta: z.object({ at: z.date(), n: z.number(), tags: z.array(z.object({ on: z.date() })) }),
      iso: z.string(),
      big: z.bigint(),
      maybeBig: z.bigint().nullable(),
    }),
  }, { reactive: false });
  const at = new Date("2024-01-02T03:04:05.000Z");
  const row = db.t.insert({
    meta: { at, n: 1, tags: [{ on: at }] },
    iso: "2024-01-02T03:04:05.000Z",
    big: 9007199254740993n,
    maybeBig: null,
  });
  const back = db.t.get(row.id)!;
  expect(back.big).toBe(9007199254740993n);
  expect(back.maybeBig).toBeNull();
  expect(back.meta.at).toBeInstanceOf(Date);
  expect(back.meta.at.toISOString()).toBe(at.toISOString());
  expect(back.meta.tags[0]!.on).toBeInstanceOf(Date);
  // A z.string() that looks like a date stays a string.
  expect(back.iso).toBe("2024-01-02T03:04:05.000Z");
  db.close();
});
