/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context, PluginHandler, ToolSession } from 'whalelife';
import { setup } from '../src/index.ts';
import type { ExecuteRequest, ExecuteResult } from '../src/executor.ts';
import { temporaryDirectory } from './temporary-directory.ts';

type RecordedTool = { name: string; danger?: string; run(args: unknown, session: ToolSession): Promise<any> };
type FakeExecutor = { probe(): Promise<{ available: boolean; runtimes: string[]; reason?: string }>; execute(request: ExecuteRequest): Promise<ExecuteResult> };
const prefix = '/plugins/computer';
async function fixture(t: TestContext, provided?: FakeExecutor) {
  let server: Server | undefined;
  const controller = new AbortController(), disposals: (() => unknown)[] = [];
  t.after(async () => {
    controller.abort();
    for (const dispose of disposals.reverse()) await dispose();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((done, reject) => server!.close(error => error ? reject(error) : done()));
    }
  });
  const temp = await temporaryDirectory(t), root = join(temp, 'plugin'), hostRoot = join(temp, 'host');
  await Promise.all([mkdir(root), mkdir(hostRoot)]);
  const handlers = new Map<string, PluginHandler>(), tools = new Map<string, RecordedTool>();
  const messages: unknown[] = [], saves: unknown[] = [];
  let stored: unknown, sessionId = 'fixture-session';
  const executor = provided ?? {
    async probe() { return { available: false, runtimes: [], reason: 'fixture: no native execution' }; },
    async execute(): Promise<ExecuteResult> { throw new Error('Unexpected execution in integration fixture'); },
  };
  const ctx = {
    apiVersion: '1.0.0', signal: controller.signal,
    logger: Object.fromEntries(['log', 'debug', 'info', 'warn', 'error'].map(name => [name, (...args: unknown[]) => messages.push(args)])),
    config: {
      async read() { if (stored === undefined) throw Object.assign(new Error('missing fixture config'), { code: 'ENOENT' }); return structuredClone(stored); },
      async save(_name: string, value: unknown) { stored = structuredClone(value); saves.push(structuredClone(value)); },
    },
    tools: {
      registerTransient(tool: RecordedTool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); },
      async call() { return { ok: false, result: 'fixture has no QQ provider' }; },
    },
    sessions: { current: async () => sessionId },
    web: {
      page(path: string, handler: PluginHandler) { handlers.set(path, handler); return () => handlers.delete(path); },
      api(path: string, handler: PluginHandler) { handlers.set(path, handler); return () => handlers.delete(path); },
    },
    effect(start: () => (() => unknown)) { const dispose = start(); disposals.push(dispose); return dispose; },
  } as unknown as Context;
  await setup(ctx, { root, hostRoot, executor });
  // The production host authenticates before invoking these registered handlers. This
  // fixture is an isolated loopback transport to test the plugin's own HTTP contract.
  server = createServer(async (req, res) => {
    const handler = handlers.get(new URL(req.url ?? '/', 'http://fixture').pathname);
    if (!handler) { res.writeHead(404).end(); return; }
    const requestController = new AbortController();
    req.once('aborted', () => requestController.abort());
    try { await handler(req, res, { signal: AbortSignal.any([controller.signal, requestController.signal]) }); }
    catch { if (!res.headersSent) res.writeHead(500).end('uncaught fixture handler error'); else res.destroy(); }
  });
  await new Promise<void>((done, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', done); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing fixture port');
  const base = `http://127.0.0.1:${address.port}`;
  const get = (path: string) => fetch(base + path);
  const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const state = async () => (await get(`${prefix}/api/state`)).json() as Promise<any>;
  const saveGrants = async (grants: Record<string, boolean>) => {
    const before = await state();
    const response = await post(`${prefix}/api/settings`, { revision: before.revision, settings: { ...before.settings, grants: { ...before.settings.grants, ...grants } } });
    assert.equal(response.status, 200);
    return response.json();
  };
  const session = (): ToolSession => ({ id: sessionId, permission: 'full', channel: 'web', account: 'local', origin: { plugin: 'core' }, signal: controller.signal });
  return { root, hostRoot, base, handlers, tools, messages, saves, get, post, state, saveGrants, session,
    setSession(value: string) { sessionId = value; },
    run: (operations: unknown) => tools.get('computer_task')!.run({ operations }, session()),
  };
}

