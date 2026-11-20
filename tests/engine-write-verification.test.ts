/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './temporary-directory.ts';
import { FileStore } from '../src/files.ts';
import { ComputerEngine } from '../src/engine.ts';
import { SettingsStore, defaults } from '../src/settings.ts';
import type { FileMutation, FileOperation, TaskOrigin } from '../src/types.ts';
import type { ExecuteRequest, ExecuteResult } from '../src/executor.ts';

const windows = { skip: process.platform !== 'win32', timeout: 10000 };
const web = async (): Promise<TaskOrigin> => ({ kind: 'web', sessionId: 'verification-fixture' });
const completed = (): ExecuteResult => ({ status: 'completed', exitCode: 0, stdout: 'synthetic output', stderr: '', truncated: false, elapsedMs: 1 });
type Mutation = FileMutation & { verified?: boolean };
type Execution = ExecuteResult & { saved: Mutation[]; outputsImported: boolean; importError?: string; cleanupError?: string };
const executeOperation = (outputs: Extract<FileOperation, { action: 'execute' }>['outputs']): FileOperation => ({
  action: 'execute', runtime: 'node', code: 'synthetic code is never executed', outputs,
});
const after: FileOperation = { action: 'write', path: 'after.txt', text: 'must not run', createOnly: true };

async function fixture(t: TestContext, execute: (request: ExecuteRequest) => Promise<ExecuteResult> = async () => completed()) {
  const root = await temporaryDirectory(t), workspace = join(root, 'workspace'), scratch = join(root, 'scratch');
  await mkdir(workspace); await mkdir(scratch);
  const initial = defaults(workspace);
  Object.assign(initial.grants, { read: true, write: true, execute: true });
  const settings = new SettingsStore(initial, async () => {}), backupRoot = join(root, 'backups');
  const files = new FileStore({ backupRoot }), calls: ExecuteRequest[] = [];
  const engine = new ComputerEngine({ settings, files, scratchRoot: scratch, trustedWorkspace: workspace, protectedRoots: [],
    executor: { async execute(request) { calls.push(request); return execute(request); } },
    download: async () => { throw new Error('No download is expected'); },
  });
  return { workspace, scratch, backupRoot, files, engine, calls, scope: engine.scope(initial) };
}

function failFinalRead(t: TestContext, files: FileStore, target: string, expected: Uint8Array) {
  const original = files.readBytes.bind(files);
  let failures = 0;
  t.mock.method(files, 'readBytes', async (...args: Parameters<FileStore['readBytes']>) => {
    const read = await original(...args);
    // Preflight reads still see the old file. Inject only after the new bytes exist.
    if (read.path === target && Buffer.from(read.bytes).equals(expected)) {
      failures++;
      throw Object.assign(new Error('synthetic-private-readback-detail'), { code: 'EIO' });
    }
    return read;
  });
  return () => failures;
}

async function absent(path: string) { await assert.rejects(readFile(path), { code: 'ENOENT' }); }

test('write and document tasks propagate verified creation and unchanged results without backups', windows, async t => {
  const env = await fixture(t);
  const operations: Extract<FileOperation, { action: 'write' | 'document' }>[] = [
    { action: 'write', path: 'plain.txt', text: 'synthetic text', createOnly: true },
    { action: 'document', path: 'report.docx', format: 'docx', title: '合成文档', paragraphs: ['验证内容'], createOnly: true },
  ];
  const created = await env.engine.run(operations, web);
  assert.equal(created.state, 'completed'); assert.equal(created.steps.length, 2);
  const originalBytes: Buffer[] = [];
  for (const step of created.steps) {
    assert.equal(step.ok, true);
    const value = step.result as Mutation;
    assert.equal(value.outcome, 'created'); assert.equal(value.verified, true);
    originalBytes.push(await readFile(value.path));
  }
  const repeated = await env.engine.run(operations.map((operation, index) => ({
    ...operation, createOnly: false, expectedSha256: (created.steps[index].result as Mutation).sha256,
  })), web);
  assert.equal(repeated.state, 'completed'); assert.equal(repeated.steps.length, 2);
  for (const [index, step] of repeated.steps.entries()) {
    const value = step.result as Mutation, prior = created.steps[index].result as Mutation;
    assert.equal(step.ok, true); assert.equal(value.outcome, 'unchanged'); assert.equal(value.verified, true);
    assert.equal(value.sha256, prior.sha256); assert.equal(value.bytes, prior.bytes); assert.equal(value.backupId, undefined);
    assert.deepEqual(await readFile(value.path), originalBytes[index]);
  }
  assert.equal((await env.files.backups(env.scope)).total, 0);
});

