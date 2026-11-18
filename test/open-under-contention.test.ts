import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database, z } from "../src/index";

// Another process takes the write lock again and again (150 ms each, short
// gaps). Opening with a busy timeout shorter than one hold used to fail on
// the first "database is locked"; the schema step now retries until a gap.
test("opening a database retries the schema step while other processes keep the write lock", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "szo-open-busy-"));
  const file = path.join(dir, "app.db").replace(/\\/g, "/");
  const schema = { counters: z.object({ value: z.number() }) };
  new Database(file, schema).close();
  const holder = path.join(dir, "holder.ts");
  writeFileSync(holder, `
    import { Database } from "bun:sqlite";
    const db = new Database(${JSON.stringify(file)});
    db.run("PRAGMA busy_timeout = 5000");
    console.log("ready");
    const end = Date.now() + 2500;
    while (Date.now() < end) {
      db.run("BEGIN IMMEDIATE");
      Bun.sleepSync(150);
      db.run("COMMIT");
      Bun.sleepSync(5);
    }
  `);
  const child = Bun.spawn(["bun", holder], { stdout: "pipe", stderr: "inherit" });
  const reader = child.stdout.getReader();
  await reader.read(); // "ready": the holder is looping
  await Bun.sleep(50);
  try {
    const db = new Database(file, schema, { busyTimeout: 100 });
    expect(db.counters.select().count()).toBe(0);
    db.close();
  } finally {
    await child.exited;
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);
