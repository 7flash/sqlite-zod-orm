/**
 * `sqlite-zod-orm upgrade-check <dir>`: find code that the 3.x -> 4.0
 * changes in UPGRADING.md affect. It reads source text only (no type
 * information), so each rule targets a pattern that is reliable in text;
 * "review" findings point at code to check by hand, "error" findings are
 * code that 4.0 rejects.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export type Severity = "error" | "review";

export interface Finding {
  file: string;
  line: number;
  section: number;
  severity: Severity;
  message: string;
  code: string;
}

interface Rule {
  section: number;
  severity: Severity;
  /** Matched against the statement starting at a line (that line plus following chained lines). */
  pattern: RegExp;
  message: string;
}

const RULES: Rule[] = [
  {
    section: 12,
    severity: "error",
    pattern: /\bbefore(?:Insert|Update|Delete)\s*:\s*async\b|\basync\s+before(?:Insert|Update|Delete)\s*\(/,
    message: "async before-hook: 4.0 throws; make it synchronous or move the async work to an after-hook",
  },
  {
    section: 13,
    severity: "error",
    pattern: /\.transaction\(\s*async\b/,
    message: "async transaction callback: 4.0 throws; do async work first, then write in a synchronous callback",
  },
  {
    section: 11,
    severity: "error",
    pattern: /\.where\(\s*\{\s*(?:"[^"]*[\s(),][^"]*"|'[^']*[\s(),][^']*'|`[^`]*[\s(),][^`]*`)\s*:/,
    message: "where() key looks like a SQL expression; 4.0 quotes keys as column names. Use whereRaw(sql, params)",
  },
  {
    section: 11,
    severity: "error",
    pattern: /\.orderBy\([^)]*,\s*["'`](?!asc["'`]|desc["'`])[^"'`]*["'`]/i,
    message: "orderBy() direction other than asc/desc is rejected in 4.0",
  },
  {
    section: 14,
    severity: "review",
    pattern: /\.where\(\s*\{[\s\S]*?\.where\(\s*\(|\.where\(\s*\([\s\S]*?\.where\(\s*\{/,
    message: "callback where() and object where() on one query: 4.0 applies both (3.x dropped the object filter)",
  },
  {
    section: 18,
    severity: "error",
    pattern: /\.groupBy\([\s\S]*?\.(?:sum|avg|min|max)\(/,
    message: "sum/avg/min/max after groupBy() throw in 4.0; use countGrouped() or a per-group SQL aggregate",
  },
  {
    section: 18,
    severity: "review",
    pattern: /\.groupBy\([\s\S]*?\.count\(\s*\)/,
    message: "count() after groupBy() returns the number of groups in 4.0 (it returned the first group's count)",
  },
  {
    section: 16,
    severity: "review",
    pattern: /\bdb\w*\.(?:seed|load)\(|\.(?:seed|load)\(\s*\{\s*\w+\s*:\s*\[/,
    message: "load()/seed() keep ids, validate rows and reject unknown tables/columns in 4.0; check the fixtures",
  },
  {
    section: 17,
    severity: "review",
    pattern: /\b\w+\.\w+\.restore\(\s*[\w.]+\s*\)/,
    message: "restore() also restores the cascade deleted with the row and refuses orphans in 4.0",
  },
  {
    section: 15,
    severity: "review",
    pattern: /\bcascade\s*:\s*\{/,
    message: "cascade now follows every level and rolls back on a child veto; unknown tables or missing relations fail at startup (sections 15, 20)",
  },
  {
    section: 19,
    severity: "review",
    pattern: /\bz\.bigint\(\)/,
    message: "z.bigint() columns now read back as bigint (they were strings)",
  },
  {
    section: 14,
    severity: "review",
    pattern: /\bsoftDeletes\s*:\s*true\b/,
    message: "with softDeletes, get(), joins, .with() and relation accessors no longer return deleted rows",
  },
];

const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", "coverage", ".next", ".tradjs"]);

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) yield* sourceFiles(path.join(dir, entry.name));
    } else if (entry.isFile() && SOURCE.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      const file = path.join(dir, entry.name);
      // Bundles and generated files are not hand-written app code.
      if (statSync(file).size <= 1_000_000) yield file;
    }
  }
}

/** The statement starting at line i: that line plus following lines that continue a chain. */
function statementAt(lines: string[], i: number): string {
  let text = lines[i]!;
  for (let j = i + 1; j < lines.length && j < i + 12; j++) {
    const next = lines[j]!.trim();
    if (!next.startsWith(".") && !/[({,]\s*$/.test(lines[j - 1]!.trimEnd())) break;
    text += "\n" + lines[j];
  }
  return text;
}

export function checkSource(file: string, source: string): Finding[] {
  if (!/sqlite-zod-orm/.test(source) && !/\bnew Database\(/.test(source) && !/\bdb\.\w+\./.test(source)) return [];
  const lines = source.split(/\r?\n/);
  const findings: Finding[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*(\/\/|\*)/.test(line)) continue;
    const continuation = line.trim().startsWith(".");
    const statement = statementAt(lines, i);
    for (const rule of RULES) {
      // Rules spanning a chain are checked once, where the statement starts.
      const spansLines = rule.pattern.source.includes(String.raw`[\s\S]`);
      if (spansLines && continuation) continue;
      if (!rule.pattern.test(spansLines ? statement : line)) continue;
      findings.push({ file, line: i + 1, section: rule.section, severity: rule.severity, message: rule.message, code: line.trim().slice(0, 160) });
    }
  }
  return findings;
}

export function upgradeCheck(dir: string): Finding[] {
  const root = path.resolve(dir);
  if (!statSync(root).isDirectory()) throw new Error(`Not a directory: ${dir}`);
  const findings: Finding[] = [];
  for (const file of sourceFiles(root)) {
    findings.push(...checkSource(path.relative(root, file).split(path.sep).join("/"), readFileSync(file, "utf8")));
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

export function formatFindings(findings: Finding[]): string {
  if (findings.length === 0) return "No code affected by the sqlite-zod-orm 4.0 changes was found.";
  const out = findings.map((f) =>
    `${f.file}:${f.line}  [${f.severity}] UPGRADING ${f.section}: ${f.message}\n    ${f.code}`);
  const errors = findings.filter((f) => f.severity === "error").length;
  out.push(`\n${findings.length} finding(s): ${errors} must change, ${findings.length - errors} to review. See UPGRADING.md.`);
  return out.join("\n");
}
