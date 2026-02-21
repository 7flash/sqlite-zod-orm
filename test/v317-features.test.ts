/**
 * v317-features.test.ts — Tests for v3.17 features
 *
 * dump(), load(), seed().
 */
import { describe, test, expect } from 'bun:test';
import { Database, z } from '../src/index';

const UserSchema = z.object({
    name: z.string(),
    email: z.string(),
    score: z.number().default(0),
});

// ==========================================================================
// dump()
// ==========================================================================
describe('dump', () => {
    test('exports all table data as JSON', () => {
        const db = new Database(':memory:', { users: UserSchema });
        db.users.insert({ name: 'Alice', email: 'a@co.com', score: 100 });
        db.users.insert({ name: 'Bob', email: 'b@co.com', score: 50 });

        const data = db.dump();
        expect(data.users).toHaveLength(2);
        expect(data.users[0].name).toBe('Alice');
        expect(data.users[1].name).toBe('Bob');
        db.close();
    });

    test('dump includes all tables', () => {
        const PostSchema = z.object({ title: z.string() });
        const db = new Database(':memory:', { users: UserSchema, posts: PostSchema });
        db.users.insert({ name: 'Alice', email: 'a@co.com' });
        db.posts.insert({ title: 'Hello' });

        const data = db.dump();
        expect(Object.keys(data).sort()).toEqual(['posts', 'users']);
        expect(data.users).toHaveLength(1);
        expect(data.posts).toHaveLength(1);
        db.close();
    });

    test('dump of empty table returns empty array', () => {
        const db = new Database(':memory:', { users: UserSchema });
        const data = db.dump();
        expect(data.users).toEqual([]);
        db.close();
    });
});

// ==========================================================================
// load()
// ==========================================================================
describe('load', () => {
    test('imports data from dump (replaces existing)', () => {
        const db = new Database(':memory:', { users: UserSchema });
        db.users.insert({ name: 'Existing', email: 'x@co.com' });
        expect(db.users.count()).toBe(1);

        db.load({
            users: [
                { name: 'Alice', email: 'a@co.com', score: 100 },
                { name: 'Bob', email: 'b@co.com', score: 50 },
            ],
        });

        expect(db.users.count()).toBe(2);
        expect(db.users.select().first()!.name).toBe('Alice');
        db.close();
    });

    test('load with append: true does not truncate', () => {
        const db = new Database(':memory:', { users: UserSchema });
        db.users.insert({ name: 'Existing', email: 'x@co.com' });

        db.load({
            users: [{ name: 'New', email: 'n@co.com' }],
        }, { append: true });

        expect(db.users.count()).toBe(2);
        db.close();
    });

    test('round-trip: dump → load restores data', () => {
        const db1 = new Database(':memory:', { users: UserSchema });
        db1.users.insert({ name: 'Alice', email: 'a@co.com', score: 100 });
        db1.users.insert({ name: 'Bob', email: 'b@co.com', score: 50 });
        const data = db1.dump();
        db1.close();

        const db2 = new Database(':memory:', { users: UserSchema });
        db2.load(data);
        expect(db2.users.count()).toBe(2);
        const users = db2.users.select().orderBy('name').all();
        expect(users[0].name).toBe('Alice');
        expect(users[0].score).toBe(100);
        expect(users[1].name).toBe('Bob');
        db2.close();
    });

    test('load ignores unknown tables', () => {
        const db = new Database(':memory:', { users: UserSchema });
        db.load({
            users: [{ name: 'Alice', email: 'a@co.com' }],
            unknownTable: [{ foo: 'bar' }],
        });
        expect(db.users.count()).toBe(1);
        db.close();
    });
});

// ==========================================================================
// seed()
// ==========================================================================
describe('seed', () => {
    test('inserts fixture data without truncating', () => {
        const db = new Database(':memory:', { users: UserSchema });
        db.users.insert({ name: 'Existing', email: 'x@co.com' });

        db.seed({
            users: [
                { name: 'Alice', email: 'a@co.com' },
                { name: 'Bob', email: 'b@co.com' },
            ],
        });

        expect(db.users.count()).toBe(3);
        db.close();
    });

    test('seed multiple tables', () => {
        const PostSchema = z.object({ title: z.string() });
        const db = new Database(':memory:', { users: UserSchema, posts: PostSchema });

        db.seed({
            users: [{ name: 'Alice', email: 'a@co.com' }],
            posts: [{ title: 'Hello' }, { title: 'World' }],
        });

        expect(db.users.count()).toBe(1);
        expect(db.posts.count()).toBe(2);
        db.close();
    });
});
