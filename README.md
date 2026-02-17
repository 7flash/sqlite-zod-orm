# sqlite-zod-orm

Type-safe SQLite ORM for Bun. Define schemas with Zod, get a fully-typed database with **three ways to query**, automatic relationships, and zero SQL.

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
const found = db.users.get(1);          // by ID
const admin = db.users.get({ role: 'admin' }); // by filter
```

---

## Three Ways to Query

### 1. Fluent Builder — `select().where().all()`

Single-table queries with chaining. The workhorse API.

```typescript
const trees = db.trees.select()
  .where({ alive: true })
  .orderBy('planted', 'asc')
  .limit(10)
  .all();

// With operators
const old = db.trees.select()
  .where({ planted: { $lt: '1600-01-01' } })
  .all();

// Count / single row
const total = db.trees.select().where({ alive: true }).count();
const oak = db.trees.select().where({ name: 'Major Oak' }).get();
```

**Operators:** `$gt` `$gte` `$lt` `$lte` `$ne` `$in`

### 2. Fluent Join — `select().join(db.table).all()`

Cross-table queries with auto-inferred foreign keys from `z.lazy()` relationships.

```typescript
const rows = db.trees.select('name', 'planted')
  .join(db.forests, ['name', 'address'])
  .where({ alive: true })
  .orderBy('planted', 'asc')
  .all();
// → [{ name: 'Major Oak', planted: '1500-01-01',
//      forests_name: 'Sherwood', forests_address: 'Nottingham, UK' }]
```

### 3. Proxy Query — `db.query(c => { ... })`

Full SQL-like control with destructured table aliases. Supports WHERE on joined columns.

```typescript
const rows = db.query(c => {
  const { forests: f, trees: t } = c;
  return {
    select: { tree: t.name, forest: f.name, planted: t.planted },
    join: [[t.forestId, f.id]],
    where: { [f.name]: 'Sherwood' },
    orderBy: { [t.planted]: 'asc' },
  };
});
```

---

## Relationships

Define with `z.lazy()`. The ORM auto-creates FK columns, indexes, and navigation methods.

```typescript
interface Author { name: string; posts?: Post[]; }
interface Post { title: string; author?: Author; }

const AuthorSchema: z.ZodType<Author> = z.object({
  name: z.string(),
  posts: z.lazy(() => z.array(PostSchema)).optional(),    // one-to-many
});

const PostSchema: z.ZodType<Post> = z.object({
  title: z.string(),
  author: z.lazy(() => AuthorSchema).optional(),          // belongs-to → auto authorId FK
});
```

**Navigation:**

```typescript
// belongs-to: child → parent
const post = db.posts.select().where({ title: 'Hello' }).get();
const author = post.author();

// one-to-many: parent → children
const alice = db.authors.get({ name: 'Alice' });
const posts = alice.posts.find();

// insert via relationship (auto-sets FK)
alice.posts.push({ title: 'New Post' });
```

---

## CRUD

```typescript
const user = db.users.insert({ name: 'Alice', role: 'admin' });
const found = db.users.get(1);
db.users.update(1, { role: 'superadmin' });
db.users.update({ role: 'member' }).where({ role: 'guest' }).exec();
db.users.upsert({ name: 'Alice' }, { name: 'Alice', role: 'admin' });
db.users.delete(1);
```

---

## Schema Validation

Zod validates every insert and update at runtime:

```typescript
const db = new Database(':memory:', {
  users: z.object({
    name: z.string().min(1),
    email: z.string().email(),
    age: z.number().int().positive(),
  }),
});

db.users.insert({ name: '', email: 'bad', age: -1 });  // throws ZodError
```

---

## Indexes

```typescript
const db = new Database(':memory:', schemas, {
  indexes: {
    users: ['email', ['name', 'role']],  // single + composite
    trees: ['forestId', 'planted'],
  },
});
```

---

## Change Tracking

```typescript
const db = new Database(':memory:', schemas, { changeTracking: true });
const changes = db.getChangesSince(0);
// [{ table_name: 'users', row_id: 1, action: 'INSERT' }, ...]
```

---

## Event Subscriptions

```typescript
db.users.subscribe('insert', (user) => console.log('New:', user.name));
db.users.subscribe('update', (user) => console.log('Updated:', user.name));
```

---

## Smart Polling

```typescript
const unsub = db.users.select()
  .where({ role: 'admin' })
  .subscribe((admins) => {
    console.log('Admin list changed:', admins);
  }, { interval: 1000 });

unsub(); // stop listening
```

---

## Examples

Each example is a standalone script focused on one feature area:

| Example | Focus | Run |
|---|---|---|
| [`basics.ts`](./examples/basics.ts) | CRUD, queries, operators, validation | `bun examples/basics.ts` |
| [`relationships.ts`](./examples/relationships.ts) | z.lazy(), navigation, .push() | `bun examples/relationships.ts` |
| [`queries.ts`](./examples/queries.ts) | All three query approaches | `bun examples/queries.ts` |

Integration tests:

```bash
bun test
```

---

## Project Structure

```
src/
  index.ts           — public exports
  database.ts        — Database class
  types.ts           — type definitions
  schema.ts          — schema parsing, storage transforms
  query-builder.ts   — fluent select/join/where/orderBy
  proxy-query.ts     — db.query(c => {...}) proxy callback
  ast.ts             — AST compiler for callback-style WHERE

examples/            — standalone runnable scripts
test/                — unit + integration tests (76 tests)
```

---

## API Reference

| Method | Description |
|---|---|
| `new Database(path, schemas, options?)` | Create database with Zod schemas |
| `db.table.insert(data)` | Insert with validation |
| `db.table.get(id \| filter)` | Get single row |
| `db.table.update(id, data)` | Update by ID |
| `db.table.update(data).where(filter).exec()` | Fluent update |
| `db.table.upsert(match, data)` | Insert or update |
| `db.table.delete(id)` | Delete by ID |
| `db.table.select().where().orderBy().limit().offset().all()` | Fluent query |
| `db.table.select().join(db.other, cols?).all()` | Fluent join (auto FK) |
| `db.query(c => { ... })` | Proxy callback query |
| `db.table.select().count()` | Count rows |
| `db.table.select().subscribe(cb, opts)` | Smart polling |
| `db.getChangesSince(version, table?)` | Change tracking |
| `entity.parent()` | Navigate belongs-to |
| `entity.children.find()` | Navigate one-to-many |
| `entity.children.push(data)` | Insert via relationship |

## License

MIT
