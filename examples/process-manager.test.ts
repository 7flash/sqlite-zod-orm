/**
 * process-manager.test.ts — Tests for the process manager example
 *
 * Covers:
 *  - Insert + retrieve processes
 *  - Query latest by name (orderBy + limit)
 *  - Remove by pid, by name, and all
 *  - Change tracking on mutations
 *  - Index verification
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { createProcessDb } from './process-manager';

const { db, getProcess, getAllProcesses, getProcessByPid, insertProcess, removeProcess, removeProcessByName, removeAllProcesses } = createProcessDb(':memory:');

describe('Process Manager', () => {

    test('insert processes', () => {
        insertProcess({
            pid: 1001,
            workdir: '/app',
            command: 'bun run dev',
            name: 'web-server',
            configPath: '/app/bgr.config.ts',
            stdoutPath: '/tmp/web.stdout.log',
            stderrPath: '/tmp/web.stderr.log',
        });

        insertProcess({
            pid: 1002,
            workdir: '/app',
            command: 'bun run worker',
            name: 'worker',
            stdoutPath: '/tmp/worker.stdout.log',
        });

        insertProcess({
            pid: 1003,
            workdir: '/app',
            command: 'bun run dev --port 3001',
            name: 'web-server',  // Same name, newer timestamp
        });

        expect(getAllProcesses().length).toBe(3);
    });

    test('getProcess returns latest entry by name', () => {
        const latest = getProcess('web-server');
        expect(latest).not.toBeNull();
        expect(latest!.pid).toBe(1003);  // newest web-server
    });

    test('getProcessByPid returns specific process', () => {
        const worker = getProcessByPid(1002);
        expect(worker).not.toBeNull();
        expect(worker!.name).toBe('worker');
        expect(worker!.command).toBe('bun run worker');
    });

    test('getProcess returns null for unknown name', () => {
        expect(getProcess('nonexistent')).toBeNull();
    });

    test('removeProcess by pid', () => {
        // Remove worker
        removeProcess(1002);

        expect(getProcessByPid(1002)).toBeNull();
        expect(getAllProcesses().length).toBe(2);
    });

    test('removeProcessByName removes all matching', () => {
        // Both web-server entries should be removed
        removeProcessByName('web-server');

        expect(getProcess('web-server')).toBeNull();
        expect(getAllProcesses().length).toBe(0);
    });

    test('removeAllProcesses clears everything', () => {
        // Re-insert some
        insertProcess({ pid: 2001, workdir: '/a', command: 'cmd1', name: 'svc1' });
        insertProcess({ pid: 2002, workdir: '/b', command: 'cmd2', name: 'svc2' });
        expect(getAllProcesses().length).toBe(2);

        removeAllProcesses();
        expect(getAllProcesses().length).toBe(0);
    });

    test('indexes: name and pid indexes exist', () => {
        const indexes = (db as any).db
            .query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='processes'")
            .all() as { name: string }[];
        const names = indexes.map((i: any) => i.name);

        expect(names).toContain('idx_processes_name');
        expect(names).toContain('idx_processes_pid');
    });

    test('change tracking: mutations are recorded', () => {
        const changes = db.getChangesSince(0, 'processes');
        expect(changes.length).toBeGreaterThan(0);
        expect(changes.some((c: any) => c.action === 'INSERT')).toBe(true);
        expect(changes.some((c: any) => c.action === 'DELETE')).toBe(true);
    });

    test('select with fluent builder', () => {
        // Insert fresh data
        insertProcess({ pid: 3001, workdir: '/x', command: 'a', name: 'alpha' });
        insertProcess({ pid: 3002, workdir: '/y', command: 'b', name: 'beta' });
        insertProcess({ pid: 3003, workdir: '/z', command: 'c', name: 'alpha' });

        // Count alphas
        const alphaCount = db.processes.select()
            .where({ name: 'alpha' })
            .count();
        expect(alphaCount).toBe(2);

        // Paginate
        const page = db.processes.select()
            .orderBy('pid', 'asc')
            .limit(2)
            .all();
        expect(page.length).toBe(2);
        expect(page[0]!.pid).toBeLessThan(page[1]!.pid);
    });
});
