import { expect, test } from "bun:test";
import { Database, z } from "../src/index";

// Bun's run().changes also counts rows written by triggers; with the default
// change journal every bulk count came back doubled.
const schema = { items: z.object({ n: z.number(), tag: z.string() }) };
for (const reactive of [true, false])
  for (const softDeletes of [false, true])
    for (const timestamps of [false, true])
      test(`bulk update/delete return the rows changed (reactive ${reactive}, softDeletes ${softDeletes}, timestamps ${timestamps})`, () => {
        const db = new Database(":memory:", schema, { reactive, softDeletes, timestamps });
        for (let i = 0; i < 10; i++) db.items.insert({ n: i, tag: i % 2 ? "odd" : "even" });
        expect(db.items.update({ tag: "mid" }).where({ n: { $gte: 2, $lt: 6 } }).exec()).toBe(4);
        expect(db.items.update({ tag: "none" }).where({ n: 100 }).exec()).toBe(0);
        expect(db.items.delete().where({ tag: "mid" }).exec()).toBe(4);
        expect(db.items.delete().where({ tag: "mid" }).exec()).toBe(0);
        expect(db.items.select().count()).toBe(6);
        db.close();
      });
