# Changelog

## 4.2.3 (2026-11-18)

Every code example in README.md and UPGRADING.md now runs. `scripts/docs-examples.ts` extracts all 51 TypeScript examples, runs each against a fresh database, type-checks it and asserts every `// =>` result the text promises (`test/docs-examples.test.ts` runs it with the suite). On its first real run 47 of 51 passed. Most examples had been fragments that could not run at all.

- Fixed (docs): about 30 examples.
  - Some used schemas, fields or variables they never declared (`role`, `orders`, `AuthorSchema`).
  - Some showed invented results: pagination `{ total: 42 }`, a schema diff without a change.
  - `orderBy('score', 'DESC')` did not compile; it must be lowercase `'desc'`.
  - `load(..., { append: true })` reused existing ids.
- Fixed (types): `upsertMany` rows may carry an `id`, as `upsert` already allowed.
- Added (types): `join('agents', 'authorRef', ['name'])` types the joined columns as `agents_name` etc., from the joined table's schema; a column not listed is a type error. UPGRADING's own join example did not compile before.
- Nine real apps type-check with no new errors.

## 4.2.2 (2026-11-18)

Second speed round, same behaviour (7,607 tests pass). Speed relative to hand-written bun:sqlite on the same machine (10k rows, default options), 4.2.0 -> 4.2.2:

| Operation | 4.2.0 | 4.2.2 |
|---|---|---|
| `get(id)` | 12% | 91% |
| `select().where()` range | 9% | 77% |
| `.with()` one level | 10% | 69% |
| `update(id)` | 3% | 58% |
| get + update (game tick) | - | 74% |
| entity property assignment | 2% | 62% |
| `insert` | 7% | 35% |
| `upsert` | 4% | 10% |

- `update(id)` without an `afterUpdate` hook runs two statements instead of three (no extra `SELECT changes()`); it still reads the stored row back after triggers (`RETURNING` was rejected: it runs before triggers).
- No timing callbacks or labels are built for SQL calls when debug logging is off; point-update and point-select SQL, query executors and quoted identifiers are cached; `select().get()` fetches one row instead of all.
- Rows are decoded only for columns that need it (dates, booleans, JSON with dates, bigint, bytes); entity proxies share one handler per table.
- `bench/overhead.ts` adds a get+update tick; new perf guards cap statements per `update(id)`.

## 4.2.1 (2026-11-18)

Faster, same behaviour (all 7,603 tests pass). Measured with the new `bench/overhead.ts` (every operation against hand-written bun:sqlite at 1k and 10k rows, reactive/timestamps/softDeletes on and off; the ORM/raw ratio is compared so machine load cancels out), two runs before and after on one machine:

| Operation | Faster by |
|---|---|
| `update(id)` | 5.6x |
| entity property assignment | 5.3x |
| `upsert` | 3.9x |
| `insert` | 3.8x |
| `select().where()`, `get(id)`, `.with()` | 2.2-2.5x |
| bulk update | 2.4x |
| `insertMany` | 1.7x |
| `count`, `pluck`, `delete` | unchanged |

- Zod read/write plans and parsers are built once per schema instead of per row or per call.
- Entities reuse per-schema field and relation lists.
- `insertMany` prepares one statement per row shape and reads rows back in one batch.
- `.with()` on a forward relation loads targets straight from the already-hydrated rows' keys.
- `bench/overhead.ts --check bench/baseline.json` fails when any ORM/raw ratio gets more than 15% worse; `test/perf-guards.test.ts` checks query counts and statement reuse.

## 4.2.0 (2026-11-18)

Found by a write-results matrix (`test/write-results-matrix.test.ts`, 71 cases: every write API under reactive x softDeletes x timestamps x hooks x inside/outside/rolled-back transactions, each return value compared with a direct SQL count and every hook call recorded; 66 fail on 4.1.0).

### Changed (check your app if it uses hooks or cascade)
- After-hooks (`afterInsert`/`afterUpdate`/`afterDelete`/`afterRestore`) inside `transaction()` now run after the outermost commit, and never for work that was rolled back. Before, they ran immediately, also for rows that were then rolled back.
- `delete().where().exec()` and `select().deleteAll()` follow `cascade` like `delete(id)` does (they left children behind). They return the number of matched rows, not the last child statement's count.
- Native conflict upserts (`upsert(row, { on, merge })`) fire one `afterInsert` or `afterUpdate` after commit; they fired none.
- Bulk updates, `updateAll`, `increment` and `decrement` set `updatedAt` when timestamps are on; `update(id, {})` writes nothing and fires no hook.

