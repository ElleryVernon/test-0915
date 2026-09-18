import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const args = process.argv.slice(2);
// The evaluator links product code directly, has no database path, and saves only local evidence.
const binary = process.env.MEMORYZ_EVAL_BINARY;
const result = spawnSync(binary ? resolve(binary) : 'go', binary ? args : ['run', './cmd/learning-eval', ...args], {
  cwd: resolve('server'), env: process.env, stdio: 'inherit',
});
if (result.error) { console.error(result.error.message); process.exit(2); }
process.exit(result.status ?? 2);
