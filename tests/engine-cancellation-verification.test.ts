/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { temporaryDirectory } from './temporary-directory.ts';
import { FileStore } from '../src/files.ts';
import { ComputerEngine } from '../src/engine.ts';
import { SettingsStore, defaults } from '../src/settings.ts';
import type { FileMutation, FileOperation, TaskOrigin, TaskResult } from '../src/types.ts';
import type { ExecuteRequest, ExecuteResult } from '../src/executor.ts';

const windows = { skip: process.platform !== 'win32', timeout: 10000 };
const web = async (): Promise<TaskOrigin> => ({ kind: 'web', sessionId: 'cancellation-fixture' });
const completed = (): ExecuteResult => ({ status: 'completed', exitCode: 0, stdout: 'synthetic execution', stderr: '', truncated: false, elapsedMs: 1 });
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const write = (path: string, text: string, expectedSha256: string): FileOperation => ({ action: 'write', path, text, expectedSha256 });
const after: FileOperation = { action: 'write', path: 'after.txt', text: 'must not run', createOnly: true };
type Execution = ExecuteResult & { saved: FileMutation[]; outputsImported: boolean; importError?: string; cleanupError?: string };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t: TestContext, execute: (request: ExecuteRequest) => Promise<ExecuteResult> = async () => completed()) {
  const root = await temporaryDirectory(t), workspace = join(root, 'workspace'), scratch = join(root, 'scratch'), backupRoot = join(root, 'backups');
  await mkdir(workspace); await mkdir(scratch);
  const initial = defaults(workspace); Object.assign(initial.grants, { read: true, write: true, execute: true });
  const files = new FileStore({ backupRoot }), calls: ExecuteRequest[] = [];
  const engine = new ComputerEngine({ settings: new SettingsStore(initial, async () => {}), files,
    scratchRoot: scratch, trustedWorkspace: workspace, protectedRoots: [],
    executor: { async execute(request) { calls.push(request); return execute(request); } },
    download: async () => { throw new Error('Unexpected download'); },
  });
  return { workspace, scratch, backupRoot, files, engine, calls, scope: engine.scope(initial) };
}

/** Pause before the real broker read, only after raw disk bytes prove the selected commit exists. */
function pauseRead(t: TestContext, files: FileStore, target: string, contents: string) {
  const entered = deferred(), release = deferred(), original = files.readBytes.bind(files);
  let paused = false;
  t.mock.method(files, 'readBytes', async (...args: Parameters<FileStore['readBytes']>) => {
    if (!paused && resolve(args[0].workspace, args[1]) === target && await readFile(target, 'utf8') === contents) {
      paused = true; entered.resolve(); await release.promise;
    }
    return original(...args);
  });
  return { entered: entered.promise, release: release.resolve };
}

async function reached(gate: ReturnType<typeof pauseRead>, pending: Promise<TaskResult>) {
  await Promise.race([gate.entered, pending.then(() => { throw new Error('Task ended without reaching the required read synchronization point'); })]);
}

async function absent(path: string) { await assert.rejects(readFile(path), { code: 'ENOENT' }); }
function uncertain(message: string | undefined, backupId: string) {
  assert.match(message ?? '', /未能核验/); assert.match(message ?? '', /可能已改变/);
  assert.match(message ?? '', /不要自动重试/); assert.ok(message?.includes(backupId));
  assert.doesNotMatch(message ?? '', /synthetic-original|synthetic-next|synthetic-corruption/);
}