### Fixed
- Assigning `entity.field = x` leaves the entity showing what was stored (after hooks and validation), not the raw assignment.
- `findOrCreate` takes the write lock before looking, so two processes can't both create; conditions win over defaults with the same key.
- `upsertMany` fires no after-hooks for earlier rows when a later row aborts the batch; `upsert` treats id `0` as an id.
- README: lifecycle hook arguments are `(data, id)`, and which calls run hooks.

Checked with the real-run tools: upgrade from 3.34.0 12/12; 9 apps type-check with no new errors; in C:/Code only mements--kk combines `cascade` with bulk deletes, and its `deleteAll()` calls are on tables that have no cascade.

## 4.1.0 (2026-11-18)

The types now say what the code returns. Found by a type matrix (`test/types-matrix.test.ts`: every public API, each type assertion paired with a run-time check of the same fact; 63 of its assertions fail to compile on 4.0.11).

### Types
- `.with('user')` results type the loaded row (or `null`), `.with('posts')` an array, nested paths up to four levels; before, the type still said "lazy accessor function".
- `timestamps: true` / `softDeletes: true` add `createdAt`/`updatedAt`/`deletedAt` to row types, only when on.
- `where()` checks operators per column: `$in` takes an array, `$between` a pair, unknown `$` operators and non-columns are type errors; `null` is allowed (it means `IS NULL`).
- `select('a').select('b')` types both columns (both are selected); relation accessors can't be selected as columns.
- `.raw()`, joins and `.pluck()` type the stored SQLite values (dates as text, booleans as 0/1), not parsed entities.
- Read-only views have no write methods in their query type; `update()` can't change `id`; `insert()` accepts an explicit numeric `id`.

### Changed
- `.on('insert' | 'update')` listeners always get the whole row. A row hard-deleted before the poll is skipped (its delete event follows) instead of arriving as `{ id }` as in 4.0.10; soft-deleted rows still arrive whole, with `deletedAt`.

### Checked against real apps
- `scripts/typecheck-apps.ts <app>...` type-checks apps against this version without touching them. agenthub, bgr, cnc, crowdclaw, diadem, gxy-aa, prompt-proxy, prompts-explorer and starwar: no new type errors. ChatGPT's draft also made `transaction()` reject async callbacks by type; that broke crowdclaw's generic `withSqliteRetry<T>(fn: () => T)` wrapper, so it was dropped (async callbacks still throw at run time).

## 4.0.11 (2026-11-18)

Found by running the library for real (`scripts/upgrade-e2e.ts`: builds a database with an old published version, opens the same file with this one, compares every field, writes, and runs `.on()` across two processes):

- Fixed: `update().where().exec()` and `delete().where().exec()` returned twice the number of rows changed when change tracking was on (the default). Bun's statement `changes` also counts the rows the change-journal trigger writes; the count now comes from SQLite's `changes()`, which counts only the table's own rows. The rows changed were always the right ones.
- Added: `scripts/upgrade-e2e.ts [--from 3.34.0] [--to local|<version>]`. Upgrades from 3.26.1, 3.34.0 and 4.0.3 pass all 12 checks: no stored row changes on open, every field reads back the same, partial updates keep other fields, cascade soft delete and restore, live events across processes.

## 4.0.10 (2026-11-18)

Found by a change-feed matrix (`test/change-feed-matrix.test.ts`: two ORM connections and a bare `bun:sqlite` connection on one file, rollbacks and savepoints, bulk and raw writes, cascades, hooks, migrations, soft deletes, and 4,096 seeded write sequences, each checked for the exact events `.on()` delivers):

- Fixed: with two `Database` objects (or two processes) on one file, the first to poll deleted the change records, so `.on()` listeners on the other never fired. Records are now kept for the newest 10,000 changes; a reader that falls further behind misses the oldest ones. Opening a database also trims the journal to that window, so `_changes` no longer grows without limit when nothing listens.
- Fixed: an insert or update whose row was deleted before the next poll fired no event. The listener now gets `{ id }` when the row is gone.
- Fixed: soft-deleting or restoring a row fired no `update` event (the row was hidden from the lookup). The listener now gets the row with its `deletedAt`.
- Fixed: a listener added after a write could receive that earlier write. Listeners now see only writes made after they subscribe.
- Fixed: a table name containing `'` or `"` broke the change triggers at startup.

## 4.0.9 (2026-11-18)

