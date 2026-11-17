#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
const [legacy, ...remoteArgs] = process.argv.slice(2);
let input = ''; for await (const chunk of process.stdin) input += chunk;
if (legacy) {
  const hook = resolve(process.cwd(), legacy);
  let executable = false;
  try { await access(hook, constants.X_OK); executable = true; } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'EACCES') throw error; }
  if (executable) {
    const result = spawnSync(hook, remoteArgs, { input, encoding: 'utf8', stdio: ['pipe', 'inherit', 'inherit'] });
    if (result.error || result.status !== 0) process.exit(result.status || 1);
  }
}
const runtime = dirname(fileURLToPath(import.meta.url));
const envFile = join(homedir(), 'Development/yoshinani/jarvis/web/.env');
const result = spawnSync(process.execPath, ['--env-file-if-exists=' + envFile, resolve(runtime, 'notion-flow.mjs'), 'verify', '--pre-push'], { input, encoding: 'utf8', stdio: ['pipe', 'inherit', 'inherit'] });
process.exit(result.error ? 1 : result.status ?? 1);
