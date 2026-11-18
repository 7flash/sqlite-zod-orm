import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Database, z } from '../src/index';

test('all README and UPGRADING TypeScript examples compile and run', () => {
    const root = resolve(import.meta.dir, '..');
    const result = spawnSync('bun', ['scripts/docs-examples.ts', '--ci'], {
        cwd: root, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
    });
    if (result.status !== 0) console.error(result.stdout, result.stderr, result.error);
    expect(result.status).toBe(0);
}, 180_000);

// Regression for README's upsertMany({ id, ... }) snippet: id is generated
// by SQLite and is not part of the user-authored Zod schema, but the runtime
// uses it to select a row to update.
test('upsertMany accepts the generated id as an optional, typed match key', () => {
    const db = new Database(':memory:', {
        users: z.object({ name: z.string(), email: z.string() }),
    });
    try {
        const inserted = db.users.insert({ name: 'Alice', email: 'alice@example.org' });
        const updated = db.users.upsertMany([{ id: inserted.id, name: 'Updated Alice' }]);
        expect(updated[0]?.id).toBe(inserted.id);
        expect(db.users.get(inserted.id)?.name).toBe('Updated Alice');
        expect(db.users.get(inserted.id)?.email).toBe('alice@example.org');
        if (false) {
            // @ts-expect-error the generated id is numeric, not a string
            db.users.upsertMany([{ id: 'invalid', name: 'Should not compile' }]);
        }
    } finally {
        db.close();
    }
});