Found by a relations matrix (`test/relations-matrix.test.ts`: 180 users, 650 posts, 2,100 comments, tags through a link table, two FKs to one table, a self-reference, nullable, dangling and custom-named FKs, with softDeletes off and on; every accessor, `.with()` and join compared with hand-written SQL):

- Fixed: `.with()` on a forward relation (the README's own `db.posts.select().with('user')`) loaded nothing; `posts[0].user` stayed the lazy accessor. It now attaches the related row, or `null` when the key is null, dangling or points at a soft-deleted row, in one batched query.
- Added: nested paths such as `.with('posts.comments.author')`; overlapping paths share the loaded rows. Before, a dotted path was silently ignored.
- Fixed: `orderBy('id')` (or any column both tables have) after `join()` threw "ambiguous column name". A bare `orderBy` field now means the main table's column, as its type already said.
- Changed: arrays loaded by `.with()` are ordered by id (the order was unspecified).

## 4.0.8 (2026-11-18)

Found by a differential query matrix (`test/query-matrix.test.ts`, 3,072 seeded queries over 8 column types and every where operator, each compared with a hand-written SQL statement on the same data). These bugs date back to 3.x:

- Fixed: bulk `update().where().exec()` and `delete().where().exec()` used only the first operator of a field, so `{ age: { $gte: 10, $lt: 20 } }` became `age >= 10` and changed or deleted rows outside the range. All operators now apply, as they already did in `select()`.
- Fixed: `select().where({ $or: [...] })` flattened every branch into one OR, so `$or: [{ name: "A", active: true }, ...]` matched rows meeting any single condition. Each branch is now an AND of its conditions.
- Fixed: `$or: []` matched every row; it now matches none. A branch that is empty or not an object throws.
- Changed: `where({ field: null })` now means `IS NULL` and `{ $ne: null }` means `IS NOT NULL`, in reads and in bulk writes. Before, both matched no rows.
- Changed: an unknown `$` key in `where()` (for example `$and`) throws. Before, it was silently ignored, which widened the filter.
- Fixed: `exists()` after `offset()` threw a SQL syntax error, and ignored the query's limit and offset.
- Fixed: bigint and JSON (object or array) filter values are compared in the form they are stored in.

## 4.0.7 (2026-11-18)

Found by a lifecycle test matrix (`test/lifecycle-matrix.test.ts`, 2,048 seeded sequences of up to 30 inserts, updates, upserts, deletes, soft deletes, restores, vetoing hooks and transactions over a 4-level tree, a self-reference and a many-to-many, checked after every step against a model of what each table should hold):

- Fixed: `upsert` on a soft-deleted row revived it with a bare SQL update. A child whose parent was still deleted came back as a live orphan, the rows deleted together with it stayed deleted, and `beforeRestore`/`afterRestore` hooks did not run. Reviving through `upsert` is now a `restore()`: it refuses orphans, brings back the rows deleted with it, and runs the restore hooks (after-hooks only once the upsert has committed).
- Fixed: two separate deletes in the same millisecond got the same `deletedAt`, so restoring one also restored the rows of the other. Soft-delete timestamps are now strictly increasing within a process.

## 4.0.6 (2026-11-18)

Found by a schema-change test matrix (`test/migration-matrix.test.ts`, 422 cases: 30 kinds of schema change x 7 table shapes x empty/populated, each checking that data survives exactly or the open is refused with the file unchanged):

- Fixed: a declared rename that also changed the column's type (for example a text field renamed into a number field) was copied without the populated-column type check, so SQLite could silently convert the values. It is now refused like any other populated type change.
- Fixed: a declared rename onto a column that already exists kept the existing column's values and dropped the renamed field's data. It is now refused; migrate such a mapping explicitly.
- Fixed: turning `softDeletes` off dropped the populated `deletedAt` column, so deleted rows came back as live rows. Opening is now refused while any row is soft-deleted; restore or purge those rows first.

## 4.0.5 (2026-11-18)

Found by a new round-trip test matrix (`test/roundtrip-matrix.test.ts`, 1,411 cells: every field type x every write path x optional/nullable/default):

- Fixed: number and boolean `z.literal()` fields read back as strings (`"2.5"`, `"1"`). Rows already stored that way read correctly too; no column type changes.
- Fixed: a `z.custom<Uint8Array>()` field was saved as JSON (`{"0":1,"1":2}`) and lost its bytes. Bytes are now stored as a BLOB value; rows saved the old way are decoded back into bytes on read.
- Fixed: `load(dump())` refused unions, discriminated unions, records, tuples, arrays of objects, objects with nested dates or bigints, bigint literals and Buffer fields. It now decodes every field the way reads do.

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