test('execute output imports retain verified and unchanged receipts', windows, async t => {
  const env = await fixture(t, async request => {
    await writeFile(join(request.cwd, 'output.txt'), 'synthetic output'); return completed();
  });
  const first = await env.engine.run([executeOperation([{ name: 'output.txt', path: 'saved.txt', createOnly: true }])], web);
  const created = first.steps[0].result as Execution;
  assert.equal(first.state, 'completed'); assert.equal(first.steps[0].ok, true);
  assert.equal(created.outputsImported, true); assert.equal(created.saved.length, 1);
  assert.equal(created.saved[0].outcome, 'created'); assert.equal(created.saved[0].verified, true);
  const second = await env.engine.run([executeOperation([{ name: 'output.txt', path: 'saved.txt', expectedSha256: created.saved[0].sha256 }])], web);
  const unchanged = second.steps[0].result as Execution;
  assert.equal(second.state, 'completed'); assert.equal(second.steps[0].ok, true);
  assert.equal(unchanged.outputsImported, true); assert.equal(unchanged.saved.length, 1);
  assert.equal(unchanged.saved[0].outcome, 'unchanged'); assert.equal(unchanged.saved[0].verified, true);
  assert.equal(unchanged.saved[0].backupId, undefined); assert.equal(unchanged.saved[0].sha256, created.saved[0].sha256);
  assert.equal(await readFile(join(env.workspace, 'saved.txt'), 'utf8'), 'synthetic output');
  assert.equal((await env.files.backups(env.scope)).total, 0);
  assert.equal(env.calls.length, 2); assert.deepEqual(await readdir(env.scratch), []);
});

for (const action of ['write', 'document'] as const) {
  test(`${action} final read failure fails its task, preserves the backup and stops the batch`, windows, async t => {
    const env = await fixture(t), path = action === 'write' ? 'uncertain.txt' : 'uncertain.md';
    const target = join(env.workspace, path), old = 'synthetic original';
    await writeFile(target, old);
    const prior = await env.files.readBytes(env.scope, path);
    const next = action === 'write' ? 'synthetic replacement' : '# 合成文档\n\n验证内容\n';
    const failures = failFinalRead(t, env.files, target, Buffer.from(next));
    const operation: FileOperation = action === 'write'
      ? { action, path, text: next, expectedSha256: prior.sha256 }
      : { action, path, format: 'md', title: '合成文档', paragraphs: ['验证内容'], expectedSha256: prior.sha256 };
    const result = await env.engine.run([operation, after], web);
    assert.equal(result.state, 'failed'); assert.equal(result.steps.length, 1); assert.equal(result.steps[0].ok, false);
    assert.equal(result.steps[0].result, undefined); assert.equal(failures(), 1);
    // The write may already have happened; failing verification must not claim rollback or retry.
    assert.equal(await readFile(target, 'utf8'), next); await absent(join(env.workspace, 'after.txt'));
    const backups = await env.files.backups(env.scope);
    assert.equal(backups.total, 1); assert.equal(backups.items[0].sha256, prior.sha256);
    assert.equal(await readFile(join(env.backupRoot, backups.items[0].id + '.bin'), 'utf8'), old);
    assert.ok(result.steps[0].error?.includes(backups.items[0].id));
    assert.match(result.steps[0].error ?? '', /重试/);
    assert.doesNotMatch(result.steps[0].error ?? '', /synthetic-private-readback-detail/);
    assert.doesNotMatch(result.steps[0].error ?? '', /synthetic original|synthetic replacement|合成文档|验证内容/);
    assert.equal(env.engine.tasks()[0].state, 'failed'); assert.deepEqual(await readdir(env.scratch), []);
  });
}

test('unverified execute import preserves only the confirmed prefix and never replays execution', windows, async t => {
  const env = await fixture(t, async request => {
    await Promise.all(['first', 'second', 'third'].map(name => writeFile(join(request.cwd, name + '.txt'), name + ' output')));
    return completed();
  });
  const uncertain = join(env.workspace, 'uncertain.txt');
  await writeFile(uncertain, 'synthetic original');
  const prior = await env.files.readBytes(env.scope, 'uncertain.txt');
  const failures = failFinalRead(t, env.files, uncertain, Buffer.from('second output'));
  const result = await env.engine.run([executeOperation([
    { name: 'first.txt', path: 'confirmed.txt', createOnly: true },
    { name: 'second.txt', path: 'uncertain.txt', expectedSha256: prior.sha256 },
    { name: 'third.txt', path: 'never-imported.txt', createOnly: true },
  ]), after], web);
  assert.equal(result.state, 'failed'); assert.equal(result.steps.length, 1); assert.equal(result.steps[0].ok, false);
  const evidence = result.steps[0].result as Execution;
  assert.equal(evidence.status, 'completed'); assert.equal(evidence.exitCode, 0); assert.equal(evidence.outputsImported, false);
  assert.equal(evidence.saved.length, 1); assert.equal(evidence.saved[0].path, join(env.workspace, 'confirmed.txt'));
  assert.equal(evidence.saved[0].verified, true); assert.equal(evidence.saved[0].outcome, 'created');
  assert.equal(await readFile(evidence.saved[0].path, 'utf8'), 'first output');
  assert.equal(await readFile(uncertain, 'utf8'), 'second output');
  await absent(join(env.workspace, 'never-imported.txt')); await absent(join(env.workspace, 'after.txt'));
  const backups = await env.files.backups(env.scope);
  assert.equal(backups.total, 1); assert.equal(backups.items[0].sha256, prior.sha256);
  assert.ok(evidence.importError?.includes(backups.items[0].id)); assert.match(evidence.importError ?? '', /重试/);
  assert.doesNotMatch(evidence.importError ?? '', /synthetic-private-readback-detail/);
  assert.doesNotMatch(evidence.importError ?? '', /synthetic original|first output|second output|third output/);
  assert.equal(evidence.cleanupError, undefined); assert.equal(failures(), 1); assert.equal(env.calls.length, 1);
  assert.equal(env.engine.tasks()[0].state, 'failed'); assert.deepEqual(await readdir(env.scratch), []);
});