test('fresh installation has no grants and denies file work until settings are explicitly saved', async t => {
  const f = await fixture(t), initial = await f.state();
  assert.equal(initial.revision, 0);
  assert.ok(Object.values(initial.settings.grants).every(value => value === false));
  assert.equal(initial.availability.execute.available, false);
  assert.equal(initial.availability.execute.check, 'files-only');
  assert.deepEqual(initial.availability.execute.runtimes, []);
  assert.equal(f.tools.get('computer_task')?.danger, 'full');
  const rejected = await f.run([{ action: 'write', path: 'blocked.txt', text: 'fixture private body', createOnly: true }]);
  assert.equal(rejected.content.state, 'rejected');
  assert.equal(rejected.receipt.code, 'permission');
  assert.deepEqual(await readdir(join(f.root, 'data', 'workspace')), []);
  const saved = await f.saveGrants({ read: true, write: true });
  assert.equal(saved.revision, 1);
  assert.equal(f.saves.length, 1);
  const accepted = await f.run([{ action: 'write', path: 'allowed.txt', text: 'fixture private body', createOnly: true }]);
  assert.equal(accepted.content.state, 'completed');
  assert.equal(await readFile(join(f.root, 'data', 'workspace', 'allowed.txt'), 'utf8'), 'fixture private body');
  assert.ok(!JSON.stringify(accepted.receipt).includes('fixture private body'));
  assert.ok(!JSON.stringify(f.saves).includes('fixture private body'));
});

test('the Web task endpoint uses the asynchronous current session and the same capability checks', async t => {
  const f = await fixture(t);
  const operation = { operations: [{ action: 'write', path: 'web.txt', text: 'Web fixture body', createOnly: true }] };
  const denied = await f.post(`${prefix}/api/task`, operation);
  assert.equal(denied.status, 403);
  assert.equal((await denied.json() as any).error.code, 'permission');
  await f.saveGrants({ read: true, write: true });
  const response = await f.post(`${prefix}/api/task`, { operations: [...operation.operations, { action: 'deliver', path: 'web.txt' }] });
  assert.equal(response.status, 200);
  const result = await response.json() as any;
  assert.equal(result.state, 'completed');
  assert.equal(await (await f.get(result.steps[1].result.url)).text(), 'Web fixture body');
  f.setSession('different-Web-session');
  assert.equal((await f.get(result.steps[1].result.url)).status, 400);
});

test('settings use revision checks and reject protected workspace selection without mutating it', async t => {
  const f = await fixture(t), before = await f.state();
  await f.saveGrants({ read: true });
  const stale = await f.post(`${prefix}/api/settings`, { revision: before.revision, settings: before.settings });
  assert.equal(stale.status, 409);
  const current = await f.state();
  assert.equal(current.settings.grants.read, true);
  const denied = await f.post(`${prefix}/api/settings`, { revision: current.revision, settings: { ...current.settings, workspace: join(f.hostRoot, 'memory') } });
  assert.equal(denied.status, 400);
  assert.deepEqual(await readdir(f.hostRoot), []);
  assert.equal((await f.state()).revision, current.revision);
  const unknown = await f.post(`${prefix}/api/settings`, { revision: current.revision, settings: current.settings, bypass: true });
  assert.equal(unknown.status, 400);
});

