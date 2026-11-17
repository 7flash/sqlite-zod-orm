import { expect, spyOn, test } from "bun:test";
import { z } from "zod";
import { Database } from "../src/index";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeDb() {
  return new Database(":memory:", { notes: z.object({ text: z.string() }) }, { pollInterval: 20 });
}

test("a rejected async listener is caught and other listeners still run", async () => {
  const db = makeDb();
  const errors = spyOn(console, "error").mockImplementation(() => {});
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  const seen: string[] = [];
  try {
    const a = db.notes.on("insert", async () => {
      throw new Error("listener failed");
    });
    const b = db.notes.on("insert", (row: any) => {
      seen.push(row.text);
    });
    db.notes.insert({ text: "hello" });
    await wait(150);
    expect(seen).toEqual(["hello"]);
    expect(unhandled).toEqual([]);
    expect(errors).toHaveBeenCalled();
    a();
    b();
  } finally {
    process.off("unhandledRejection", onUnhandled);
    errors.mockRestore();
    db.close();
  }
});

test("a listener removed by an earlier listener is not called for the same change", async () => {
  const db = makeDb();
  const calls: string[] = [];
  let unsubB = () => {};
  const unsubA = db.notes.on("insert", () => {
    calls.push("a");
    unsubB();
  });
  unsubB = db.notes.on("insert", () => {
    calls.push("b");
  });
  db.notes.insert({ text: "x" });
  await wait(150);
  expect(calls).toEqual(["a"]);
  unsubA();
  db.close();
});
