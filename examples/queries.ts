/**
 * queries.ts — Three Query Approaches
 *
 * Demonstrates sqlite-zod-orm's three ways to query:
 *  1. Fluent builder:  db.books.select().where({...}).all()
 *  2. Fluent join:     db.books.select().join(db.authors).all()
 *  3. Proxy callback:  db.query(c => { ... })
 *
 * Run: bun examples/queries.ts
 */
import { Database, z } from '../src/index';

// --- Schemas ---

interface Author { name: string; country: string; books?: Book[]; }
interface Book { title: string; year: number; pages: number; author?: Author; }

const AuthorSchema: z.ZodType<Author> = z.object({
    name: z.string(),
    country: z.string(),
    books: z.lazy(() => z.array(BookSchema)).optional(),
});

const BookSchema: z.ZodType<Book> = z.object({
    title: z.string(),
    year: z.number(),
    pages: z.number(),
    author: z.lazy(() => AuthorSchema).optional(),
});

// --- Seed ---

const db = new Database(':memory:', {
    authors: AuthorSchema,
    books: BookSchema,
});

const tolstoy = db.authors.insert({ name: 'Leo Tolstoy', country: 'Russia' });
const dostoevsky = db.authors.insert({ name: 'Fyodor Dostoevsky', country: 'Russia' });
const kafka = db.authors.insert({ name: 'Franz Kafka', country: 'Czech Republic' });

tolstoy.books.push({ title: 'War and Peace', year: 1869, pages: 1225 });
tolstoy.books.push({ title: 'Anna Karenina', year: 1878, pages: 864 });
dostoevsky.books.push({ title: 'Crime and Punishment', year: 1866, pages: 671 });
dostoevsky.books.push({ title: 'The Brothers Karamazov', year: 1880, pages: 796 });
kafka.books.push({ title: 'The Trial', year: 1925, pages: 255 });

console.log(`Seeded ${db.authors.select().count()} authors, ${db.books.select().count()} books\n`);

// =============================================================================
// 1. Fluent Builder — single-table queries
// =============================================================================

console.log('── 1. Fluent Builder ──');

const longBooks = db.books.select()
    .where({ pages: { $gt: 700 } })
    .orderBy('pages', 'desc')
    .all();
console.log('Books > 700 pages:', longBooks.map((b: any) => `${b.title} (${b.pages}p)`));

const oldBooks = db.books.select()
    .where({ year: { $lt: 1870 } })
    .all();
console.log('Pre-1870:', oldBooks.map((b: any) => b.title));

const count = db.books.select().where({ pages: { $gte: 500 } }).count();
console.log(`Books >= 500 pages: ${count}`);

// =============================================================================
// 2. Fluent Join — cross-table with auto FK inference
// =============================================================================

console.log('\n── 2. Fluent Join ──');

const booksWithAuthors = db.books.select('title', 'year', 'pages')
    .join(db.authors, ['name', 'country'])
    .orderBy('year', 'asc')
    .all();

console.log('All books with authors:');
for (const row of booksWithAuthors) {
    console.log(`  ${(row as any).year} - ${(row as any).title} by ${(row as any).authors_name} (${(row as any).authors_country})`);
}

// Filter joined results in JS (WHERE applies to base table only)
const allWithAuthor = db.books.select('title')
    .join(db.authors, ['name', 'country'])
    .orderBy('year', 'asc')
    .all();
const russianBooks = allWithAuthor.filter((b: any) => b.authors_country === 'Russia');
console.log('Russian books:', russianBooks.map((b: any) => b.title));

// =============================================================================
// 3. Proxy Callback — SQL-like with destructured tables (full SQL WHERE on joins)
// =============================================================================

console.log('\n── 3. Proxy Callback ──');

// Proxy query CAN filter on joined columns natively
const results = db.query((c: any) => {
    const { authors: a, books: b } = c;
    return {
        select: { author: a.name, book: b.title, year: b.year },
        join: [[b.authorId, a.id]],
        where: { [a.country]: 'Russia' },
        orderBy: { [b.year]: 'asc' },
    };
});

console.log('Russian books (proxy query):');
for (const row of results) {
    console.log(`  ${(row as any).year} - ${(row as any).book} by ${(row as any).author}`);
}

// Complex: with limit
const latest = db.query((c: any) => {
    const { books: b, authors: a } = c;
    return {
        select: { title: b.title, author: a.name, year: b.year },
        join: [[b.authorId, a.id]],
        orderBy: { [b.year]: 'desc' },
        limit: 2,
    };
});
console.log('Latest 2 books:', latest.map((r: any) => `${r.title} (${r.year})`));

console.log('\n✅ queries.ts complete');