test('cancellation after a write commits but before final readback cannot report success', windows, async t => {
  const env = await fixture(t), target = join(env.workspace, 'target.txt');
  await writeFile(target, 'synthetic-original');
  const gate = pauseRead(t, env.files, target, 'synthetic-next'), controller = new AbortController();
  const pending = env.engine.run([write('target.txt', 'synthetic-next', sha('synthetic-original')), after], web, controller.signal);
  let result!: TaskResult;
  try {
    await reached(gate, pending);
    assert.equal(await readFile(target, 'utf8'), 'synthetic-next');
    controller.abort();
  } finally { gate.release(); result = await pending; }
  assert.equal(result.state, 'cancelled'); assert.equal(result.steps.length, 1); assert.equal(result.steps[0].ok, false);
  assert.equal(result.steps[0].result, undefined); await absent(join(env.workspace, 'after.txt'));
  assert.equal(await readFile(target, 'utf8'), 'synthetic-next');
  const backups = await env.files.backups(env.scope);
  assert.equal(backups.total, 1); uncertain(result.steps[0].error, backups.items[0].id);
  assert.equal(await readFile(join(env.backupRoot, backups.items[0].id + '.bin'), 'utf8'), 'synthetic-original');
  assert.equal(env.engine.tasks()[0].state, 'cancelled'); assert.deepEqual(await readdir(env.scratch), []);
});

for (const interruption of ['cancel', 'corrupt'] as const) {
  test(`execute import ${interruption} preserves confirmed and unchanged prefix without replay`, windows, async t => {
    const env = await fixture(t, async request => {
      for (const [name, value] of Object.entries({ first: 'confirmed', same: 'same', current: 'synthetic-next', last: 'later' }))
        await writeFile(join(request.cwd, name + '.txt'), value);
      return completed();
    });
    const current = join(env.workspace, 'current.txt');
    await writeFile(current, 'synthetic-original'); await writeFile(join(env.workspace, 'same.txt'), 'same');
    const gate = pauseRead(t, env.files, current, 'synthetic-next'), controller = new AbortController();
    const operation: FileOperation = { action: 'execute', runtime: 'node', code: 'synthetic code is never executed', outputs: [
      { name: 'first.txt', path: 'confirmed.txt', createOnly: true },
      { name: 'same.txt', path: 'same.txt', expectedSha256: sha('same') },
      { name: 'current.txt', path: 'current.txt', expectedSha256: sha('synthetic-original') },
      { name: 'last.txt', path: 'later.txt', createOnly: true },
    ] };
    const pending = env.engine.run([operation, after], web, controller.signal);
    let result!: TaskResult;
    try {
      await reached(gate, pending);
      assert.equal(await readFile(current, 'utf8'), 'synthetic-next');
      if (interruption === 'cancel') controller.abort();
      else await writeFile(current, 'synthetic-corruption'); // Real external change, not a forged read result.
    } finally { gate.release(); result = await pending; }
    assert.notEqual(result.state, 'completed'); assert.equal(result.steps.length, 1); assert.equal(result.steps[0].ok, false);
    const evidence = result.steps[0].result as Execution;
    // The command itself finished; only its output import is unsuccessful.
    assert.equal(evidence.status, 'completed'); assert.equal(evidence.exitCode, 0); assert.equal(evidence.outputsImported, false);
    assert.deepEqual(evidence.saved.map(value => [value.path, value.outcome, value.verified]), [
      [join(env.workspace, 'confirmed.txt'), 'created', true], [join(env.workspace, 'same.txt'), 'unchanged', true],
    ]);
    assert.equal(evidence.saved[1].backupId, undefined);
    assert.equal(await readFile(join(env.workspace, 'confirmed.txt'), 'utf8'), 'confirmed');
    assert.equal(await readFile(join(env.workspace, 'same.txt'), 'utf8'), 'same');
    assert.equal(await readFile(current, 'utf8'), interruption === 'cancel' ? 'synthetic-next' : 'synthetic-corruption');
    await absent(join(env.workspace, 'later.txt')); await absent(join(env.workspace, 'after.txt'));
    const backups = await env.files.backups(env.scope);
    assert.equal(backups.total, 1); uncertain(evidence.importError, backups.items[0].id);
    assert.equal(await readFile(join(env.backupRoot, backups.items[0].id + '.bin'), 'utf8'), 'synthetic-original');
    assert.equal(env.calls.length, 1); assert.equal(evidence.cleanupError, undefined); assert.deepEqual(await readdir(env.scratch), []);
    assert.equal(env.engine.tasks()[0].state, result.state);
    t.diagnostic(`${interruption}: task ${result.state}, command ${evidence.status}, outputsImported ${evidence.outputsImported}`);
  });
}

