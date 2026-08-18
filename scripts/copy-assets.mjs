// Copies Lua scripts into dist/ so the built package can load them at runtime.
// Run after `tsc` (see package.json "build" script).
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'src/session/scripts');
const dest = resolve(root, 'dist/session/scripts');

mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log(`[copy-assets] Lua scripts copied to ${dest}`);