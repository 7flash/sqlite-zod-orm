# Changelog

## 4.0.4 (2026-11-18)

- UPGRADING.md section 21: the exported `z` is Zod 4 (3.x used Zod 3), and what that changes for app schemas.
- `upgrade-check` now reports one-argument `z.record()` and the Zod 3 error options `invalid_type_error` / `required_error`. Reported by the hardware ray.

## 4.0.3 (2026-11-18)

- **Fixed data loss:** a partial `update(id, fields)` or `update(fields).where(...).exec()` reset every field it left out that has a `.default()` back to that default (Zod 4 fills defaults even under `.partial()`). Only the fields you pass are written now. 4.0.0 to 4.0.2 are deprecated because of this; upgrade straight to 4.0.3. Reported by the toolset ray (prompt-proxy lost saved replies).

## 4.0.2 (2026-11-18)

- Fixed: `z.any()` and `z.unknown()` columns read back as text. Objects came back as JSON strings, and numbers and booleans as strings. They now store every value as JSON and read it back with its type. Rows written by older versions still read: JSON text is parsed, and other text is returned as it is.
- Note: a `where()` on a `z.any()` column compares against the stored JSON, so a string value written by 4.0.2 is stored with quotes (`"x"`). Filter such columns with `whereRaw` or move the value to a typed field.

## 4.0.1 (2026-11-17)

- Fixed: `bunx sqlite-zod-orm upgrade-check .` (and the other CLI commands) now work from the npm package; 4.0.0 shipped the CLI without registering the `sqlite-zod-orm` command.

## 4.0.0 (2026-11-17)

### Added

- `renames: { table: { oldField: "newField" } }`: a schema rebuild copies the old column's values into the renamed field instead of refusing to drop the populated column.
- `sqlite-zod-orm upgrade-check [dir] [--json]` lists the code in an app that the 4.0 changes affect, with the UPGRADING.md section for each.

### Security

- Field names in `where()` (including inside `$or`) were written into SQL unquoted, so an app that let users choose the filter field was open to SQL injection. Field names are now quoted identifiers; values were always bound parameters.
- The callback query style now quotes column names, accepts only plain identifiers as function names, and only known operators.
- Table and column names in inserts, updates, deletes, selects, joins, `groupBy()` and `orderBy()` are quoted with embedded quotes escaped; an insert key or table name containing `"` could rewrite the statement.
- `orderBy()` direction must be `asc` or `desc` (it was written into SQL as given); `limit()` and `offset()` must be non-negative integers.
- Operator keys must be real operators (`$in`, not inherited names like `constructor`); `$in`, `$notIn` and `$between` inputs are validated; a statement may bind at most 32766 parameters.

### Fixed

