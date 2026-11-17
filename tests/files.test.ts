/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir, stat, symlink, link } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { FileStore } from '../src/files.ts';
import type { BackupPolicy, FileScope } from '../src/types.ts';
import { temporaryDirectory } from './temporary-directory.ts';

const policy: BackupPolicy = { keepDays: 14, maxBytes: 1024 * 1024 };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
async function fixture(t: TestContext) {
  const root = await temporaryDirectory(t), workspace = join(root, 'workspace'), outside = join(root, 'outside'), protectedRoot = join(root, 'host');
  await Promise.all([mkdir(workspace), mkdir(outside), mkdir(protectedRoot)]);
  const backupRoot = join(root, 'backups'), store = new FileStore({ backupRoot });
  const scope: FileScope = { workspace, scope: 'workspace', protectedRoots: [protectedRoot], maxFileBytes: 1024 * 1024 };
  const put = (path: string, value: string, extra: { expectedSha256?: string; createOnly?: boolean } = {}) =>
    store.write(scope, path, Buffer.from(value), { backupPolicy: policy, ...extra });
  return { root, workspace, outside, protectedRoot, backupRoot, store, scope, put };
}

test('creates and reads Unicode files, reports whole-file digest and bounded pages', async t => {
  const f = await fixture(t);
  const first = await f.put('中文.txt', '甲😀乙丙');
  assert.equal(first.outcome, 'created');
  assert.equal(first.sha256, hash('甲😀乙丙'));
  const page = await f.store.read(f.scope, '中文.txt', 0, 2);
  assert.equal(page.text, '甲😀');
  assert.equal(page.nextOffset, 3);
  assert.equal(page.totalBytes, Buffer.byteLength('甲😀乙丙'));
  const second = await f.store.read(f.scope, '中文.txt', page.nextOffset, 2);
  assert.equal(second.text, '乙丙');
  assert.equal(second.nextOffset, undefined);
  assert.equal(second.sha256, first.sha256);
  assert.equal(Buffer.from((await f.store.readBytes(f.scope, '中文.txt')).bytes).toString(), '甲😀乙丙');
  await assert.rejects(f.put('中文.txt', 'overwrite'), { code: 'CONFLICT' });
  await assert.rejects(f.put('中文.txt', 'overwrite', { createOnly: true, expectedSha256: first.sha256 }), { code: 'CONFLICT' });
});

test('edits require exactly one match and a current whole-file digest', async t => {
  const f = await fixture(t);
  await f.put('note.txt', 'first second');
  const edited = await f.store.edit(f.scope, 'note.txt', 'second', 'third', hash('first second'), policy);
  assert.equal((await f.store.read(f.scope, 'note.txt')).text, 'first third');
  assert.ok(edited.backupId);
  await assert.rejects(f.store.edit(f.scope, 'note.txt', 'missing', 'new', edited.sha256!, policy), { code: 'AMBIGUOUS_EDIT' });
  await f.put('repeat.txt', 'one one');
  await assert.rejects(f.store.edit(f.scope, 'repeat.txt', 'one', 'two', hash('one one'), policy), { code: 'AMBIGUOUS_EDIT' });
  await f.put('overlap.txt', 'aaa');
  await assert.rejects(f.store.edit(f.scope, 'overlap.txt', 'aa', 'b', hash('aaa'), policy), { code: 'AMBIGUOUS_EDIT' });
  assert.equal((await f.store.read(f.scope, 'overlap.txt')).text, 'aaa');
  await writeFile(join(f.workspace, 'note.txt'), 'manual edit');
  await assert.rejects(f.put('note.txt', 'lost update', { expectedSha256: edited.sha256 }), { code: 'CONFLICT' });
  assert.equal(await readFile(join(f.workspace, 'note.txt'), 'utf8'), 'manual edit');
});

test('overwrite, deletion and restore preserve independently verifiable recovery copies', async t => {
  const f = await fixture(t);
  await f.put('note.txt', 'private fixture original');
  const changed = await f.put('note.txt', 'second version', { expectedSha256: hash('private fixture original') });
  assert.ok(changed.backupId);
  const record = await readFile(join(f.backupRoot, `${changed.backupId}.json`), 'utf8');
  assert.ok(!record.includes('private fixture original'));
  const restored = await f.store.restore(f.scope, changed.backupId!, { expectedSha256: hash('second version'), backupPolicy: policy });
  assert.equal(restored.outcome, 'restored');
  assert.ok(restored.backupId);
  assert.equal((await f.store.read(f.scope, 'note.txt')).text, 'private fixture original');
  const deleted = await f.store.delete(f.scope, 'note.txt', hash('private fixture original'), policy);
  await assert.rejects(stat(join(f.workspace, 'note.txt')), { code: 'ENOENT' });
  const restoredDeleted = await f.store.restore(f.scope, deleted.backupId!, { createOnly: true, backupPolicy: policy });
  assert.equal(restoredDeleted.outcome, 'restored');
  assert.equal((await f.store.read(f.scope, 'note.txt')).text, 'private fixture original');
  const backups = await f.store.backups(f.scope);
  assert.equal(backups.total, 3);
  assert.ok(backups.items.every(item => !('owner' in item) && !('version' in item)));
});

