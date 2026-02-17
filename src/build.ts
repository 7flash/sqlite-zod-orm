import { EOL } from 'os';

console.log("Building sqlite-zod-orm...");

const result = await Bun.build({
  entrypoints: ['./src/index.ts'],
  outdir: './dist',
  target: 'bun',
  format: 'esm',
  minify: false,
});

if (!result.success) {
  console.error("Build failed:");
  for (const msg of result.logs) {
    console.error(msg);
  }
  process.exit(1);
}

console.log(`Build complete → dist/ (${result.outputs.length} file${result.outputs.length > 1 ? 's' : ''})${EOL}`);