- `cascade` entries naming an unknown table, or a child without a relation to its parent, throw at startup instead of silently never cascading.
- Reads return schema types: `z.bigint()` columns are bigints (were strings), and dates nested in JSON columns are `Date` objects (were strings).
- `count()` after `groupBy()` returns the number of groups (it returned the first group's count); `sum`/`avg`/`min`/`max` after `groupBy()` throw instead of returning the first group's value; `sum()` no longer overflows on large integers.
- The prepared statement cache is bounded (500 per database); SQL with varying text no longer grows memory without limit.
- `restore()` restores the cascade deleted with the row, refuses orphans, throws for a missing id, and runs new `beforeRestore`/`afterRestore` hooks.
- Indexes on removed columns, and indexes no longer declared in `indexes`/`unique` for a listed table, are dropped at startup; names with double quotes are escaped in index and table SQL.
- `load()` keeps row ids (references survive a dump and reload), validates rows, quotes column names, rejects unknown tables and columns, and rolls back on a foreign key violation.
- `paginate()` no longer changes the query builder (later calls used the previous page's LIMIT), counts grouped and distinct queries correctly, orders by `id` when no order is given, and validates `page`/`perPage`.
- Cascade deletes go through every level, handle self-references and cycles, run each row's hooks once (`beforeDelete` was called twice through `db.table.delete(id)`), soft-delete the whole tree, and roll back entirely if a child's `beforeDelete` vetoes or throws.
- Soft deletes: `get(id)`, joins, `.with()` and relation accessors no longer return deleted rows, and `upsert` restores a soft-deleted row instead of inserting a duplicate.
- Type declarations use explicit `.js` import paths, so projects on `moduleResolution: node16`/`nodenext` get the package's types (TS2834 before).
- Change listeners: an async listener that rejects no longer causes an unhandled rejection, and unsubscribing a listener from inside another listener takes effect for the change being dispatched.
- `upsert(conditions, data)` takes the write lock before its lookup, so two connections upserting the same key no longer race into a UNIQUE error; its after-hooks run only after commit.
- Rows with multiple foreign keys referencing the same table now load the correct related record for each key instead of mixing up related records.
- Lazy relationship navigation, eager loading with .with(), and cascade deletes now follow the specific foreign key associated with each relationship.
- Self-referencing relationships now distinguish forward navigation from inverse navigation, so parent and child lookups return the intended records.
- Schema migrations now preserve existing row IDs and column values while rebuilding tables, including their indexes, triggers, and foreign-key relationships.
- Tables with inline UNIQUE constraints can now be rebuilt with equivalent named unique indexes instead of requiring manual migration solely because of those constraints.
- Migration statements are finalized correctly, preventing pending prepared statements from blocking transaction completion.

### Changed

- A callback `where()` and an object `where()` on the same query are both applied; before, the object filter was silently ignored.
- Migration CLI: unknown options fail, `--apply` asks for confirmation (or needs `--yes` without a terminal), and `--dry-run` changes nothing.
- `db.transaction()` throws for an async callback (it used to commit at the first `await`, leaving later writes outside the transaction).
- Lifecycle before-hooks must be synchronous: an async `beforeInsert`/`beforeUpdate`/`beforeDelete` now throws instead of being ignored (an async `beforeDelete` could never cancel a delete). Async after-hooks still run fire-and-forget; their rejections are logged. A hook that re-enters itself on the same table throws.
- Schema changes, including adding nullable or defaulted columns, now use transactional table reconstruction rather than ALTER TABLE ADD COLUMN. Affected tables retain versioned table_vN snapshots for recovery.
- Automatic migrations now refuse to change the type of a populated column or drop a populated column while adding another. These changes require explicit data migrations instead of silently copying incompatible data.
- Table rebuilds now stop when existing CHECK, NOT NULL, or ON CONFLICT constraints cannot be reconstructed without changing their behavior.
- Table rebuilds now refuse to silently change an existing foreign key's referenced table or ON DELETE/ON UPDATE actions.
- Automatic joins now throw an error when multiple foreign keys could connect the selected tables. Applications must specify the intended foreign key, for example .join('agents', 'authorRef', ['name']).
- When multiple foreign keys connect a child table to the same parent, inverse relationship accessors now use the names <childTable>By<FK>. For example, agents.grantsByAuthorRef() replaces ambiguous inverse navigation. Single-foreign-key inverse names remain unchanged.
- Relationship accessor names now avoid collisions with stored fields and entity methods by appending Relation where needed. Conflicting forward accessor names that cannot be resolved are rejected.
- Published TypeScript declarations now resolve from dist/ instead of package source files. Consumers receive declarations generated and checked during the package build.
- The documented runtime dependency baseline is now Zod 4.6.7 or newer, with measure-fn 5.x.

### Added

- `db.migrator().prune({ keep, table, dryRun })` drops old `<table>_vN` rebuild snapshots, keeping the newest `keep` per table. Nothing is pruned automatically.
- Table rebuilds now validate dependent triggers before committing. If a trigger references a removed or renamed column, initialization reports the broken trigger and rolls back the migration.
- Rebuild validation now detects foreign-key violations and invalid dependent views before committing schema changes.
- Multiple inverse relationships to the same parent now have distinct, consistently typed accessors for both lazy navigation and .with() eager loading.
- Schema migrations retain historical table snapshots that can be inspected or recovered through db.migrator().