test('insufficient backup capacity refuses overwrite and delete before changing the original', async t => {
  const f = await fixture(t);
  await f.put('original.txt', 'more than four bytes');
  const tooSmall = { keepDays: 14, maxBytes: 4 };
  await assert.rejects(f.store.write(f.scope, 'original.txt', Buffer.from('new'), { expectedSha256: hash('more than four bytes'), backupPolicy: tooSmall }), { code: 'BACKUP_CAPACITY' });
  await assert.rejects(f.store.delete(f.scope, 'original.txt', hash('more than four bytes'), tooSmall), { code: 'BACKUP_CAPACITY' });
  assert.equal(await readFile(join(f.workspace, 'original.txt'), 'utf8'), 'more than four bytes');
});

test('backup corruption is detected before restoration', async t => {
  const f = await fixture(t);
  await f.put('one.txt', 'original');
  const removed = await f.store.delete(f.scope, 'one.txt', hash('original'), policy);
  await writeFile(join(f.backupRoot, `${removed.backupId}.bin`), 'tampered');
  await assert.rejects(f.store.restore(f.scope, removed.backupId!, { backupPolicy: policy }), { code: 'BACKUP_CORRUPT' });
  await assert.rejects(stat(join(f.workspace, 'one.txt')), { code: 'ENOENT' });
});

test('cancelled operations do not mutate files, and errors do not poison the queue', async t => {
  const f = await fixture(t), controller = new AbortController();
  await f.put('one.txt', 'one');
  controller.abort(new Error('cancelled fixture'));
  await assert.rejects(f.store.write(f.scope, 'one.txt', Buffer.from('two'), { expectedSha256: hash('one'), backupPolicy: policy, signal: controller.signal }), /cancelled fixture/);
  await assert.rejects(f.store.delete(f.scope, 'one.txt', hash('one'), policy, controller.signal), /cancelled fixture/);
  await assert.rejects(f.store.read(f.scope, 'one.txt', 0, 100, controller.signal), /cancelled fixture/);
  await assert.rejects(f.store.search(f.scope, '', 'one', { signal: controller.signal }), /cancelled fixture/);
  assert.equal(await readFile(join(f.workspace, 'one.txt'), 'utf8'), 'one');
  await f.put('two.txt', 'still works');
});

test('rejects traversal, network, device, ADS, drive-relative and reserved paths', async t => {
  const f = await fixture(t);
  for (const path of ['../outside/escape.txt', '..\\outside\\escape.txt', '\\\\server\\share\\file', '//server/share/file', '\\\\?\\C:\\file', '\\\\.\\PIPE\\x', 'C:relative.txt', 'C:', '/rooted.txt', '\\rooted.txt', 'data.txt:secret', 'CON', 'NUL.txt', 'com1.txt', 'LPT¹', 'bad.', 'bad ', 'bad\u0000name']) {
    await assert.rejects(f.put(path, 'denied'), { code: 'INVALID_PATH' }, path);
  }
  await assert.rejects(f.put(join(f.outside, 'escape.txt'), 'denied'), { code: 'OUTSIDE_SCOPE' });
  assert.deepEqual(await readdir(f.outside), []);
});

test('expanded scope allows ordinary local targets but protects host and backup roots', async t => {
  const f = await fixture(t), all = { ...f.scope, scope: 'all' as const };
  await f.store.write(all, join(f.outside, 'result.txt'), Buffer.from('allowed'), { backupPolicy: policy });
  assert.equal((await f.store.read(all, join(f.outside, 'result.txt'))).text, 'allowed');
  await assert.rejects(f.store.write(all, join(f.protectedRoot, 'secret.txt'), Buffer.from('denied'), { backupPolicy: policy }), { code: 'PROTECTED_PATH' });
  await assert.rejects(f.store.list(all, f.backupRoot), { code: 'PROTECTED_PATH' });
  await assert.rejects(f.store.read(all, join(f.backupRoot, '.owner.json')), { code: 'PROTECTED_PATH' });
});

