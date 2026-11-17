import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { QueryBuilder } from "../src/builder";

type Row = { grp: string; value: number | null; deletedAt: string | null };

function fixture() {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE items (grp TEXT, value INTEGER, deletedAt TEXT)");
  const q = () => new QueryBuilder<Row>(
    "items",
    (sql, params) => db.query(sql).all(...params),
    (sql, params) => db.query(sql).get(...params),
  );
  return { db, q };
}

test("empty table: count zero, other aggregates null", () => {
  const { db, q } = fixture();
  expect(q().count()).toBe(0);
  expect(q().sum("value")).toBe(0); // documented: sum and avg are numbers
  expect(q().avg("value")).toBe(0);
  expect(q().min("value")).toBeNull();
  expect(q().max("value")).toBeNull();
  expect(q().groupBy("grp").countGrouped()).toEqual([]);
  expect(() => q().countGrouped()).toThrow();
  db.close();
});

test("NULLs, WHERE, grouped HAVING, and soft-delete scopes", () => {
  const { db, q } = fixture();
  db.exec(`INSERT INTO items VALUES
    ('a',NULL,NULL), ('a',10,NULL), ('a',20,NULL),
    ('b',40,NULL), ('b',NULL,NULL),
    ('b',30,'2025-01-01'), ('c',NULL,NULL)`);

  // Mimic the WHERE injected by softDeletes: true.
  const live = () => q().where({ deletedAt: { $isNull: true } });
  expect(live().count()).toBe(6);
  expect(live().sum("value")).toBe(70);
  expect(live().avg("value")).toBeCloseTo(70 / 3);
  expect(live().min("value")).toBe(10);
  expect(live().max("value")).toBe(40);
  expect(live().where({ grp: "c" }).sum("value")).toBe(0);
  expect(live().where({ grp: "c" }).avg("value")).toBe(0);
  expect(live().where({ grp: "z" }).count()).toBe(0);
  expect(live().withTrashed().sum("value")).toBe(100);
  expect(live().onlyTrashed().sum("value")).toBe(30);

  const grouped = () => live().groupBy("grp")
    .having({ "COUNT(*)": { $gt: 1 } });
  // count() of a grouped query is the number of groups (like all().length);
  // other aggregates refuse instead of returning the first group's value.
  expect(grouped().count()).toBe(2);
  for (const fn of ["sum", "avg", "min", "max"] as const)
    expect(() => (grouped() as any)[fn]("value")).toThrow("grouped query");
  expect(grouped().countGrouped()).toEqual([
    { grp: "a", count: 3 }, { grp: "b", count: 2 },
  ]);
  expect(typeof live().sum("value")).toBe("number");
  expect(typeof live().avg("value")).toBe("number");
  expect(typeof live().min("grp")).toBe("string");
  db.close();
});

test("INTEGER SUM overflow yields a REAL number", () => {
  const { db, q } = fixture();
  db.exec(`INSERT INTO items VALUES
    ('a',9223372036854775807,NULL),
    ('a',9223372036854775807,NULL)`);
  expect(q().sum("value")).toBe(2 * Number(9223372036854775807n));
  expect(typeof q().sum("value")).toBe("number");
  db.close();
});
