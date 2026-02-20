# sqlite-zod-orm

**Type-safe SQLite ORM for Bun** — Zod schemas in, fully typed database out. Zero SQL required.

[![npm](https://img.shields.io/npm/v/sqlite-zod-orm)](https://www.npmjs.com/package/sqlite-zod-orm)
[![license](https://img.shields.io/npm/l/sqlite-zod-orm)](./LICENSE)

## Install

```bash
bun add sqlite-zod-orm
```

> **Requires Bun runtime** — uses `bun:sqlite` under the hood.

## Quick Start

```typescript
import { Database, z } from 'sqlite-zod-orm';

const db = new Database('app.db', {
    users: z.object({
        name: z.string(),
        email: z.string(),
        role: z.string().default('member'),
    }),
});

// Insert
const alice = db.users.insert({ name: 'Alice', email: 'alice@co.com' });
alice.id; // auto-increment ID
alice.role; // 'member' (from Zod default)

// Query
const admins = db.users.select()
    .where({ role: 'admin' })
    .orderBy('name')
    .all();

// Update
alice.name = 'Alice Smith'; // auto-persists

// Delete
db.users.delete(alice.id);
```

## Features

- **Zod schemas → typed database** — define once, types flow everywhere
- **Auto-migration** — new schema fields auto-add columns on startup
- **Fluent query builder** — `.where()`, `.orderBy()`, `.limit()`, `.join()`, `.groupBy()`, `.having()`
- **Rich operators** — `$gt`, `$lt`, `$in`, `$like`, `$isNull`, `$isNotNull`, and more
- **Aggregates** — `.sum()`, `.avg()`, `.min()`, `.max()`, `.count()`
- **Pagination** — `.paginate(page, perPage)` with metadata
- **Relationships** — foreign keys, lazy navigation, fluent joins
- **Reactivity** — `.on('insert' | 'update' | 'delete', callback)` with trigger-based change tracking
- **Transactions** — `db.transaction(() => { ... })`
- **Timestamps** — auto `createdAt`/`updatedAt` with `{ timestamps: true }`
- **Soft deletes** — `{ softDeletes: true }` with `.withTrashed()`, `.onlyTrashed()`, `.restore()`
- **Unique constraints** — `{ unique: { users: [['email']] } }`
- **Schema introspection** — `db.tables()`, `db.columns('users')`
- **Raw SQL** — `db.raw()` / `db.exec()` escape hatch
- **Debug mode** — `{ debug: true }` logs all SQL to console
- **Distinct** — `.distinct()` on queries
- **Proxy queries** — SQL-like DSL with type-safe column references

## Documentation

See [SKILL.md](./SKILL.md) for comprehensive documentation with examples for every feature.

## Tests

```bash
bun test  # 160 tests, ~1.5s
```

## License

MIT
