/**
 * process-manager.ts — SatiDB example: process management database
 *
 * Demonstrates a real-world pattern replacing raw findMany/findOne/find
 * calls with the fluent select() query builder.
 */

import { SatiDB, z } from '../src/satidb';

// ── Schema ───────────────────────────────────────────────────────

const ProcessSchema = z.object({
    pid: z.number(),
    workdir: z.string(),
    command: z.string(),
    name: z.string(),
    env: z.string().optional(),
    configPath: z.string().optional(),
    stdoutPath: z.string().optional(),
    stderrPath: z.string().optional(),
    timestamp: z.string().optional(),   // ISO 8601
});

// ── Database ─────────────────────────────────────────────────────

export function createProcessDb(dbPath: string) {
    const db = new SatiDB(dbPath, {
        processes: ProcessSchema,
    }, {
        changeTracking: true,
        indexes: {
            processes: ['name', 'pid'],
        },
    });

    // --- Query Functions ---

    function getProcess(name: string) {
        return db.processes.select()
            .where({ name })
            .orderBy('id', 'desc')
            .limit(1)
            .get();
    }

    function getAllProcesses() {
        return db.processes.select().all();
    }

    function getProcessByPid(pid: number) {
        return db.processes.select().where({ pid }).get();
    }

    // --- Mutation Functions ---

    function insertProcess(data: {
        pid: number;
        workdir: string;
        command: string;
        name: string;
        env?: string;
        configPath?: string;
        stdoutPath?: string;
        stderrPath?: string;
    }) {
        return db.processes.insert({
            ...data,
            timestamp: new Date().toISOString(),
        });
    }

    function removeProcess(pid: number) {
        const p = db.processes.select().where({ pid }).get();
        if (p) {
            db.processes.delete(p.id);
        }
    }

    function removeProcessByName(name: string) {
        const procs = db.processes.select().where({ name }).all();
        for (const p of procs) {
            db.processes.delete(p.id);
        }
    }

    function removeAllProcesses() {
        const all = db.processes.select().all();
        for (const p of all) {
            db.processes.delete(p.id);
        }
    }

    // --- Utilities ---

    async function retryDatabaseOperation<T>(
        operation: () => T,
        maxRetries = 5,
        delay = 100,
    ): Promise<T> {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return operation();
            } catch (err: any) {
                if (err?.code === 'SQLITE_BUSY' && attempt < maxRetries) {
                    await Bun.sleep(delay * attempt);
                    continue;
                }
                throw err;
            }
        }
        throw new Error('Max retries reached for database operation');
    }

    return {
        db,
        getProcess,
        getAllProcesses,
        getProcessByPid,
        insertProcess,
        removeProcess,
        removeProcessByName,
        removeAllProcesses,
        retryDatabaseOperation,
    };
}
