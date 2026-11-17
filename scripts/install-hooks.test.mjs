import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { withOperationLock } from './notion-flow.mjs';
test('install keeps the original hook and its stdin, and safely follows a later hooksPath change', async () => {
  const root=await mkdtemp(join(tmpdir(),'notion-hook-test-'));
  const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  try {
    git('init');await mkdir(join(root,'prior hooks'));
    const path=join(root,'prior hooks/pre-push'), capture=join(root,'captured.json');
    // A node hook receives the exact input and exits before the Notion network gate.
    const program='#!/usr/bin/env node\n(async()=>{let input="";for await(const c of process.stdin)input+=c;require("node:fs").writeFileSync('+JSON.stringify(capture)+',JSON.stringify({input,args:process.argv.slice(2)}));process.exit(42);})()';
    await writeFile(path,program,{mode:0o755});git('config','core.hooksPath','prior hooks');
    const install=resolve('scripts/install-hooks.mjs');
    execFileSync(process.execPath,[install,root],{cwd:root});
    const hooks=git('config','--get','core.hooksPath');
    execFileSync(process.execPath,[install,root],{cwd:root});assert.equal(git('config','--get','core.hooksPath'),hooks);
    assert.equal(await readFile(path,'utf8'),program);
    const input='refs/heads/task '+ 'a'.repeat(40)+' refs/heads/task '+ 'b'.repeat(40)+'\n';
    const run=spawnSync(join(hooks,'pre-push'),['origin','git@example.test:service'],{cwd:root,input,encoding:'utf8'});
    assert.equal(run.status,42);assert.deepEqual(JSON.parse(await readFile(capture,'utf8')),{input,args:['origin','git@example.test:service']});
    git('config','core.hooksPath','.new-hooks');execFileSync(process.execPath,[install,root],{cwd:root});
    const meta=JSON.parse(await readFile(join(root,'.git/notion-flow/installation.json'),'utf8'));
    assert.equal(meta.previous,'.new-hooks');assert.equal(meta.legacy,'.new-hooks/pre-push');assert.equal(await readFile(path,'utf8'),program);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('simultaneous retries cannot append twice and a completed request releases its lock', async () => {
  const root=await mkdtemp(join(tmpdir(),'notion-request-lock-'));let release,entered;
  const started=new Promise(resolve=>entered=resolve);
  try {
    const first=withOperationLock(root,'request',async()=>{entered();await new Promise(resolve=>release=resolve);return 'confirmed';});
    await started;
    await assert.rejects(withOperationLock(root,'request',async()=>assert.fail('duplicate write')),/same_request_in_progress/);
    release();assert.equal(await first,'confirmed');assert.equal(await withOperationLock(root,'request',async()=> 'replayed'),'replayed');
  } finally { await rm(root,{recursive:true,force:true}); }
});
