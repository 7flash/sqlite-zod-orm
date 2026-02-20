/**
 * v314-features.test.ts — Tests for v3.14 features
 *
 * findOrCreate, whereRaw, JSON columns.
 */
import { describe, test, expect } from 'bun:test';
import { Database, z } from '../src/index';

const UserSchema = z.object({
    name: z.string(),
    email: z.string(),
    role: z.string().default('member'),
    score: z.number().default(0),
});

// ==========================================================================
// findOrCreate
// ==========================================================================
describe('findOrCreate', () => {
    test('creates a new row when not found', () => {
        const db = new Database(':memory:', { users: UserSchema });
        const { entity, created } = db.users.findOrCreate(
            { email: 'alice@co.com' },
            { name: 'Alice' },
        );
        expect(created).toBe(true);
        expect(entity.email).toBe('alice@co.com');
        expect(entity.name).toBe('Alice');
        expect(entity.id).toBeGreaterThan(0);
        db.close();
    });

    test('finds existing row without creating', () => {
        const db = new Database(':memory:', { users: UserSchema });
        db.users.insert({ name: 'Alice', email: 'alice@co.com' });
        const { entity, created } = db.users.findOrCreate(
            { email: 'alice@co.com' },
            { name: 'Should Not Create' },
        );
        expect(created).toBe(false);
        expect(entity.name).toBe('Alice'); // original name, not defaults
        expect(db.users.select().count()).toBe(1);
        db.close();
    });

    test('merges conditions and defaults on create', () => {
        const db = new Database(':memory:', { users: UserSchema });
        const { entity } = db.users.findOrCreate(
            { email: 'bob@co.com', role: 'admin' },
            { name: 'Bob', score: 100 },
        );
        expect(entity.email).toBe('bob@co.com');
        expect(entity.role).toBe('admin');
        expect(entity.name).toBe('Bob');
        expect(entity.score).toBe(100);
        db.close();
    });
});

// ==========================================================================
// whereRaw
// ==========================================================================
describe('whereRaw', () => {
    test('filters with raw SQL fragment', () => {
        const db = new Database(':memory:', { users: UserSchema });
        db.users.insertMany([
            { name: 'Alice', email: 'a@co.com', score: 100 },
            { name: 'Bob', email: 'b@co.com', score: 50 },
            { name: 'Carol', email: 'c@co.com', score: 30 },
        ]);
        const results = db.users.select()
            .whereRaw('score > ? AND role = ?', [40, 'member'])
            .all();
        expect(results.length).toBe(2);
        expect(results.map(r => r.name).sort()).toEqual(['Alice', 'Bob']);
        db.close();
    });

    test('combines with .where()', () => {
        const db = new Database(':memory:', { users: UserSchema });
        db.users.insertMany([
            { name: 'Alice', email: 'a@co.com', score: 100, role: 'admin' },
            { name: 'Bob', email: 'b@co.com', score: 50, role: 'member' },
            { name: 'Carol', email: 'c@co.com', score: 80, role: 'admin' },
        ]);
        const results = db.users.select()
            .where({ role: 'admin' })
            .whereRaw('score > ?', [90])
            .all();
        expect(results.length).toBe(1);
        expect(results[0]!.name).toBe('Alice');
        db.close();
    });

    test('works with no params', () => {
        const db = new Database(':memory:', { users: UserSchema });
        db.users.insertMany([
            { name: 'Alice', email: 'a@co.com', score: 100 },
            { name: 'Bob', email: 'b@co.com', score: 0 },
        ]);
        const results = db.users.select()
            .whereRaw('score > 0')
            .all();
        expect(results.length).toBe(1);
        db.close();
    });
});

// ==========================================================================
// JSON columns
// ==========================================================================
describe('JSON columns', () => {
    const ConfigSchema = z.object({
        name: z.string(),
        settings: z.object({
            theme: z.string(),
            notifications: z.boolean(),
        }),
        tags: z.array(z.string()).default([]),
    });

    test('auto-serialize objects on insert and parse on read', () => {
        const db = new Database(':memory:', { configs: ConfigSchema });
        const config = db.configs.insert({
            name: 'user1',
            settings: { theme: 'dark', notifications: true },
            tags: ['vip', 'beta'],
        });
        expect(config.settings).toEqual({ theme: 'dark', notifications: true });
        expect(config.tags).toEqual(['vip', 'beta']);

        // Verify raw storage is JSON string
        const raw = db.raw<{ settings: string }>('SELECT settings FROM configs WHERE id = ?', config.id);
        expect(typeof raw[0]!.settings).toBe('string');
        expect(JSON.parse(raw[0]!.settings)).toEqual({ theme: 'dark', notifications: true });
        db.close();
    });

    test('preserve objects through update cycle', () => {
        const db = new Database(':memory:', { configs: ConfigSchema });
        const config = db.configs.insert({
            name: 'user1',
            settings: { theme: 'dark', notifications: true },
        });
        db.configs.update(config.id, { settings: { theme: 'light', notifications: false } });
        const updated = db.configs.select().where({ id: config.id }).get();
        expect(updated!.settings).toEqual({ theme: 'light', notifications: false });
        db.close();
    });

    test('handles empty arrays', () => {
        const db = new Database(':memory:', { configs: ConfigSchema });
        const config = db.configs.insert({
            name: 'user1',
            settings: { theme: 'dark', notifications: true },
            tags: [],
        });
        expect(config.tags).toEqual([]);
        db.close();
    });

    test('handles nested objects in arrays', () => {
        const ItemSchema = z.object({
            name: z.string(),
            metadata: z.record(z.string(), z.any()).default({}),
        });
        const db = new Database(':memory:', { items: ItemSchema });
        const item = db.items.insert({
            name: 'test',
            metadata: { key: 'value', nested: { deep: true } },
        });
        expect(item.metadata.key).toBe('value');
        expect(item.metadata.nested.deep).toBe(true);
        db.close();
    });
});
