import { expect, test } from "bun:test";
import { Database, z } from "../src/index";

function expectType<T>(_value: T): void {}

// UPGRADING section 8 documents join('agents', 'authorRef', ['name']) and
// reading `agents_name`; before 4.2.3 that column was not in the row type.
test("string-based join() types the appended <table>_<column> fields", () => {
  const db = new Database(":memory:", {
    agents: z.object({ name: z.string(), level: z.number() }),
    grants: z.object({ authorRef: z.number(), note: z.string() }),
  }, { relations: { grants: { authorRef: "agents" } } });
  try {
    const author = db.agents.insert({ name: "Author", level: 3 });
    db.grants.insert({ authorRef: author.id, note: "n" });
    const row = db.grants.select().join("agents", "authorRef", ["name", "level"]).all()[0]!;
    expectType<string>(row.agents_name);
    expectType<number>(row.agents_level);
    expectType<string>(row.note);
    // @ts-expect-error only the listed columns are appended
    row.agents_id;
    expect(row.agents_name).toBe("Author");
    expect(row.agents_level).toBe(3);
  } finally {
    db.close();
  }
});
