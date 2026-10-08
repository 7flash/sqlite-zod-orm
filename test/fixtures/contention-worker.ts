import { Database as RawDatabase } from "bun:sqlite";
import { Database, z } from "../../src";

const [file, action] = process.argv.slice(2);
if (!file) throw new Error("Missing database path");
if (action === "lock") {
  const raw = new RawDatabase(file);
  raw.run("BEGIN IMMEDIATE");
  console.log("ready");
  await Bun.sleep(600);
  raw.run("COMMIT");
  raw.close();
} else {
  console.log("ready");
  await Bun.stdin.stream().getReader().read();
  const db = new Database(
    file,
    {
      counters: z.object({
        value: z.number(),
        label: z.string().default("counter"),
      }),
    },
    {
      indexes: { counters: ["value"] },
      unique: { counters: [["label"]] },
      views: {
        totals: {
          schema: z.object({ value: z.number() }),
          as: 'SELECT value FROM "counters"',
        },
      },
    },
  );
  try {
    for (let i = 0; i < 150; i++) {
      db.transaction(() => {
        const row = db.counters.get(1)!;
        // Widen the read/write interval to expose deferred snapshot upgrades.
        const until = performance.now() + 0.25;
        while (performance.now() < until) {
          /* widen the snapshot race */
        }
        db.counters.update(1, { value: row.value + 1 });
      });
    }
  } finally {
    db.close();
  }
}
