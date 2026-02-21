/**
 * v321-features.test.ts — Tests for v3.21 features
 *
 * WAL mode, pluck(), clone(), exists() (extended coverage).
 */
import { describe, test, expect } from 'bun:test';
import { Database, z } from '../src/index';

const UserSchema = z.object({
    name: z.string(),
    role: z.string().default('guest'),
    score: z.number().default(0),
});

// ==========================================================================
// WAL mode
// ==========================================================================
describe('WAL mode', () => {
    test('WAL enabled by default', () => {
        const tmpPath = `/tmp/satidb-wal-test-${Date.now()}.db`;
        const db = new Database(tmpPath, { users: UserSchema });
        const result = db.raw<{ journal_mode: string }>('PRAGMA journal_mode');
        expect(result[0]!.journal_mode).toBe('wal');
        db.close();
    });

    test('WAL can be disabled', () => {
        const db = new Database(':memory:', { users: UserSchema }, { wal: false });
        const result = db.raw<{ journal_mode: string }>('PRAGMA journal_mode');
        expect(result[0]!.journal_mode).toBe('memory'); // :memory: returns 'memory' when WAL not set
        db.close();
    });
});

// ==========================================================================
// pluck
// ==========================================================================
describe('pluck', () => {
    test('returns flat array of column values', () => {
        const db = new Database(':memory:', { users: UserSchema });
        db.users.insert({ name: 'Alice', score: 100 });
        db.users.insert({ name: 'Bob', score: 50 });
        db.users.insert({ name: 'Charlie', score: 75 });

        const names = db.users.select().pluck('name');
        expect(names).toEqual(['Alice', 'Bob', 'Charlie']);
        db.close();
    });

    test('pluck with where filter', () => {
        const db = new Database(':memory:', { users: UserSchema });
        db.users.insert({ name: 'Alice', score: 100 });
        db.users.insert({ name: 'Bob', score: 50 });
        db.users.insert({ name: 'Charlie', score: 75 });

        const names = db.users.select().where({ score: { $gte: 75 } }).pluck('name');
        expect(names.sort()).toEqual(['Alice', 'Charlie']);
        db.close();
    });

    test('pluck numeric column', () => {
        const db = new Database(':memory:', { users: UserSchema });
        db.users.insert({ name: 'Alice', score: 100 });
        db.users.insert({ name: 'Bob', score: 50 });

        const scores = db.users.select().pluck('score');
        expect(scores).toEqual([100, 50]);
        db.close();
    });
});

// ==========================================================================
// clone
// ==========================================================================
describe('clone', () => {
    test('cloned query does not affect original', () => {
        const db = new Database(':memory:', { users: UserSchema });
        db.users.insert({ name: 'Alice', score: 100 });
        db.users.insert({ name: 'Bob', score: 50 });
        db.users.insert({ name: 'Charlie', score: 75 });

        const base = db.users.select().where({ score: { $gte: 50 } });
        const high = base.clone().where({ score: { $gte: 75 } });

        expect(base.count()).toBe(3); // all >= 50
        expect(high.count()).toBe(2); // only >= 75
        db.close();
    });

    test('cloned query preserves ordering', () => {
        const db = new Database(':memory:', { users: UserSchema });
        db.users.insert({ name: 'Alice', score: 100 });
        db.users.insert({ name: 'Bob', score: 50 });

        const base = db.users.select().orderBy('score', 'desc');
        const cloned = base.clone();

        expect(cloned.first()!.name).toBe('Alice');
        db.close();
    });
});

// ==========================================================================
// exists (extended coverage)
// ==========================================================================
describe('exists', () => {
    test('returns true when rows match', () => {
        const db = new Database(':memory:', { users: UserSchema });
        db.users.insert({ name: 'Alice' });
        expect(db.users.select().where({ name: 'Alice' }).exists()).toBe(true);
        db.close();
    });

    test('returns false when no rows match', () => {
        const db = new Database(':memory:', { users: UserSchema });
        db.users.insert({ name: 'Alice' });
        expect(db.users.select().where({ name: 'Nobody' }).exists()).toBe(false);
        db.close();
    });
});
