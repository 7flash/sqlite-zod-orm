import { expect, test, spyOn } from "bun:test";
import { Database as RawDatabase } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database, z } from "../src";

function withFile(work: (file: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "orm-schema-"));
  let failure: unknown;
  try {
    work(join(dir, "db.sqlite"));
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      rmSync(dir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    } catch (error) {
      if (!failure) throw error;
    }
  }
}

test("defaulted and nullable additions preserve table, rows, indexes, triggers and defaults on reopen", () =>
  withFile((file) => {
    const original = new Database(
      file,
      { deployments: z.object({ name: z.string() }) },
      {
        indexes: { deployments: ["name"] },
      },
    );
    original.deployments.insert({ name: "live" });
    original.exec("CREATE TABLE revisions (value INTEGER)");
    original.exec("INSERT INTO revisions VALUES (0)");
    original.exec("CREATE INDEX app_deployments_name ON deployments(name)");
    original.exec(
      "CREATE TRIGGER app_revision AFTER UPDATE ON deployments BEGIN UPDATE revisions SET value = value + 1; END",
    );
    const before = original.raw(
      "SELECT name, rootpage, sql FROM sqlite_master WHERE tbl_name = 'deployments' AND type IN ('index', 'trigger') ORDER BY name",
    );
    const rootpage = original.raw(
      "SELECT rootpage FROM sqlite_master WHERE name = 'deployments'",
    );
    original.close();
    const schemas = {
      deployments: z.object({
        decisionLinesJson: z.string().default("[]"),
        name: z.string(), // Reordering columns must also be harmless.
        note: z.string().nullable(),
        enabled: z.boolean().default(true),
        tags: z.array(z.string()).default(["it's live"]),
        score: z.number().nullable().optional(),
      }),
    };
    for (let i = 0; i < 2; i++) {
      const db = new Database(file, schemas, {
        indexes: { deployments: ["name"] },
      });
      try {
        expect(
          db.raw(
            "SELECT rootpage FROM sqlite_master WHERE name = 'deployments'",
          ),
        ).toEqual(rootpage);
        expect(
          db.raw(
            "SELECT name, rootpage, sql FROM sqlite_master WHERE tbl_name = 'deployments' AND type IN ('index', 'trigger') ORDER BY name",
          ),
        ).toEqual(before);
        expect(
          db.raw(
            "SELECT name FROM sqlite_master WHERE name LIKE 'deployments_v%'",
          ),
        ).toEqual([]);
        const row = db.deployments.get(1)!;
        expect(row.decisionLinesJson).toBe("[]");
        expect(row.enabled).toBe(true);
        expect(row.tags).toEqual(["it's live"]);
        expect(row.note).toBeNull();
        expect(
          db.columns("deployments").find((c) => c.name === "score")?.type,
        ).toBe("INTEGER");
        db.deployments.update(1, { name: "still live" });
        expect(db.raw("SELECT value FROM revisions")).toEqual([
          { value: i + 1 },
        ]);
      } finally {
        db.close();
      }
    }
  }));

test("incompatible change copies rows, recreates all schema objects and retains FK/view references", () =>
  withFile((file) => {
    const options = {
      relations: { trades: { deployment_id: "deployments" } },
      indexes: { deployments: ["name"], trades: ["deployment_id"] },
      unique: { deployments: [["name"]] },
      views: {
        active: {
          schema: z.object({ name: z.string() }),
          as: "SELECT name FROM deployments",
        },
      },
    };
    const original = new Database(
      file,
      {
        deployments: z.object({ name: z.string(), obsolete: z.string() }),
        trades: z.object({
          deployment_id: z.number().optional(),
          value: z.number(),
        }),
      },
      options,
    );
    original.deployments.insert({ name: "live", obsolete: "old" });
    const removed = original.deployments.insert({
      name: "removed",
      obsolete: "old",
    });
    original.deployments.delete(removed.id);
    original.trades.insert({ deployment_id: 1, value: 5 });
    original.exec("CREATE TABLE revisions (value INTEGER)");
    original.exec("INSERT INTO revisions VALUES (0)");
    original.exec("CREATE INDEX app_name ON deployments(name)");
    original.exec(
      "CREATE TRIGGER app_revision AFTER UPDATE ON deployments BEGIN UPDATE revisions SET value = value + 1; END",
    );
    original.close();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const db = new Database(
        file,
        {
          deployments: z.object({ name: z.string() }),
          trades: z.object({
            deployment_id: z.number().optional(),
            value: z.number(),
          }),
        },
        options,
      );
      try {
        expect(db.deployments.get(1)?.name).toBe("live");
        expect(db.trades.get(1)?.deployment_id).toBe(1);
        expect(db.raw("SELECT * FROM deployments_v1")).toEqual([
          { id: 1, name: "live", obsolete: "old" },
        ]);
        expect(
          db.raw<{ table: string }>("PRAGMA foreign_key_list(trades)")[0]
            ?.table,
        ).toBe("deployments");
        expect(db.raw("PRAGMA foreign_key_check")).toEqual([]);
        expect(db.active.select().all()).toEqual([{ name: "live" }]);
        expect(db.deployments.insert({ name: "next" }).id).toBe(3);
        db.deployments.update(1, { name: "updated" });
        expect(db.raw("SELECT value FROM revisions")).toEqual([{ value: 1 }]);
        expect(
          db.raw(
            "SELECT name FROM sqlite_master WHERE tbl_name = 'deployments' AND type = 'index'",
          ),
        ).toHaveLength(3);
        expect(
          db.raw(
            "SELECT name FROM sqlite_master WHERE tbl_name = 'deployments_v1' AND type IN ('index', 'trigger')",
          ),
        ).toEqual([]);
        expect(
          db.raw(
            "SELECT op FROM _changes WHERE tbl = 'deployments' AND row_id = 1 ORDER BY id DESC LIMIT 1",
          ),
        ).toEqual([{ op: "update" }]);
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        db.close();
      }
    } finally {
      warn.mockRestore();
    }
  }));

