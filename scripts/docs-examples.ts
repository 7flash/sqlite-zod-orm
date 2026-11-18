/**
 * Run every ```ts/```typescript block in README.md and UPGRADING.md.
 *
 * Each block runs in its own Bun process, with its own SQLite working directory.
 * The first database declaration in a README section is used as the setup for
 * later blocks in that section. Sections without one use the documented
 * `docs-examples: default` block. The upgrade guide uses its published migrate
 * helper plus named, disposable legacy SQLite fixtures.
 *
 * `// => JSON` checks the value of the preceding expression/variable.
 * `// => throws /regex/` checks a deliberately rejected expression.
 * `@ts-expect-error` is checked by tsc, not erased or ignored.
 *
 * Usage: bun scripts/docs-examples.ts [--ci]
 * No downloaded packages or snapshot/test-only mocks are needed.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

const root = resolve(import.meta.dir, '..');
type Example = { file: string; line: number; end: number; section: string; code: string; setup?: string; fixture?: string; use?: string; isDefault: boolean };
const legacyFixtures: Record<string, string> = {
    'age-text': `CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, age TEXT);
INSERT INTO users VALUES (1,'Alice','35');`,
    'full-name': `CREATE TABLE users (id INTEGER PRIMARY KEY, full_name TEXT);
INSERT INTO users VALUES (1,'Alice Smith');`,
    'name-column': `CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT); -- as the ORM creates it
INSERT INTO users VALUES (1,'Alice Smith');`,
    'users-basic': `CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);
INSERT INTO users VALUES (1,'Alice');`,
    'grants-fk': `CREATE TABLE agents (id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE grants (id INTEGER PRIMARY KEY, authorRef INTEGER REFERENCES agents(id));
INSERT INTO agents VALUES (1,'Alice');
INSERT INTO grants VALUES (1,1);`,
    'users-email': `CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT UNIQUE);
INSERT INTO users VALUES (1,'a@example.org');`,
    'trigger-columns': `CREATE TABLE users (id INTEGER PRIMARY KEY, displayName TEXT);
CREATE TABLE posts (id INTEGER PRIMARY KEY, authorName TEXT, authorRef INTEGER REFERENCES users(id));
INSERT INTO users VALUES (1,'Alice');
INSERT INTO posts VALUES (1,'Alice',1);`,
    'users-region': `CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);
INSERT INTO users VALUES (1,'Alice');`,
    'json-users': `CREATE TABLE users (id INTEGER PRIMARY KEY, data TEXT, name TEXT);
INSERT INTO users VALUES (1,'{"name":"Alice"}','Alice');`,
};

function extract(file: string): Example[] {
    const lines = readFileSync(join(root, file), 'utf8').split(/\r?\n/);
    const result: Example[] = [];
    let section = '(introduction)';
    let inherit: string | undefined;
    for (let i = 0; i < lines.length; i++) {
        const heading = /^## (.+)/.exec(lines[i]!);
        if (heading) { section = heading[1]!; inherit = undefined; }
        const use = /<!-- docs-examples: use ([\w-]+) -->/.exec(lines[i]!);
        if (use) inherit = use[1];
        if (!/^```(?:typescript|ts)\s*$/.test(lines[i]!)) continue;
        const start = i + 1;
        let end = start;
        while (end < lines.length && !/^```\s*$/.test(lines[end]!)) end++;
        if (end === lines.length) throw new Error(`${file}:${start}: unclosed code fence`);
        const code = lines.slice(start, end).join('\n');
        const fixture = /^\s*\/\/ docs-examples: fixture ([\w-]+)/m.exec(code)?.[1];
        const setup = /^\s*\/\/ docs-examples: setup ([\w-]+)/m.exec(code)?.[1];
        const isDefault = /^\s*\/\/ docs-examples: default\s*$/m.test(code);
        result.push({ file, line: start + 1, end, section, code, fixture, setup, use: inherit, isDefault });
        i = end;
    }
    return result;
}

function isolated(example: Example, all: Example[]): { prefix: string; name: string } {
    if (example.file === 'UPGRADING.md') {
        // The guide's first block defines migrate() and inspect(). Its schema
        // examples are alternatives, never additive migrations in one DB.
        const helper = all.find(e => e.file === 'UPGRADING.md');
        if (!helper) throw new Error('UPGRADING helper missing');
        const linked = example.use ? all.find(e => e.setup === example.use) : undefined;
        if (example.use && !linked) throw new Error(`${example.file}:${example.line}: missing shared setup ${example.use}`);
        const prefix = [helper === example ? '' : helper.code, linked?.code ?? ''].filter(Boolean).join('\n\n');
        return { prefix, name: 'upgrading' };
    }
    if (example.isDefault) return { prefix: '', name: 'shared' };
    const defaultBlock = all.find(e => e.file === 'README.md' && e.isDefault);
    if (!defaultBlock) throw new Error('README default fixture missing');
    const sectionExamples = all.filter(e => e.file === example.file && e.section === example.section);
    const first = sectionExamples[0];
    // A section's first block is its schema when it declares a Database.
    // A block containing a constructor is standalone, even if it is later
    // in the section (e.g. a separate configuration).
    const ownDatabase = /\b(?:const|let)\s+db\s*=\s*new Database\s*\(/.test(example.code);
    if (first && first !== example && /\b(?:const|let)\s+db\s*=\s*new Database\s*\(/.test(first.code)) {
        return { prefix: ownDatabase ? '' : first.code, name: sectionExamples[0]!.section };
    }
    if (ownDatabase || /\bimport\s+(?:type\s+)?[\s\S]*?from\s+['"]sqlite-zod-orm['"]/.test(example.code)) {
        return { prefix: '', name: example.section };
    }
    return { prefix: defaultBlock.code, name: 'shared' };
}

function assertions(source: string, file: string, baseLine: number): string {
    return source.split('\n').map((line, offset) => {
        const m = /^(\s*)(.+?);\s*\/\/\s*=>\s*(.*?)\s*$/.exec(line);
        if (!m) {
            if (line.includes('// =>')) throw new Error(`${file}:${baseLine + offset}: use a single-line expression ending in ; before // =>`);
            return line;
        }
        const [, indent, statement, expected] = m;
        const label = JSON.stringify(`${file}:${baseLine + offset}`);
        const throwing = /^throws\s+\/(.*)\/([gimsuy]*)$/.exec(expected!);
        if (throwing) return `${indent}__docsThrows(() => (${statement!.trim()}), new RegExp(${JSON.stringify(throwing[1])}, ${JSON.stringify(throwing[2])}), ${label});`;
        let value: unknown;
        try { value = JSON.parse(expected!); }
        catch { throw new Error(`${file}:${baseLine + offset}: // => must contain valid JSON or throws /regex/: ${expected}`); }
        const variable = /^(?:const|let|var)\s+([\w$]+)\s*=/.exec(statement!.trim());
        if (variable) return `${indent}${statement};\n${indent}__docsAssert(${variable[1]}, ${JSON.stringify(value)}, ${label});`;
        // Evaluated exactly once: do not duplicate inserts, deletes, etc.
        return `${indent}__docsAssert((${statement!.trim()}), ${JSON.stringify(value)}, ${label});`;
    }).join('\n');
}

function importPath(source: string): string {
    // The npm package exports dist/, which does not exist in a source archive.
    // Type-check/runtime both use the *real* local library source instead.
    return source.replace(/(from\s+['"])sqlite-zod-orm(['"])/g, '$1../src/index.ts$2');
}

const assertHelpers = `import { isDeepStrictEqual as __docsEqual } from 'node:util';
function __docsAssert(actual: unknown, expected: unknown, location: string): void {
    if (!__docsEqual(actual, expected)) {
        throw new Error(location + ': expected ' + JSON.stringify(expected) + ', got ' + String(typeof actual === 'bigint' ? actual : JSON.stringify(actual)));
    }
}
function __docsThrows(callback: () => unknown, pattern: RegExp, location: string): void {
    let caught: unknown;
    try { callback(); } catch (error) { caught = error; }
    if (!(caught instanceof Error) || !pattern.test(caught.message)) {
        throw new Error(location + ': expected error matching ' + pattern + ', got ' + String(caught));
    }
}`;

function makeProgram(example: Example, all: Example[]): string {
    const { prefix } = isolated(example, all);
    if (example.fixture && !Object.hasOwn(legacyFixtures, example.fixture))
        throw new Error(`${example.file}:${example.line}: unknown fixture ${example.fixture}`);
    const fixture = example.fixture ? `{
 const __sqlite = new SQLite('app.db');
 try { __sqlite.exec(${JSON.stringify(legacyFixtures[example.fixture])}); }
 finally { __sqlite.close(); }
}` : '';
    // Setup blocks have already been independently checked at their own
    // source locations. Reuse their statements, not duplicate result checks.
    const body = [prefix, fixture, assertions(example.code, example.file, example.line)].filter(Boolean).join('\n\n');
    // All guide examples inherit the import in the first helper block.
    // README fragments inherit their section's or default block's imports;
    // standalone Relationship/Cascade/Views examples have no import statement.
    const hasImports = /from\s+['"]sqlite-zod-orm['"]/.test(prefix + '\n' + example.code);
    const autoImport = hasImports ? '' : `import { Database, z, defineView, op } from '../src/index.ts';`;
    return [autoImport, assertHelpers, importPath(body)].filter(Boolean).join('\n\n') + '\n';
}

function check(): number {
    const all = [...extract('README.md'), ...extract('UPGRADING.md')];
    const temp = mkdtempSync(join(root, '.docs-examples-'));
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'sqlite-zod-orm-docs-'));
    const filenames: string[] = [];
    const generationErrors = new Map<number, string>();
    try {
        for (const [i, example] of all.entries()) {
            const file = join(temp, `example-${String(i + 1).padStart(3, '0')}.ts`);
            filenames.push(file);
            try { writeFileSync(file, makeProgram(example, all)); }
            catch (error) { generationErrors.set(i, String(error)); writeFileSync(file, 'export {};\n'); }
        }
        writeFileSync(join(temp, 'tsconfig.json'), JSON.stringify({
            extends: '../tsconfig.json',
            compilerOptions: { noEmit: true, allowImportingTsExtensions: true },
            files: filenames.map(file => `./${file.split(sep).pop()}`),
        }, null, 2));
        // Check *all* programs in one TypeScript invocation. Includes negative
        // examples marked @ts-expect-error: an unused expectation fails tsc.
        const compiler = spawnSync('bunx', ['tsc', '--noEmit', '--project', join(temp, 'tsconfig.json')], {
            cwd: root, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
        });
        const compileOutput = `${compiler.stdout ?? ''}\n${compiler.stderr ?? ''}`.trim();
        const compilationIssues = new Map<number, string[]>();
        const generalIssues: string[] = [];
        if (compiler.error) generalIssues.push(String(compiler.error));
        if (compiler.status !== 0) {
            for (const line of compileOutput.split(/\r?\n/).filter(Boolean)) {
                const m = /example-(\d+)\.ts(?:\(\d+,\d+\))?/.exec(line);
                const i = m ? Number(m[1]) - 1 : -1;
                if (i >= 0 && i < all.length) compilationIssues.set(i, [...compilationIssues.get(i) ?? [], line]);
                else generalIssues.push(line);
            }
            if (!compileOutput && !compiler.error) generalIssues.push('tsc exited ' + compiler.status);
        }
        let failures = 0;
        for (const [i, example] of all.entries()) {
            const errors = [...(generationErrors.has(i) ? [generationErrors.get(i)!] : []), ...(compilationIssues.get(i) ?? [])];
            if (!generationErrors.has(i) && !compilationIssues.has(i) && generalIssues.length === 0) {
                const cwd = join(runtimeRoot, `example-${i + 1}`);
                mkdirSync(cwd, { recursive: true });
                const runtime = spawnSync('bun', ['run', filenames[i]!], {
                    cwd, encoding: 'utf8', maxBuffer: 5 * 1024 * 1024,
                });
                if (runtime.error || runtime.status !== 0) errors.push((runtime.stderr || runtime.stdout || String(runtime.error) || `exit ${runtime.status}`).trim());
            } else if (generalIssues.length) errors.push(...generalIssues);
            const location = `${example.file}:${example.line}`;
            if (errors.length) {
                failures++;
                console.error(`FAIL ${location} (${example.section})\n  ${errors.join('\n  ')}`);
            } else console.log(`PASS ${location} (${example.section})`);
        }
        console.log(`\nDocs examples: ${all.length - failures}/${all.length} passed`);
        return failures ? 1 : 0;
    } finally {
        rmSync(temp, { recursive: true, force: true });
        rmSync(runtimeRoot, { recursive: true, force: true });
    }
}

if (import.meta.main) process.exitCode = check();