test('only the fixed trusted workspace is an exception to protected ancestors', async t => {
  const f = await fixture(t), trusted = join(f.protectedRoot, 'plugin', 'data', 'workspace');
  await mkdir(trusted, { recursive: true });
  const fixed: FileScope = { ...f.scope, workspace: trusted, trustedWorkspace: trusted };
  await f.store.write(fixed, 'allowed.txt', Buffer.from('allowed'), { backupPolicy: policy });
  const other = join(f.protectedRoot, 'memory'); await mkdir(other);
  await assert.rejects(f.store.write({ ...fixed, workspace: other }, 'forbidden.txt', Buffer.from('denied'), { backupPolicy: policy }), { code: 'PROTECTED_PATH' });
  await assert.rejects(f.store.read({ ...fixed, trustedWorkspace: undefined }, 'allowed.txt'), { code: 'PROTECTED_PATH' });
  const protectedChild = join(trusted, 'secret'); await mkdir(protectedChild);
  await assert.rejects(f.store.write({ ...fixed, protectedRoots: [...fixed.protectedRoots, protectedChild] }, 'secret/no.txt', Buffer.from('denied'), { backupPolicy: policy }), { code: 'PROTECTED_PATH' });
  await assert.rejects(f.store.list({ ...f.scope, workspace: f.root }), { code: 'PROTECTED_PATH' });
});

test('junction traversal is rejected and searches do not follow it', async t => {
  const f = await fixture(t);
  await writeFile(join(f.outside, 'private.txt'), 'outside fixture');
  await symlink(f.outside, join(f.workspace, 'junction'), 'junction');
  await assert.rejects(f.store.read(f.scope, 'junction/private.txt'), { code: 'UNSAFE_LINK' });
  await assert.rejects(f.put('junction/new.txt', 'denied'), { code: 'UNSAFE_LINK' });
  await assert.rejects(f.store.list(f.scope, 'junction'), { code: 'UNSAFE_LINK' });
  assert.equal((await f.store.search(f.scope, '', 'outside fixture', { content: true })).total, 0);
  assert.equal((await f.store.list(f.scope)).total, 0);
  assert.equal(await readFile(join(f.outside, 'private.txt'), 'utf8'), 'outside fixture');
});

test('hard links are rejected by read, write and delete operations', async t => {
  const f = await fixture(t);
  await writeFile(join(f.outside, 'original.txt'), 'outside fixture');
  await link(join(f.outside, 'original.txt'), join(f.workspace, 'alias.txt'));
  await assert.rejects(f.store.readBytes(f.scope, 'alias.txt'), { code: 'UNSAFE_LINK' });
  await assert.rejects(f.put('alias.txt', 'bad', { expectedSha256: hash('outside fixture') }), { code: 'UNSAFE_LINK' });
  await assert.rejects(f.store.delete(f.scope, 'alias.txt', hash('outside fixture'), policy), { code: 'UNSAFE_LINK' });
  assert.equal(await readFile(join(f.outside, 'original.txt'), 'utf8'), 'outside fixture');
});

test('restore rechecks scope and rejects index path injection or foreign ownership', async t => {
  const f = await fixture(t);
  await f.put('one.txt', 'one');
  const deleted = await f.store.delete(f.scope, 'one.txt', hash('one'), policy);
  const index = join(f.backupRoot, `${deleted.backupId}.json`), original = JSON.parse(await readFile(index, 'utf8'));
  await writeFile(index, JSON.stringify({ ...original, path: join(f.outside, 'injected.txt') }));
  await assert.rejects(f.store.restore(f.scope, deleted.backupId!, { backupPolicy: policy }), { code: 'OUTSIDE_SCOPE' });
  assert.deepEqual(await readdir(f.outside), []);
  await writeFile(index, JSON.stringify({ ...original, owner: randomUUID() }));
  await assert.rejects(f.store.restore(f.scope, deleted.backupId!, { backupPolicy: policy }), { code: 'BACKUP_CORRUPT' });
  await assert.rejects(f.store.restore(f.scope, '../escape', { backupPolicy: policy }), { code: 'INVALID_BACKUP' });
});

test('backup listing and restoration are filtered by current file scope', async t => {
  const f = await fixture(t), all = { ...f.scope, scope: 'all' as const }, path = join(f.outside, 'outside.txt');
  await f.store.write(all, path, Buffer.from('old'), { backupPolicy: policy });
  const changed = await f.store.write(all, path, Buffer.from('new'), { backupPolicy: policy, expectedSha256: hash('old') });
  assert.equal((await f.store.backups(all)).total, 1);
  assert.equal((await f.store.backups(f.scope)).total, 0);
  await assert.rejects(f.store.restore(f.scope, changed.backupId!, { expectedSha256: hash('new'), backupPolicy: policy }), { code: 'OUTSIDE_SCOPE' });
});