test("failed schema initialization rolls back columns, indexes, views and tracking together", () =>
  withFile((file) => {
    const original = new Database(
      file,
      { deployments: z.object({ name: z.string() }) },
      { reactive: false },
    );
    original.deployments.insert({ name: "live" });
    original.close();
    expect(
      () =>
        new Database(
          file,
          {
            deployments: z.object({
              name: z.string(),
              decisionLinesJson: z.string().default("[]"),
            }),
          },
          {
            indexes: { deployments: ["name"] },
            views: {
              broken: {
                schema: z.object({ name: z.string() }),
                as: "THIS IS INVALID SQL",
              },
            },
          },
        ),
    ).toThrow();
    const raw = new RawDatabase(file);
    try {
      expect(raw.query("SELECT * FROM deployments").all()).toEqual([
        { id: 1, name: "live" },
      ]);
      expect(
        raw
          .query(
            "SELECT name FROM sqlite_master WHERE type IN ('index', 'view', 'trigger') OR name = '_changes'",
          )
          .all(),
      ).toEqual([]);
    } finally {
      raw.close();
    }
  }));

test("failed rebuild rolls back rather than dropping application indexes or stranding rows", () =>
  withFile((file) => {
    const original = new Database(file, {
      trades: z.object({ name: z.string(), obsolete: z.string() }),
    });
    original.trades.insert({ name: "live", obsolete: "keep" });
    original.exec("CREATE INDEX app_obsolete ON trades(obsolete)");
    original.close();
    expect(
      () => new Database(file, { trades: z.object({ name: z.string() }) }),
    ).toThrow();
    const raw = new RawDatabase(file);
    try {
      expect(raw.query("SELECT * FROM trades").all()).toEqual([
        { id: 1, name: "live", obsolete: "keep" },
      ]);
      expect(
        raw
          .query("SELECT name FROM sqlite_master WHERE name = 'trades_v1'")
          .all(),
      ).toEqual([]);
      expect(
        raw
          .query(
            "SELECT tbl_name FROM sqlite_master WHERE name = 'app_obsolete'",
          )
          .get(),
      ).toEqual({ tbl_name: "trades" });
    } finally {
      raw.close();
    }
  }));

test("required additions without defaults fail atomically on populated tables", () =>
  withFile((file) => {
    const original = new Database(file, {
      trades: z.object({ name: z.string() }),
    });
    original.trades.insert({ name: "live" });
    original.close();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(
        () =>
          new Database(file, {
            trades: z.object({ name: z.string(), required: z.string() }),
          }),
      ).toThrow("Cannot populate required column");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
    const raw = new RawDatabase(file);
    try {
      expect(raw.query("SELECT * FROM trades").all()).toEqual([
        { id: 1, name: "live" },
      ]);
      expect(
        raw
          .query("SELECT name FROM sqlite_master WHERE name = 'trades_v1'")
          .all(),
      ).toEqual([]);
    } finally {
      raw.close();
    }
  }));

test("function defaults are evaluated once per added column and not on reopen", () =>
  withFile((file) => {
    const original = new Database(file, {
      trades: z.object({ name: z.string() }),
    });
    original.trades.insertMany([{ name: "one" }, { name: "two" }]);
    original.close();
    let calls = 0;
    const schemas = {
      trades: z.object({
        name: z.string(),
        serial: z.number().default(() => ++calls),
        flags: z.array(z.string()).nullable().default(["active"]),
      }),
    };
    for (let i = 0; i < 2; i++) {
      const db = new Database(file, schemas);
      try {
        expect(calls).toBe(1);
        expect(
          db.trades
            .select()
            .all()
            .map((row) => [row.serial, row.flags]),
        ).toEqual([
          [1, ["active"]],
          [1, ["active"]],
        ]);
      } finally {
        db.close();
      }
    }
  }));
