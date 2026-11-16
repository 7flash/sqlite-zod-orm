# Upgrading to 4.0

Version 4.0.0 introduces stricter schema migration validation, relationship resolution, and navigation accessor naming. Applications upgrading from 3.34 should review existing database schemas and relationship queries before deployment.

## 1. Prepare for automatic schema rebuilds

Schema synchronization can reconstruct existing tables rather than modifying them in place. Rebuilds involve existing data, indexes, triggers, and foreign-key relationships.

A rebuild that leaves invalid foreign-key references is rejected.

**Exact error (`src/database.ts:225`):**

```text
Schema sync would leave foreign key violations
```

Back up the database before upgrading and test initialization against a copy containing representative production data.

Apply explicit data migrations before constructing the ORM database. Schema synchronization occurs during database initialization.

The following helper can be used for the SQL examples in this guide:

```typescript
import { Database as SQLite } from "bun:sqlite";

function migrate(sql: string): void {
const sqlite = new SQLite("app.db");

sqlite.exec("PRAGMA foreign_keys = OFF");

try {
sqlite.exec("BEGIN IMMEDIATE");

try {
sqlite.exec(sql);

const violations = sqlite
.query("PRAGMA foreign_key_check")
.all();

if (violations.length > 0) {
throw new Error(
`Foreign-key violations: ${JSON.stringify(violations)}`
);
}

sqlite.exec("COMMIT");
} catch (error) {
sqlite.exec("ROLLBACK");
throw error;
}
} finally {
sqlite.exec("PRAGMA foreign_keys = ON");
sqlite.close();
}
}
```

Run migrations while the application is stopped and before creating `new Database("app.db", ...)`.

The examples below assume the indicated table structures. When manually rebuilding a real table, preserve all required columns, primary keys, constraints, indexes, triggers, and dependent references.

## 2. Explicitly migrate populated columns when changing their types

Error you will see:

```text
Cannot automatically change type of populated column "<table>.<column>" from <OLD> to <NEW>; use an explicit data-conversion migration.
```

Schema synchronization rejects changes to the declared type of a populated column.

The guard is present at `src/database.ts:505`. Its exact error text is unavailable because the supplied excerpt ends at `throw new Error(`.

For example, changing:

```typescript
const UserSchema = z.object({
age: z.string(),
});
```

to:

```typescript
const UserSchema = z.object({
age: z.number(),
});
```

requires an explicit data migration.

For a `users` table containing `id`, `name`, and `age`:

```typescript
migrate(`
CREATE TABLE users_next (
id INTEGER PRIMARY KEY,
name TEXT,
age INTEGER
);

INSERT INTO users_next (id, name, age)
SELECT id, name, CAST(age AS INTEGER)
FROM users;

DROP TABLE users;

ALTER TABLE users_next RENAME TO users;
`);
```

Validate existing values before conversion. SQLite can convert invalid numeric strings to zero, so a successful cast does not guarantee correct data.

Do not rely on automatic reconstruction to perform semantic data conversions.

## 3. Explicitly migrate removed populated columns

Error you will see:

```text
Cannot automatically drop populated column "<table>.<column>" while adding "<new>"; use an explicit column-mapping migration.
```

Schema synchronization checks for removed columns containing existing data.

The guard is present at `src/database.ts:515`. The supplied source does not expose the complete error message.

A column removal must not silently discard populated data. This also matters when replacing one field with another, such as renaming `full_name` to `displayName`.

Before changing the Zod schema, rename the SQLite column:

```typescript
migrate(`
ALTER TABLE users
RENAME COLUMN full_name TO displayName;
`);
```

Then update the schema:

```typescript
const UserSchema = z.object({
displayName: z.string(),
});
```

If the new field is not a direct rename, populate it explicitly and migrate the table to its final structure before ORM initialization.

## 4. Preserve legacy constraints during rebuilds

Error you will see:

```text
Cannot automatically rebuild "<table>": legacy CHECK|ON CONFLICT|NOT NULL constraint/policy cannot be recreated; use an explicit constraint-preserving migration.
```

Automatic reconstruction checks existing table constraints. The source contains a guard for unsupported legacy constraints at `src/database.ts:538`, with an explicit `NOT NULL` check visible at lines 535–536.

The exact exception text is unavailable in the provided excerpt.

Inspect existing definitions before changing schemas:

```typescript
import { Database as SQLite } from "bun:sqlite";

const sqlite = new SQLite("app.db");

const definition = sqlite.query(`
SELECT sql
FROM sqlite_schema
WHERE type = 'table' AND name = 'users'
`).get();

console.log(definition);

sqlite.close();
```

For example, a manually created table may contain:

