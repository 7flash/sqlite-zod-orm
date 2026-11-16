import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { z } from "zod";
import { deleteEntity, insert } from "../src/crud";
import { compileProxyQuery, createContextProxy } from "../src/proxy";

const databases: Database[] = [];
function memoryDb() {
  const db = new Database(":memory:");
  databases.push(db);
  return db;
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function crudContext(db: Database, schemas: Record<string, any>) {
  return {
    db, schemas, hooks: {}, timestamps: false,
    _stmt: (sql: string) => db.prepare(sql),
    _m: (_label: string, fn: () => any) => fn(),
    attachMethods: (_name: string, value: any) => value,
  } as any;
}

describe("CRUD identifier quoting", () => {
  test("insert object keys cannot add SQL clauses", () => {
    const db = memoryDb();
    db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");
    const ctx = crudContext(db, {
      users: z.object({ name: z.string().optional() }),
    });
    const userKey = `name", id) VALUES ('pwn', ? ) --`;

    expect(() => insert(ctx, "users", { [userKey]: 999 })).toThrow();
    expect(
      (db.prepare("SELECT count(*) AS n FROM users").get() as any).n,
    ).toBe(0);
  });

  test("table names cannot replace the delete predicate", () => {
    const db = memoryDb();
    db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");
    db.exec("INSERT INTO users (id, name) VALUES (1, 'a'), (2, 'b')");
    const injectedName = 'users" WHERE id = ? OR 1=1 --';
    const schema = z.object({ name: z.string() });
    const ctx = crudContext(db, { [injectedName]: schema });

    expect(() => deleteEntity(ctx, injectedName, 1)).toThrow();
    expect(
      (db.prepare("SELECT count(*) AS n FROM users").get() as any).n,
    ).toBe(2);
  });
});

describe("proxy SQL construction", () => {
  test("sort direction is an allow-listed token", () => {
    const { proxy, aliasMap } = createContextProxy({
      users: z.object({ id: z.number() }),
    });
    const users = proxy.users!;
    expect(() => compileProxyQuery({
      select: { id: users.id },
      orderBy: { id: "ASC LIMIT 1 --" as any },
    }, aliasMap)).toThrow(/Invalid ORDER BY direction/);
  });

  test("pagination values are validated and bound", () => {
    const { proxy, aliasMap } = createContextProxy({
      users: z.object({ id: z.number() }),
    });
    const users = proxy.users!;
    const compiled = compileProxyQuery({
      select: { id: users.id }, limit: 4, offset: 2,
    }, aliasMap);
    expect(compiled.sql).toContain("LIMIT ? OFFSET ?");
    expect(compiled.params).toEqual([4, 2]);

    for (const limit of [-1, 1.5, "0 LIMIT 1 --", Infinity]) {
      expect(() => compileProxyQuery({
        select: { id: users.id }, limit: limit as any,
      }, aliasMap)).toThrow(/limit must be/);
    }
    expect(() => compileProxyQuery({
      select: { id: users.id }, offset: -1,
    }, aliasMap)).toThrow(/offset must be/);
  });

  test("quoted table, column, output alias, and join identifiers are escaped", () => {
    const schemas = {
      ['us"ers']: z.object({ ['na"me']: z.string() }),
      ['ro"les']: z.object({ ['na"me']: z.string() }),
    };
    const { proxy, aliasMap } = createContextProxy(schemas);
    const users = proxy['us"ers']!;
    const roles = proxy['ro"les']!;
    const column = users['na"me']!;
    const compiled = compileProxyQuery({
      select: { ['out"put']: column },
      join: [column, roles['na"me']!],
      groupBy: [column],
    }, aliasMap);

    expect(compiled.sql).toContain('FROM "us""ers" "t1"');
    expect(compiled.sql).toContain('"t1"."na""me" AS "out""put"');
    expect(compiled.sql).toContain('JOIN "ro""les" "t2"');
    expect(compiled.sql).toContain('"t1"."na""me" = "t2"."na""me"');
    expect(compiled.sql).toContain('GROUP BY "t1"."na""me"');
  });

  test("unknown tables are rejected; odd column names stay quoted identifiers", () => {
    const { proxy } = createContextProxy({
      users: z.object({ name: z.string() }),
    });
    expect(() => (proxy as any)['users" JOIN secrets --']).toThrow(/Unknown table/);
    // Columns the ORM adds (id, timestamps, relation keys) are not in the Zod
    // shape, so any name is allowed, and quoting keeps it an identifier.
    const odd = (proxy.users as any)['id" DESC --'];
    expect(odd).toBeDefined();
    expect((proxy.users as any).id).toBeDefined();
  });
});