test('generates a document and serves its actual bytes through a controlled download URL', async t => {
  const f = await fixture(t);
  await f.saveGrants({ read: true, write: true });
  const reply = await f.run([
    { action: 'document', path: '报告.docx', title: '隔离验收报告', paragraphs: ['只有合成内容。', '不访问真实账号。'], format: 'docx', createOnly: true },
    { action: 'deliver', path: '报告.docx' },
  ]);
  assert.equal(reply.content.state, 'completed');
  const url = reply.content.steps[1].result.url;
  assert.match(url, /^\/plugins\/computer\/download\?token=[a-f0-9]{48}$/);
  const response = await f.get(url);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition') ?? '', /attachment;/);
  assert.match(response.headers.get('content-disposition') ?? '', /filename\*=UTF-8''/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const downloaded = Buffer.from(await response.arrayBuffer());
  assert.deepEqual(downloaded, await readFile(join(f.root, 'data', 'workspace', '报告.docx')));
  assert.equal(downloaded.readUInt32LE(), 0x04034b50);
  assert.ok(!JSON.stringify(reply.receipt).includes('隔离验收报告'));
  assert.ok(!JSON.stringify(reply.receipt).includes('只有合成内容'));
  assert.ok(!JSON.stringify(f.messages).includes('只有合成内容'));
});

test('download refuses arbitrary paths, another session, revoked reads, and changed file contents', async t => {
  const f = await fixture(t);
  await f.saveGrants({ read: true, write: true });
  const reply = await f.run([{ action: 'write', path: 'result.txt', text: 'original document', createOnly: true }, { action: 'deliver', path: 'result.txt' }]);
  const url = reply.content.steps[1].result.url;
  await writeFile(join(f.hostRoot, 'private.txt'), 'protected fixture value');
  const arbitrary = await f.get(`${prefix}/download?path=${encodeURIComponent(join(f.hostRoot, 'private.txt'))}`);
  assert.equal(arbitrary.status, 400);
  assert.ok(!(await arbitrary.text()).includes('protected fixture value'));
  const ignoredPath = await f.get(url + `&path=${encodeURIComponent(join(f.hostRoot, 'private.txt'))}`);
  assert.equal(await ignoredPath.text(), 'original document');
  f.setSession('another-fixture-session');
  assert.equal((await f.get(url)).status, 400);
  f.setSession('fixture-session');
  await f.saveGrants({ read: false });
  assert.equal((await f.get(url)).status, 403);
  await f.saveGrants({ read: true });
  await writeFile(join(f.root, 'data', 'workspace', 'result.txt'), 'manual change');
  const changed = await f.get(url);
  assert.equal(changed.status, 409);
  assert.ok(!(await changed.text()).includes('manual change'));
});

test('HTTP handlers reject wrong methods, malformed JSON and oversized requests without taking down the plugin', async t => {
  const f = await fixture(t);
  assert.equal((await f.get(`${prefix}/api/settings`)).status, 400);
  assert.equal((await f.post(`${prefix}/api/state`, {})).status, 400);
  const badType = await fetch(f.base + `${prefix}/api/task`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(badType.status, 400);
  const malformed = await fetch(f.base + `${prefix}/api/task`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{broken' });
  assert.equal(malformed.status, 400);
  const large = await f.post(`${prefix}/api/task`, { operations: [{ action: 'write', path: 'huge.txt', text: 'x'.repeat(1024 * 1024) }] });
  assert.equal(large.status, 400);
  assert.equal((await large.json() as any).error.code, 'limit');
  assert.equal((await f.get(`${prefix}/api/state`)).status, 200);
});

test('execution output stays transient and receipts never contain code or file body', async t => {
  const stdout = 'fixture stdout that must stay transient';
  const executor: FakeExecutor = {
    async probe() { return { available: true, runtimes: ['node', 'powershell'] }; },
    async execute(request) {
      await writeFile(join(request.cwd, 'generated.txt'), 'generated fixture body');
      return { status: 'completed', exitCode: 0, stdout, stderr: '', truncated: false, elapsedMs: 1 };
    },
  };
  const f = await fixture(t, executor);
  const state = await f.state();
  assert.deepEqual(state.availability.execute.runtimes, ['node']);
  assert.equal(state.availability.execute.check, 'files-only');
  await f.saveGrants({ read: true, write: true, execute: true });
  const unavailable = await f.run([{ action: 'execute', runtime: 'powershell', code: 'Write-Output fixture' }]);
  assert.equal(unavailable.receipt.code, 'unavailable');
  const code = 'console.log("unique fixture program");';
  const reply = await f.run([{ action: 'execute', runtime: 'node', code, outputs: [{ name: 'generated.txt', path: 'generated.txt', createOnly: true }] }, { action: 'read', path: 'generated.txt' }]);
  assert.equal(reply.content.state, 'completed');
  assert.equal(reply.content.steps[0].result.stdout, stdout);
  assert.equal(reply.content.steps[1].result.text, 'generated fixture body');
  for (const privateValue of [stdout, code, 'generated fixture body']) {
    assert.ok(!JSON.stringify(reply.receipt).includes(privateValue));
    assert.ok(!JSON.stringify(f.messages).includes(privateValue));
    assert.ok(!JSON.stringify(f.saves).includes(privateValue));
  }
  assert.deepEqual(await readdir(join(f.root, 'data', 'executions')), []);
});

test('direct tool requests cannot self-assert Web origin or bypass host off permissions', async t => {
  const f = await fixture(t);
  await f.saveGrants({ read: true, write: true });
  const tool = f.tools.get('computer_task')!;
  const operation = { operations: [{ action: 'write', path: 'denied.txt', text: 'not written' }] };
  const off = await tool.run(operation, { ...f.session(), permission: 'off' });
  assert.equal(off.receipt.code, 'permission');
  const spoofed = await tool.run(operation, { ...f.session(), origin: { plugin: 'unknown' } });
  assert.equal(spoofed.receipt.code, 'origin');
  const selfAsserted = await tool.run({ ...operation, origin: 'web' }, f.session());
  assert.equal(selfAsserted.receipt.code, 'input');
  assert.deepEqual(await readdir(join(f.root, 'data', 'workspace')), []);
});