```sql
CREATE TABLE users (
id INTEGER PRIMARY KEY,
name TEXT NOT NULL,
age INTEGER CHECK (age >= 0),
email TEXT UNIQUE ON CONFLICT IGNORE
);
```

If a constraint cannot be reproduced by the generated schema, perform an explicit migration rather than allowing automatic reconstruction to discard it.

Keep the existing constraint when its semantics are required. Replacing a `UNIQUE ON CONFLICT IGNORE` constraint with an ordinary unique index, for example, changes conflict handling unless equivalent behavior is implemented elsewhere.

## 5. Foreign-key definitions must survive reconstruction

Error you will see:

```text
Cannot automatically rebuild "<table>": outgoing foreign keys (targets or ON DELETE/ON UPDATE actions) differ; use an explicit foreign-key migration.
```

Rebuild validation compares foreign-key definitions. A mismatch causes reconstruction to fail rather than silently accepting incompatible references.

The comparison failure is present at `src/database.ts:565`, but its exact message is omitted from the supplied excerpt.

Inspect existing definitions:

```typescript
const sqlite = new SQLite("app.db");

const foreignKeys = sqlite
.query("PRAGMA foreign_key_list(grants)")
.all();

console.table(foreignKeys);

sqlite.close();
```

Compare these definitions with the schema generated in a fresh database using version 4.0.

If a change to a foreign-key action is intentional, explicitly reconstruct the affected table. For example, to change an existing reference to `ON DELETE SET NULL`:

```typescript
migrate(`
CREATE TABLE grants_next (
id INTEGER PRIMARY KEY,
authorRef INTEGER
REFERENCES agents(id)
ON DELETE SET NULL
);

INSERT INTO grants_next (id, authorRef)
SELECT id, authorRef
FROM grants;

DROP TABLE grants;

ALTER TABLE grants_next RENAME TO grants;
`);
```

Use this definition only if it matches the intended relationship behavior. Preserve indexes, triggers, and other columns in the actual migration.

Run `PRAGMA foreign_key_check` before committing the migration.

## 6. Rebuilds validate indexes

Version 4.0 contains explicit checks for indexes that cannot safely be reconstructed.

**Exact errors (`src/database.ts:604`, `608`, `616`):**

```text
Cannot automatically reconstruct inline index '<index>'.
Rebuild index '<index>' conflicts with an existing schema object.
Cannot reconstruct an unnamed index on '<table>'.
```

For indexes that cannot be reconstructed automatically, explicitly migrate the table and recreate the required unique indexes.

For example, to replace an inline unique constraint on `users.email` with a named unique index:

```typescript
migrate(`
CREATE TABLE users_next (
id INTEGER PRIMARY KEY,
email TEXT
);

INSERT INTO users_next (id, email)
SELECT id, email FROM users;

DROP TABLE users;

ALTER TABLE users_next RENAME TO users;

CREATE UNIQUE INDEX users_email_unique
ON users(email);
`);
```

This example assumes `id` and `email` are the table's only columns and that the replacement index has the intended conflict behavior.

For an index name conflict, inspect existing schema objects and choose a non-conflicting name. Do not drop unrelated indexes merely to allow initialization.

## 7. Invalid dependent triggers can prevent migration

Error you will see:

```text
Invalid trigger "<trigger>": no such column: <column>
```

Rebuild validation includes trigger definitions. Invalid trigger SQL can cause initialization to fail rather than allowing a broken trigger to remain unnoticed.

**Exact errors (`src/database.ts:721`, `724`, `732`, `807`):**

```text
Invalid trigger definition: <trigger>
Cannot determine event for trigger "<trigger>"
Trigger validation failed: <error>
```

The source also contains trigger-specific validation errors at lines 756 and 801, but their complete message strings are unavailable in the supplied excerpts.

If a trigger references a removed or renamed column, update its SQL before the schema rebuild.

For example:

```sql
CREATE TRIGGER posts_sync_user_name
AFTER UPDATE OF authorName ON posts
BEGIN
UPDATE users
SET screenName = NEW.authorName
WHERE id = NEW.authorRef;
END;
```

If the intended destination column is now `displayName`, replace the trigger:

```typescript
migrate(`
DROP TRIGGER IF EXISTS posts_sync_user_name;

CREATE TRIGGER posts_sync_user_name
AFTER UPDATE OF authorName ON posts
BEGIN
UPDATE users
SET displayName = NEW.authorName
WHERE id = NEW.authorRef;
END;
`);
```

Ensure the referenced columns exist when the final schema is initialized.

For `INSTEAD OF` triggers on views, update the view definition and its trigger references together.

## 8. Ambiguous automatic joins must specify the foreign key

Error you will see:

