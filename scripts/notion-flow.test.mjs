import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confirm, verify, verifyGitHubManagement, Notion, CASE_SOURCE, TASK_SOURCE } from './notion-flow.mjs';

function fixture() {
  const pageId = '1'.repeat(32), head = 'a'.repeat(40), operations = new Map(), receipts = new Map(), blocks = [];
  const memo = 'GitHubで確認済み ' + head;
  const page = { id: pageId, parent: { data_source_id: CASE_SOURCE }, properties: { '証拠メモ': { type: 'rich_text', rich_text: [{ plain_text: memo }] } } };
  let writes = 0, loseResponse = false, reject = false;
  const api = { blocks: async () => structuredClone(blocks), api: async (path, method, body) => {
    if (path.startsWith('pages/')) return structuredClone(page);
    if (method === 'PATCH') {
      if (reject) throw Error('notion_http_403');
      writes++; const block = { ...body.children[0], id: 'block-1' }; blocks.push(block);
      if (loseResponse) throw Error('notion_result_unknown_do_not_resend_with_new_id');
      return { results: [structuredClone(block)] };
    }
    return structuredClone(blocks.find(b => 'blocks/' + b.id === path));
  } };
  const storage = { get: async key => operations.get(key), put: async (key, value) => operations.set(key, structuredClone(value)), receipt: async (key, value) => receipts.set(key, structuredClone(value)) };
  return { page, api, storage, receipts, operations, blocks, writes: () => writes, lose: value => loseResponse = value, reject: value => reject = value,
    input: { repo: 'example/service', head, pageId, caseIds: [pageId], requestId: '11111111-1111-4111-8111-111111111111', expected: { '証拠メモ': memo }, note: '一次情報の保存を確認' } };
}
test('readback is required before a commit receipt becomes valid; replay does not append twice', async () => {
  const f = fixture(); await confirm(f.api, f.storage, f.input); await confirm(f.api, f.storage, f.input);
  assert.equal(f.writes(), 1); assert.equal(await verify(f.api, f.receipts.get(f.input.head), f.input.repo, f.input.head), true);
});
test('an uncertain append is reconciled using the same request and existing Notion block', async () => {
  const f = fixture(); f.lose(true); await assert.rejects(confirm(f.api, f.storage, f.input), /unknown/);
  assert.equal(f.receipts.size, 0); f.lose(false); await confirm(f.api, f.storage, f.input); assert.equal(f.writes(), 1);
});
test('an uncertain write with no matching block cannot be resent or reported as confirmed', async () => {
  const f = fixture(); f.lose(true); await assert.rejects(confirm(f.api, f.storage, f.input)); f.blocks.length = 0;
  await assert.rejects(confirm(f.api, f.storage, f.input), /previous_write_unknown/); assert.equal(f.writes(), 1); assert.equal(f.receipts.size, 0);
});
test('explicit rejection can be retried with the same request without creating duplicates', async () => {
  const f = fixture(); f.reject(true); await assert.rejects(confirm(f.api, f.storage, f.input), /403/); f.reject(false);
  await confirm(f.api, f.storage, f.input); assert.equal(f.writes(), 1);
});
test('a lost local journal cannot reuse a server-side request ID with different content', async () => {
  const f=fixture();await confirm(f.api,f.storage,f.input);f.operations.clear();
  await assert.rejects(confirm(f.api,f.storage,{...f.input,note:'different'}),/payload_changed_in_notion/);assert.equal(f.writes(),1);
});
test('changed payload, changed Notion fields, a new commit, or missing evidence blocks completion', async () => {
  const f = fixture(); await confirm(f.api, f.storage, f.input); const receipt = f.receipts.get(f.input.head);
  await assert.rejects(confirm(f.api, f.storage, { ...f.input, note: 'different' }), /payload_changed/);
  await assert.rejects(verify(f.api, receipt, f.input.repo, 'b'.repeat(40)), /receipt_required/);
  f.page.properties['証拠メモ'].rich_text[0].plain_text = 'changed'; await assert.rejects(verify(f.api, receipt, f.input.repo, f.input.head), /readback_mismatch/);
  f.page.properties['証拠メモ'].rich_text[0].plain_text = f.input.expected['証拠メモ']; f.blocks[0].paragraph.rich_text[0].text.content = 'changed';
  await assert.rejects(verify(f.api, receipt, f.input.repo, f.input.head), /receipt_changed/);
});
test('legacy sources, other cases, personal tasks, and archived pages are rejected', async () => {
  for (const change of [p => p.parent.data_source_id = '9'.repeat(32), p => p.id = '2'.repeat(32), p => { p.parent.data_source_id = TASK_SOURCE; p.properties['区分'] = { type: 'select', select: { name: '個人' } }; }, p => p.archived = true]) {
    const f = fixture(); change(f.page); await assert.rejects(confirm(f.api, f.storage, f.input)); assert.equal(f.writes(), 0);
  }
});
test('Notion unavailability never confirms or retries a write automatically', async () => {
  let calls = 0; const api = new Notion('private-test-value', async () => { calls++; throw Error('offline'); });
  await assert.rejects(api.api('pages/example', 'PATCH', {}), /unknown/); assert.equal(calls, 1);
});
test('GitHub task management cannot silently reappear and all issue pages are considered', () => {
  assert.doesNotThrow(() => verifyGitHubManagement([[{ number: 1, pull_request: {} }], []]));
  assert.throws(() => verifyGitHubManagement([[{ number: 1, pull_request: {} }], [{ number: 99 }]]), /still_open: 99/);
  assert.throws(() => verifyGitHubManagement(null), /unverified/);
});
test('Notion receipt lookup consumes every page and fails on a missing or repeated cursor', async () => {
  const requests = [];
  const api = new Notion('test', async url => {
    requests.push(url);
    return new Response(JSON.stringify(url.includes('start_cursor=next') ? { results: [{ id: 'last' }], has_more: false, next_cursor: null } : { results: [{ id: 'first' }], has_more: true, next_cursor: 'next' }));
  });
  assert.deepEqual((await api.blocks('page')).map(b => b.id), ['first','last']); assert.equal(requests.length, 2);
  const missing = new Notion('test', async () => new Response(JSON.stringify({ results: [], has_more: true, next_cursor: null })));
  await assert.rejects(missing.blocks('page'), /pagination_unverified/);
  const cycle = new Notion('test', async () => new Response(JSON.stringify({ results: [], has_more: true, next_cursor: 'same' })));
  await assert.rejects(cycle.blocks('page'), /pagination_loop/);
});
