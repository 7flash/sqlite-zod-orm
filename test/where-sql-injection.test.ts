import { describe, expect, test } from "bun:test";
import { QueryBuilder } from "../src/builder";
import { op } from "../src/ast";

const makeQuery = () =>
  new QueryBuilder("users", () => [], () => null);

describe("WHERE SQL injection protections", () => {
  test("quotes untrusted object-style field names", () => {
    const field = 'age" OR 1=1 --';
    const result = makeQuery().where({ [field]: 1 }).toSQL();
    expect(result.sql).toContain('"age"" OR 1=1 --" = ?');
    expect(result.params).toEqual([1]);
  });

  test("quotes untrusted $or field names", () => {
    const field = 'age" OR 1=1 --';
    const result = makeQuery().where({ $or: [{ [field]: 1 }] }).toSQL();
    expect(result.sql).toContain('"age"" OR 1=1 --" = ?');
    expect(result.params).toEqual([1]);
  });

  test("rejects inherited operator-map properties", () => {
    expect(() =>
      makeQuery().where({ age: { constructor: 1 } } as any),
    ).toThrow(/Unsupported query operator/);
    expect(() =>
      makeQuery().where({ $or: [{ age: { toString: 1 } }] } as any),
    ).toThrow(/Unsupported query operator/);
  });

  test("quotes AST column names", () => {
    const field = 'age" OR 1=1 --';
    const result = makeQuery()
      .where((c) => op.eq((c as any)[field], 1))
      .toSQL();
    expect(result.sql).toContain('"age"" OR 1=1 --"');
    expect(result.params).toEqual([1]);
  });

  test("rejects AST function names that are not plain identifiers", () => {
    const fn = 'lower) OR 1=1 --';
    expect(() =>
      makeQuery()
        .where((_c, f) => op.eq((f as any)[fn]("x"), "y"))
        .toSQL(),
    ).toThrow(/Invalid SQL function name/);
    const ok = makeQuery()
      .where((_c, f) => op.eq((f as any).lower("x"), "y"))
      .toSQL();
    expect(ok.params).toEqual(["x", "y"]);
  });

  test("rejects untrusted AST operator strings", () => {
    expect(() =>
      makeQuery().where(() => ({
        type: "operator",
        op: "= 1 OR 1=1 --",
        left: { type: "column", name: "age" },
        right: { type: "literal", value: 1 },
      } as any)).toSQL(),
    ).toThrow(/Unsupported AST SQL operator/);
  });

  test("quotes whereIn identifiers and enforces parameter limits", () => {
    const field = 'id" OR 1=1 --';
    expect(makeQuery().whereIn(field as any, [1]).toSQL().sql)
      .toContain('"id"" OR 1=1 --" IN (?)');
    expect(() => makeQuery().where({ id: { $in: Array(32767).fill(1) } })
      .toSQL()).toThrow(/exceeds 32766/);
  });

  test("preserves empty IN and NOT IN behavior", () => {
    const included = makeQuery().where({ id: { $in: [] } }).toSQL();
    expect(included.sql).toContain("1 = 0");
    const excluded = makeQuery().where({ id: { $notIn: [] } }).toSQL();
    expect(excluded.sql).not.toContain("NOT IN");
  });

  test("keeps untrusted comparison values out of SQL text", () => {
    const value = "' OR 1=1 --";
    const result = makeQuery().where({ name: value }).toSQL();
    expect(result.sql).toContain('"name" = ?');
    expect(result.sql).not.toContain(value);
    expect(result.params).toEqual([value]);
  });

  test("whereRaw binds values when SQL structure is trusted", () => {
    const path = "$.profile.name";
    const value = "' OR 1=1 --";
    const result = makeQuery()
      .whereRaw('json_extract("data", ?) = ?', [path, value])
      .toSQL();
    expect(result.sql).toContain('json_extract("data", ?) = ?');
    expect(result.params).toEqual([path, value]);
  });
});