test('concurrent identical tasks stay unchanged and do not touch the target or create backups', windows, async t => {
  const env = await fixture(t), target = join(env.workspace, 'same.txt');
  await writeFile(target, 'same');
  const before = await stat(target, { bigint: true }), gate = pauseRead(t, env.files, target, 'same');
  const first = env.engine.run([write('same.txt', 'same', sha('same'))], web);
  let pending: ReturnType<ComputerEngine['run']>[] = [first], results!: TaskResult[];
  try {
    await reached(gate, first);
    pending = [first, env.engine.run([write('same.txt', 'same', sha('same'))], web), env.engine.run([write('same.txt', 'same', sha('same'))], web)];
    assert.equal(env.engine.tasks().length, 1);
  } finally { gate.release(); results = await Promise.all(pending); }
  for (const result of results) {
    assert.equal(result.state, 'completed'); assert.equal(result.steps[0].ok, true);
    const value = result.steps[0].result as FileMutation;
    assert.equal(value.outcome, 'unchanged'); assert.equal(value.verified, true); assert.equal(value.backupId, undefined);
  }
  const final = await stat(target, { bigint: true });
  assert.equal(final.ino, before.ino); assert.equal(final.mtimeNs, before.mtimeNs); assert.equal(final.ctimeNs, before.ctimeNs);
  assert.equal((await env.files.backups(env.scope)).total, 0); assert.equal(env.engine.tasks().length, 3);
});

test('concurrent writes serialize digest checks before no-op and never back up stale conflicts', windows, async t => {
  const env = await fixture(t), target = join(env.workspace, 'target.txt');
  await writeFile(target, 'original');
  const gate = pauseRead(t, env.files, target, 'next');
  const first = env.engine.run([write('target.txt', 'next', sha('original'))], web);
  let pending: ReturnType<ComputerEngine['run']>[] = [first], results!: TaskResult[];
  try {
    await reached(gate, first);
    assert.equal(await readFile(target, 'utf8'), 'next');
    pending = [first,
      env.engine.run([write('target.txt', 'next', sha('original'))], web),
      env.engine.run([write('target.txt', 'different', sha('original'))], web),
      env.engine.run([write('target.txt', 'next', sha('next'))], web),
      env.engine.run([write('target.txt', 'different', sha('next'))], web),
    ];
    assert.equal(env.engine.tasks().length, 1);
  } finally { gate.release(); results = await Promise.all(pending); }
  assert.deepEqual(results.map(result => result.state), ['completed', 'failed', 'failed', 'completed', 'completed']);
  for (const index of [1, 2]) {
    assert.equal(results[index].steps[0].ok, false); assert.equal(results[index].steps[0].result, undefined);
    assert.match(results[index].steps[0].error ?? '', /摘要|变化/);
  }
  assert.deepEqual([0, 3, 4].map(index => {
    const value = results[index].steps[0].result as FileMutation;
    return [value.outcome, value.verified];
  }), [['updated', true], ['unchanged', true], ['updated', true]]);
  assert.equal((results[3].steps[0].result as FileMutation).backupId, undefined);
  assert.equal(await readFile(target, 'utf8'), 'different');
  const backups = await env.files.backups(env.scope);
  assert.equal(backups.total, 2);
  const bodies = await Promise.all(backups.items.map(item => readFile(join(env.backupRoot, item.id + '.bin'), 'utf8')));
  assert.deepEqual(bodies.sort(), ['next', 'original']);
  assert.deepEqual((await readdir(env.workspace)).sort(), ['target.txt']); assert.equal(env.engine.tasks().length, 5);
});