```text
Ambiguous automatic join between '<from>' and '<to>': foreign keys <table>.<fk>, <table>.<fk>. Use join('<to>', fromColumn, columns, toColumn) to specify the join.
```

Automatic join resolution now rejects ambiguous relationships instead of relying on an arbitrary matching foreign key.

The ambiguity guards are present at `src/query.ts:87` and `src/query.ts:122`. Both use multiline errors whose messages are not included in the supplied excerpts.

For example:

```typescript
const db = new Database("app.db", {
agents: AgentSchema,
grants: GrantSchema,
}, {
relations: {
grants: {
authorRef: "agents",
agentRef: "agents",
auditorRef: "agents",
},
},
});
```

This query does not identify which relationship to use:

```typescript
db.grants
.select()
.join("agents")
.all();
```

Specify the intended foreign key:

```typescript
db.grants
.select()
.join("agents", "authorRef", ["name"])
.all();
```

For a different relationship:

```typescript
db.grants
.select()
.join("agents", "auditorRef", ["name"])
.all();
```

Review joins involving multiple foreign keys to the same table, including self-referencing relationships.

## 9. Update relationship navigation accessors

Relationship definitions can produce distinct inverse accessors for different foreign keys targeting the same parent table.

For the relationship configuration above, update navigation and eager-loading expressions to reference the intended relationship:

```typescript
const agent = db.agents.get(1);

const authored = agent.grantsByAuthorRef();
const audited = agent.grantsByAuditorRef();
```

Eager loading must use the corresponding accessor:

```typescript
db.agents
.select()
.with("grantsByAuthorRef")
.all();
```

Navigation names can also acquire a `Relation` suffix when an existing field or reserved method occupies the preferred name. The suffix behavior is visible in `src/schema.ts:32`.

**Exact error (`src/schema.ts:35`):**

```text
relations: conflicting navigation accessor '<table>.<accessor>'
```

For example, when `agentRef` is a stored field and the generated relationship accessor would collide:

```typescript
const grant = db.grants.get(1);

// Stored foreign-key value
const agentId = grant.agentRef;

// Relationship accessor
const agent = grant.agentRefRelation();
```

If a relationship definition cannot be resolved, rename the conflicting foreign-key field and update its relation mapping.

The source also validates referenced table names.

**Exact errors (`src/schema.ts:43`, `46`):**

```text
relations: unknown table '<table>'
relations: unknown target table '<target>' in <child>.<fk>
```

Correct the relation configuration to reference tables present in the schema map.

## 10. Populate newly required fields before initialization

Error you will see:

```text
Cannot populate required column "<table>.<column>"; add a default or use an explicit migration.
```

Automatic reconstruction checks whether a newly required column can be populated for existing rows.

The guard is present at `src/database.ts:653`, but its exact message is unavailable in the supplied excerpt.

Populate the field before applying the final Zod schema.

For example:

```typescript
migrate(`
ALTER TABLE users
ADD COLUMN region TEXT NOT NULL DEFAULT 'unknown';
`);
```

Then update the schema:

```typescript
const UserSchema = z.object({
region: z.string(),
});
```

Choose a default that is valid for the application's data model. When no universal default exists, use an explicit backfill based on existing records.

## Upgrade checklist

Before deploying version 4.0.0:

- [ ] Back up the SQLite database and test the upgrade against representative production data.
- [ ] Review populated-column type changes, removed columns, and newly required fields.
- [ ] Apply explicit data migrations before ORM initialization.
- [ ] Inspect legacy `CHECK`, `NOT NULL`, `ON CONFLICT`, and foreign-key definitions before reconstruction.
- [ ] Verify that existing indexes can be recreated without name conflicts or changed uniqueness semantics.
- [ ] Update dependent triggers and views that reference renamed or removed columns.
- [ ] Replace ambiguous automatic joins with calls specifying the intended foreign key.
- [ ] Update inverse accessor names and `.with()` expressions where multiple foreign keys reference the same parent table.
- [ ] Review conflicting navigation accessors and relationship configurations.
- [ ] Review package imports and runtime dependencies against the final 4.0.0 package metadata.
- [ ] Run TypeScript validation with `bunx tsc --noEmit`.
- [ ] Run application tests covering CRUD operations, joins, eager loading, and relationship navigation.
- [ ] Run `PRAGMA foreign_key_check` and verify indexes, triggers, foreign keys, and views after migration.
- [ ] Confirm that failed schema migrations roll back without leaving partially reconstructed tables.

The supplied throw-site excerpts establish the validation guards documented here but do not provide every multiline diagnostic, the package metadata, or a complete comparison with 3.34. Those details must be verified against the complete 4.0.0 source before publication.
