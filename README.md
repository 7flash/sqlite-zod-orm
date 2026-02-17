# sqlite-zod-orm

Type-safe SQLite ORM for Bun. Define schemas with Zod, get a fully-typed database with automatic relationships, lazy navigation, and zero SQL.

```bash
bun add sqlite-zod-orm
```

## Quick Start

```typescript
import { Database, z } from 'sqlite-zod-orm';

const db = new Database(':memory:', {
  users: z.object({
    name: z.string(),
    email: z.string().email(),
    role: z.string().default('member'),
  }),
});

const alice = db.users.insert({ name: 'Alice', email: 'alice@example.com', role: 'admin' });
const admin = db.users.select().where({ role: 'admin' }).get();  // single row
const all   = db.users.select().all();                           // all rows
```

---

## Defining Relationships

Declare relationships in the constructor options — clean schemas, no boilerplate:

```typescript
const AuthorSchema = z.object({ name: z.string(), country: z.string() });
const BookSchema = z.object({ title: z.string(), year: z.number() });

const db = new Database(':memory:', {
  authors: AuthorSchema,
  books: BookSchema,
}, {
  relations: {
    books: { author: 'authors' },
  },
});
```

`books: { author: 'authors' }` means the **books** table will have an **`author_id`** column with a foreign key to the **authors** table.

The ORM automatically:
- Creates `author_id INTEGER REFERENCES authors(id)` column on `books`
- Infers the inverse `authors → books` (one-to-many)
- Enables lazy navigation: `book.author()`, `author.books()`
- Enables entity references in insert/where: `{ author: tolstoy }`
- Enables fluent joins: `db.books.select().join(db.authors).all()`

---

## Querying — `select()` is the only path

All queries go through `select()`:

```typescript
// Single row
const user = db.users.select().where({ id: 1 }).get();

// All matching rows
const admins = db.users.select().where({ role: 'admin' }).all();

// All rows
const everyone = db.users.select().all();

// Count
const count = db.users.select().count();
```

### Operators

`$gt` `$gte` `$lt` `$lte` `$ne` `$in`

```typescript
const topScorers = db.users.select()
  .where({ score: { $gt: 50 } })
  .orderBy('score', 'desc')
  .limit(10)
  .all();
```

### `$or`

```typescript
const results = db.users.select()
  .where({ $or: [{ role: 'admin' }, { score: { $gt: 50 } }] })
  .all();

// Combined with AND
const alive = db.trees.select()
  .where({ alive: true, $or: [{ name: 'Oak' }, { name: 'Elm' }] })
  .all();
// → WHERE alive = 1 AND (name = 'Oak' OR name = 'Elm')
```

### Fluent Join

Auto-infers foreign keys from relationships:

```typescript
const rows = db.books.select('title', 'year')
  .join(db.authors, ['name', 'country'])
  .where({ year: { $gt: 1800 } })
  .orderBy('year', 'asc')
  .all();
// → [{ title: 'War and Peace', year: 1869, authors_name: 'Leo Tolstoy', ... }]
```

### `db.query()` — Proxy Query (SQL-like)

Full SQL-like control with destructured table aliases:

```typescript
const rows = db.query(c => {
  const { authors: a, books: b } = c;
  return {
    select: { author: a.name, book: b.title, year: b.year },
    join: [[b.author, a.id]],
    where: { [a.country]: 'Russia' },
    orderBy: { [b.year]: 'asc' },
  };
});
```

---

## Entity References

Pass entities directly in `insert()` and `where()` — the ORM resolves to foreign keys:

```typescript
const tolstoy = db.authors.insert({ name: 'Leo Tolstoy', country: 'Russia' });

// Insert — entity resolves to author_id FK
db.books.insert({ title: 'War and Peace', year: 1869, author: tolstoy });

// WHERE — entity resolves to FK condition
const books = db.books.select().where({ author: tolstoy }).all();
```

## Lazy Navigation

Relationship fields become callable methods on returned entities:

```typescript
// belongs-to: book → author
const book = db.books.select().where({ title: 'War and Peace' }).get()!;
const author = book.author();       // → { name: 'Leo Tolstoy', ... }

// one-to-many: author → books
const books = tolstoy.books();      // → [{ title: 'War and Peace' }, ...]

// Chain
const allByAuthor = book.author().books();
```

---

## CRUD

```typescript
// Insert (defaults fill in automatically)
const user = db.users.insert({ name: 'Alice', role: 'admin' });

// Read
const one   = db.users.select().where({ id: 1 }).get();
const some  = db.users.select().where({ role: 'admin' }).all();
const all   = db.users.select().all();
const count = db.users.select().count();

// Entity-level update
user.update({ role: 'superadmin' });

// Update by ID
db.users.update(1, { role: 'superadmin' });

// Fluent update with WHERE
db.users.update({ role: 'member' }).where({ role: 'guest' }).exec();

// Upsert
db.users.upsert({ name: 'Alice' }, { name: 'Alice', role: 'admin' });

// Delete
db.users.delete(1);
```

### Auto-Persist Proxy

Setting a property on an entity auto-updates the DB:

```typescript
const alice = db.users.select().where({ id: 1 }).get()!;
alice.score = 200;    // → UPDATE users SET score = 200 WHERE id = 1
```

---

## Schema Validation

Zod validates every insert and update at runtime:

```typescript
db.users.insert({ name: '', email: 'bad', age: -1 });  // throws ZodError
```

---

## Indexes

```typescript
const db = new Database(':memory:', schemas, {
  indexes: {
    users: ['email', ['name', 'role']],
    books: ['author_id', 'year'],
  },
});
```

---

## Change Tracking & Events

```typescript
const db = new Database(':memory:', schemas, { changeTracking: true });
db.getChangesSince(0);

db.users.subscribe('insert', (user) => console.log('New:', user.name));
```

---

## Smart Polling

```typescript
const unsub = db.users.select()
  .where({ role: 'admin' })
  .subscribe((admins) => {
    console.log('Admin list changed:', admins);
  }, { interval: 1000 });

unsub();
```

---

## Examples & Tests

```bash
bun examples/example.ts    # comprehensive demo
bun test                    # 91 tests
```

---

## API Reference

| Method | Description |
|---|---|
| `new Database(path, schemas, options?)` | Create database with Zod schemas |
| **Querying** | |
| `db.table.select(...cols?).where(filter).get()` | Single row |
| `db.table.select(...cols?).where(filter).all()` | Array of rows |
| `db.table.select().all()` | All rows |
| `db.table.select().where({ $or: [...] }).all()` | OR conditions |
| `db.table.select().join(db.other, cols?).all()` | Fluent join (auto FK) |
| `db.table.select().count()` | Count rows |
| `db.query(c => { ... })` | Proxy callback (SQL-like JOINs) |
| **Writing** | |
| `db.table.insert(data)` | Insert with validation; entities resolve to FKs |
| `db.table.update(id, data)` | Update by ID |
| `db.table.update(data).where(filter).exec()` | Fluent update |
| `db.table.upsert(match, data)` | Insert or update |
| `db.table.delete(id)` | Delete by ID |
| **Navigation** | |
| `entity.relationship()` | Lazy navigation (read-only) |
| `entity.update(data)` | Update entity in-place |
| `entity.delete()` | Delete entity |
| **Events** | |
| `db.table.subscribe(event, callback)` | Listen for insert/update/delete |
| `db.table.select().subscribe(cb, opts)` | Smart polling |
| `db.getChangesSince(version, table?)` | Change tracking |

## License

MIT
