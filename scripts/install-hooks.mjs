#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
const cwd = resolve(process.argv[2] || process.cwd());
const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
const common = resolve(cwd, git('rev-parse','--git-common-dir'));
const directory = join(common, 'notion-flow'), hookDirectory = join(directory, 'hooks');
const metadataPath = join(directory, 'installation.json');
let prior; try { prior = JSON.parse(await readFile(metadataPath,'utf8')); } catch (e) { if(e.code!=='ENOENT')throw e; }
let current = null; try { current = git('config','--get','core.hooksPath'); } catch { /* default hooks */ }
const previous = current === hookDirectory ? prior?.previous ?? null : current;
if (current === hookDirectory && !prior) throw Error('installation_metadata_missing');
const previousPath = previous?.startsWith('~/') ? join(homedir(),previous.slice(2)) : previous;
const legacy = previousPath ? join(previousPath,'pre-push') : join(common,'hooks','pre-push');
const runtime = resolve(dirname(fileURLToPath(import.meta.url)), 'pre-push.mjs');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
await mkdir(hookDirectory,{recursive:true,mode:0o700});
await writeFile(join(hookDirectory,'pre-push'), '#!/bin/sh\nexec node '+quote(runtime)+' '+quote(legacy)+' "$@"\n', {mode:0o755});
await writeFile(metadataPath,JSON.stringify({previous,legacy,runtime},null,2),{mode:0o600});
git('config','--local','core.hooksPath',hookDirectory);
console.log(JSON.stringify({repository:cwd,installed:true,originalHookPreserved:legacy}));
