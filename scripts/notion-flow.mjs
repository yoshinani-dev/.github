#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CASE_SOURCE = '295f5577f583808199e4000bddd068d2';
export const TASK_SOURCE = '19af5577f58380e198a5000bf2053b0e';
export const id = value => String(value).replaceAll('-', '').toLowerCase();
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonical = value => value.replace(/^git@github.com:/, '').replace(/^https:\/\/github.com\//, '').replace(/\.git$/, '').toLowerCase();
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
export function verifyGitHubManagement(pages) {
  if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page))) throw Error('github_inventory_unverified');
  const issues = pages.flat().filter(item => !item.pull_request);
  if (issues.length) throw Error('github_task_management_still_open: ' + issues.map(item => item.number).join(','));
}
const text = parts => (parts || []).map(p => p.plain_text ?? p.text?.content ?? '').join('');
export function property(p) {
  if (!p) return null;
  if (p.type === 'title' || p.type === 'rich_text') return text(p[p.type]);
  if (p.type === 'status' || p.type === 'select') return p[p.type]?.name ?? null;
  if (p.type === 'people') return p.people.map(v => id(v.id)).sort();
  if (p.type === 'relation') return p.relation.map(v => id(v.id)).sort();
  if (p.type === 'date') return p.date ? { start: p.date.start, end: p.date.end ?? null } : null;
  return p[p.type] ?? null;
}
export function verifyTarget(page, caseIds) {
  const source = id(page.parent?.data_source_id || '');
  const allowed = caseIds.map(id);
  if (page.archived || page.in_trash) throw Error('archived_target');
  if (source === CASE_SOURCE && allowed.includes(id(page.id))) return [id(page.id)];
  if (source === TASK_SOURCE && property(page.properties['区分']) === '会社') {
    if (page.properties['IT事業']?.has_more) throw Error('notion_relation_pagination_unverified');
    const related = property(page.properties['IT事業']);
    if (related?.length && related.some(v => allowed.includes(v))) return related.filter(v => allowed.includes(v));
  }
  throw Error('wrong_notion_target_or_unmapped_case');
}
export function verifyProperties(page, expected, allowEvidenceAppend = false) {
  if (!expected || !Object.keys(expected).length) throw Error('expected_fields_required');
  for (const [name, value] of Object.entries(expected)) {
    if (!page.properties[name]) throw Error('missing_notion_field: ' + name);
    const actual = property(page.properties[name]);
    const appended = allowEvidenceAppend && ['証拠メモ', '説明'].includes(name) && typeof value === 'string' && typeof actual === 'string' && actual.startsWith(value);
    if (!appended && JSON.stringify(actual) !== JSON.stringify(value)) throw Error('notion_readback_mismatch: ' + name);
  }
}
export class Notion {
  constructor(token, request = fetch) { if (!token) throw Error('NOTION_API_KEY_required'); this.token = token; this.request = request; }
  async api(path, method = 'GET', body) {
    let response;
    try { response = await this.request('https://api.notion.com/v1/' + path, {
      method, headers: { Authorization: 'Bearer ' + this.token, 'Notion-Version': '2025-09-03', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000),
    }); } catch { throw Error('notion_result_unknown_do_not_resend_with_new_id'); }
    if (!response.ok) throw Error('notion_http_' + response.status);
    return response.json();
  }
  async blocks(page) {
    const rows = []; const seen = new Set(); let cursor;
    do {
      const result = await this.api('blocks/' + page + '/children?page_size=100' + (cursor ? '&start_cursor=' + encodeURIComponent(cursor) : ''));
      if (!Array.isArray(result.results) || typeof result.has_more !== 'boolean' || (result.has_more && !result.next_cursor)) throw Error('notion_pagination_unverified');
      rows.push(...result.results); cursor = result.has_more ? result.next_cursor : null;
      if (cursor && seen.has(cursor)) throw Error('notion_pagination_loop');
      seen.add(cursor);
    } while (cursor);
    return rows;
  }
}
const blockText = block => text(block[block.type]?.rich_text);
export async function confirm(api, storage, input) {
  if (!/^[a-f0-9]{32}$/i.test(input.pageId) || !/^[a-f0-9]{40,64}$/i.test(input.head)) throw Error('invalid_page_or_commit');
  if (!input.note?.trim() || input.note.length > 1000) throw Error('fact_note_required_max_1000');
  const fingerprint = digest({ repo: input.repo, head: input.head, pageId: input.pageId, caseIds: input.caseIds, caseId: input.caseId, expected: input.expected, note: input.note });
  const prior = await storage.get(input.requestId);
  if (prior && prior.fingerprint !== fingerprint) throw Error('request_id_payload_changed');
  const page = await api.api('pages/' + input.pageId);
  const related = verifyTarget(page, input.caseIds); verifyProperties(page, input.expected);
  const evidenceField = id(page.parent.data_source_id) === CASE_SOURCE ? '証拠メモ' : '説明';
  if (typeof input.expected[evidenceField] !== 'string' || !input.expected[evidenceField].includes(input.head)) throw Error('commit_evidence_must_be_saved_in_notion: ' + evidenceField);
  const receiptParent = input.caseId ? id(input.caseId) : related.length === 1 ? related[0] : null;
  if (!receiptParent || !related.includes(receiptParent)) throw Error('explicit_case_selection_required');
  const evidence = 'Notion保存確認 ' + input.requestId + '\n' + input.repo + '\ncommit ' + input.head + '\n' + input.note + '\nコード成果物の記録。push・本番反映・顧客受入の完了は意味しない。';
  const matches = (await api.blocks(receiptParent)).filter(b => blockText(b) === evidence);
  if (matches.length > 1) throw Error('duplicate_notion_receipt');
  let block = matches[0];
  if (!block && prior?.status === 'intent') throw Error('previous_write_unknown_reconcile_same_request');
  if (!block && prior?.status === 'confirmed') throw Error('notion_receipt_missing');
  if (!block) {
    await storage.put(input.requestId, { ...input, fingerprint, status: 'intent' });
    let result;
    try { result = await api.api('blocks/' + receiptParent + '/children', 'PATCH', { children: [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: evidence } }] } }] }); }
    catch (error) {
      if (/^notion_http_4\d\d$/.test(error.message)) await storage.put(input.requestId, { ...input, fingerprint, status: 'rejected' });
      throw error;
    }
    block = result.results?.[0];
    if (!block?.id) throw Error('notion_result_unknown_do_not_resend_with_new_id');
  }
  const readback = await api.api('blocks/' + block.id);
  if (blockText(readback) !== evidence) throw Error('notion_receipt_readback_mismatch');
  const after = await api.api('pages/' + input.pageId);
  verifyTarget(after, input.caseIds); verifyProperties(after, input.expected);
  const receipt = { ...input, fingerprint, blockId: block.id, evidence, status: 'confirmed', verifiedAt: new Date().toISOString() };
  await storage.put(input.requestId, receipt); await storage.receipt(input.head, receipt);
  return receipt;
}
export async function verify(api, receipt, repo, head) {
  if (!receipt || receipt.status !== 'confirmed' || receipt.repo !== repo || receipt.head !== head) throw Error('notion_receipt_required_for_this_commit');
  const page = await api.api('pages/' + receipt.pageId);
  verifyTarget(page, receipt.caseIds); verifyProperties(page, receipt.expected, true);
  if (blockText(await api.api('blocks/' + receipt.blockId)) !== receipt.evidence) throw Error('notion_receipt_changed_or_missing');
  return true;
}
async function file(path) { try { return JSON.parse(await readFile(path, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
async function save(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 }); await rename(temporary, path);
}
async function main() {
  const args = process.argv.slice(2), command = args.shift();
  const opt = name => { const n = args.indexOf('--' + name); return n < 0 ? undefined : args[n + 1]; };
  const cwd = resolve(opt('repo') || process.cwd());
  const repo = canonical(git(cwd, 'remote', 'get-url', 'origin'));
  const config = await file(resolve(dirname(fileURLToPath(import.meta.url)), '../notion-sources.json'));
  const target = config?.repositories?.[repo]; if (!target) throw Error('repository_notion_mapping_required: ' + repo);
  const caseIds = target.case_urls.map(url => url.match(/[a-f0-9]{32}/i)?.[0]);
  if (caseIds.some(v => !v)) throw Error('invalid_case_url');
  const directory = resolve(cwd, git(cwd, 'rev-parse', '--git-common-dir'), 'notion-flow');
  const storage = {
    get: key => file(join(directory, 'operations', key + '.json')),
    put: (key, value) => save(join(directory, 'operations', key + '.json'), value),
    receipt: (head, value) => save(join(directory, 'receipts', head + '.json'), value),
  };
  const api = new Notion(process.env.NOTION_API_KEY);
  if (command === 'confirm') {
    const requestId = opt('request-id'); if (!/^[a-f0-9-]{36}$/i.test(requestId || '')) throw Error('stable_uuid_request_id_required');
    if (!opt('expected-file') || !opt('page') || !opt('note')) throw Error('page_expected_file_and_fact_note_required');
    const head = opt('head') || git(cwd, 'rev-parse', 'HEAD');
    if (!/^[a-f0-9]{40,64}$/i.test(head)) throw Error('invalid_commit');
    try { git(cwd, 'cat-file', '-e', head + '^{commit}'); }
    catch {
      const commit = JSON.parse(execFileSync('gh', ['api', 'repos/' + repo + '/git/commits/' + head], { cwd, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }));
      if (commit.sha !== head) throw Error('github_commit_unverified');
    }
    const result = await confirm(api, storage, { repo, head, pageId: id(opt('page')), caseIds, caseId: opt('case'), expected: await file(resolve(opt('expected-file'))), note: opt('note'), requestId });
    console.log(JSON.stringify({ ok: true, requestId, head, notion: 'https://app.notion.com/p/' + result.pageId }));
  } else if (command === 'verify') {
    const heads = new Set([opt('head') || git(cwd, 'rev-parse', 'HEAD')]);
    if (args.includes('--pre-push')) {
      heads.clear(); let input = ''; for await (const chunk of process.stdin) input += chunk;
      for (const line of input.trim().split('\n')) { const sha = line.split(/\s+/)[1]; if (sha && !/^0+$/.test(sha)) heads.add(sha); }
    }
    for (const head of heads) await verify(api, await file(join(directory, 'receipts', head + '.json')), repo, head);
    const entries = await readdir(join(directory, 'operations')).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
    for (const entry of entries) if (entry.endsWith('.json') && (await storage.get(entry.slice(0, -5)))?.status !== 'confirmed') throw Error('unresolved_notion_operation: ' + entry);
    const github = execFileSync('gh', ['api', '--paginate', '--slurp', 'repos/' + repo + '/issues?state=open&per_page=100'], { cwd, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] });
    verifyGitHubManagement(JSON.parse(github));
    if (target.legacy_project_ids?.length) {
      const query = 'query{' + target.legacy_project_ids.map((project, i) => 'p' + i + ':node(id:' + JSON.stringify(project) + '){...on ProjectV2{closed readme workflows(first:100){pageInfo{hasNextPage} nodes{enabled}}}}').join(' ') + '}';
      const response = JSON.parse(execFileSync('gh', ['api', 'graphql', '-f', 'query=' + query], { cwd, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }));
      if (response.errors || !response.data || Object.keys(response.data).length !== target.legacy_project_ids.length) throw Error('github_projects_unverified');
      for (const p of Object.values(response.data)) if (!p?.closed || p.workflows.pageInfo.hasNextPage || p.workflows.nodes.some(w => w.enabled) || !target.case_urls.some(url => (p.readme || '').includes(url.match(/[a-f0-9]{32}/i)?.[0]))) throw Error('github_project_management_reenabled_or_unmapped');
    }
    console.log('Notionの保存・再取得照合を確認しました。');
  } else throw Error('usage: confirm --page ID --expected-file JSON --note FACT --request-id UUID | verify [--pre-push]');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error('Notion保存確認を完了できません: ' + error.message); process.exitCode = 1; });