test('retention removes oldest owned backups, honours expiry and preserves unrelated files', async t => {
  const f = await fixture(t);
  await f.put('value.txt', 'aaaa');
  const a = await f.put('value.txt', 'bbbb', { expectedSha256: hash('aaaa') });
  const b = await f.put('value.txt', 'cccc', { expectedSha256: hash('bbbb') });
  const c = await f.put('value.txt', 'dddd', { expectedSha256: hash('cccc') });
  for (const [id, age] of [[a.backupId, 30000], [b.backupId, 20000], [c.backupId, 10000]] as const) {
    const path = join(f.backupRoot, `${id}.json`), data = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({ ...data, createdAt: new Date(Date.now() - age).toISOString() }));
  }
  await writeFile(join(f.backupRoot, 'keep-user-note.txt'), 'preserve');
  const removed = await f.store.prune({ keepDays: 14, maxBytes: 8 });
  assert.deepEqual(removed, { removed: 1, bytes: 4 });
  await assert.rejects(stat(join(f.backupRoot, `${a.backupId}.bin`)), { code: 'ENOENT' });
  assert.equal((await f.store.backups(f.scope)).total, 2);
  const expiredPath = join(f.backupRoot, `${b.backupId}.json`), expired = JSON.parse(await readFile(expiredPath, 'utf8'));
  await writeFile(expiredPath, JSON.stringify({ ...expired, createdAt: new Date(Date.now() - 2 * 86400000).toISOString() }));
  assert.deepEqual(await f.store.prune({ keepDays: 1, maxBytes: 100 }), { removed: 1, bytes: 4 });
  assert.equal(await readFile(join(f.backupRoot, 'keep-user-note.txt'), 'utf8'), 'preserve');
  assert.equal(await readFile(join(f.workspace, 'value.txt'), 'utf8'), 'dddd');
});

test('refuses to adopt a nonempty unowned backup folder', async t => {
  const f = await fixture(t);
  await mkdir(f.backupRoot); await writeFile(join(f.backupRoot, 'existing.txt'), 'do not touch');
  await f.put('one.txt', 'one');
  await assert.rejects(f.put('one.txt', 'two', { expectedSha256: hash('one') }), { code: 'BACKUP_UNSAFE' });
  assert.equal(await readFile(join(f.workspace, 'one.txt'), 'utf8'), 'one');
  assert.equal(await readFile(join(f.backupRoot, 'existing.txt'), 'utf8'), 'do not touch');
});

test('unindexed or malformed backup entries fail closed instead of bypassing the quota', async t => {
  const f = await fixture(t);
  await f.put('one.txt', 'first');
  await f.put('one.txt', 'second', { expectedSha256: hash('first') });
  const orphan = join(f.backupRoot, `${randomUUID()}.bin`);
  await writeFile(orphan, 'incomplete backup');
  await assert.rejects(f.put('one.txt', 'third', { expectedSha256: hash('second') }), { code: 'BACKUP_CORRUPT' });
  assert.equal(await readFile(join(f.workspace, 'one.txt'), 'utf8'), 'second');
  assert.equal(await readFile(orphan, 'utf8'), 'incomplete backup');
});

test('literal content search, directory paging and text limits are bounded', async t => {
  const f = await fixture(t);
  await f.store.mkdir(f.scope, 'nested/deep');
  await f.put('a.txt', 'line one\n[literal] marker');
  await f.put('b.txt', 'no match');
  await f.put('nested/deep/c.txt', '[literal] second');
  const first = await f.store.search(f.scope, '', '[literal]', { content: true, limit: 1 });
  assert.equal(first.total, 2); assert.equal(first.items[0].line, 2); assert.equal(first.nextOffset, 1);
  const second = await f.store.search(f.scope, '', '[literal]', { content: true, limit: 1, offset: 1 });
  assert.match(second.items[0].path, /c\.txt$/);
  assert.equal((await f.store.list(f.scope, '', 0, 2)).nextOffset, 2);
  await assert.rejects(f.store.list(f.scope, '', 0, 1000), { code: 'INVALID_PAGE' });
  await assert.rejects(f.store.read({ ...f.scope, maxFileBytes: 3 }, 'a.txt'), { code: 'FILE_TOO_LARGE' });
  await f.store.write(f.scope, 'binary.dat', Uint8Array.from([255, 0, 254]), { backupPolicy: policy });
  await assert.rejects(f.store.read(f.scope, 'binary.dat'), { code: 'NOT_TEXT' });
  assert.equal((await f.store.mkdir(f.scope, 'nested/deep')).created, false);
});

test('concurrent writes with one expected digest commit at most once', async t => {
  const f = await fixture(t);
  await f.put('one.txt', 'base');
  const results = await Promise.allSettled([
    f.put('one.txt', 'first', { expectedSha256: hash('base') }),
    f.put('one.txt', 'second', { expectedSha256: hash('base') }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejection = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
  assert.equal(rejection.reason.code, 'CONFLICT');
  assert.equal(await readFile(join(f.workspace, 'one.txt'), 'utf8'), 'first');
  assert.equal((await f.store.backups(f.scope)).total, 1);
  assert.ok(!(await readdir(f.workspace)).some(name => name.startsWith('.computer-write-')));
});
