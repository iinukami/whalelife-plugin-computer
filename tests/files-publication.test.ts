/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { basename, join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { FileStore } from '../src/files.ts';
import { publicError } from '../src/policy.ts';
import type { FileScope } from '../src/types.ts';
import { temporaryDirectory } from './temporary-directory.ts';

const policy = { keepDays: 30, maxBytes: 1048576 };
for (const persistent of [false, true]) {
  test(`publication followed by ${persistent ? 'persistent' : 'transient'} temporary-unlink failure reports an uncertain write`, async t => {
    const root = await temporaryDirectory(t), workspace = join(root, 'workspace');
    await fs.mkdir(workspace);
    const store = new FileStore({ backupRoot: join(root, 'backups') });
    const scope: FileScope = { workspace, scope: 'workspace', maxFileBytes: 1048576, protectedRoots: [] };
    const target = join(workspace, 'created.txt'), content = 'synthetic committed contents';
    const originalUnlink = fs.unlink;
    let failures = 0;
    const mock = t.mock.method(fs, 'unlink', async (...args: Parameters<typeof fs.unlink>) => {
      if (basename(String(args[0])).startsWith('.computer-write-') && (persistent || failures === 0)) {
        assert.equal(await fs.readFile(target, 'utf8'), content, 'fault must occur after publication');
        failures++;
        throw Object.assign(new Error('synthetic-private-unlink-detail'), { code: 'EACCES' });
      }
      return originalUnlink(...args);
    });
    t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
    syncBuiltinESMExports();
    await assert.rejects(store.write(scope, 'created.txt', Buffer.from(content), { backupPolicy: policy, createOnly: true }), error => {
      const exposed = publicError(error);
      assert.equal(exposed.code, 'WRITE_UNVERIFIED');
      assert.match(exposed.message, /目标可能已改变/);
      assert.match(exposed.message, /不要自动重试/);
      assert.doesNotMatch(exposed.message, /synthetic-private-unlink-detail|synthetic committed contents/);
      if (persistent) assert.match(exposed.message, /临时文件.*清理/);
      return true;
    });
    assert.equal(await fs.readFile(target, 'utf8'), content, 'the failure must not roll back a published target');
    assert.equal(failures, persistent ? 2 : 1);
    const leftovers = (await fs.readdir(workspace)).filter(name => name.startsWith('.computer-write-'));
    assert.equal(leftovers.length, persistent ? 1 : 0);
    mock.mock.restore(); syncBuiltinESMExports();
    for (const name of leftovers) await fs.unlink(join(workspace, name));
    assert.equal((await store.read(scope, 'created.txt')).text, content);
  });
}

test('a failed rename before publication preserves the old target and does not claim a committed write', async t => {
  const root = await temporaryDirectory(t), workspace = join(root, 'workspace'); await fs.mkdir(workspace);
  const store = new FileStore({ backupRoot: join(root, 'backups') });
  const scope: FileScope = { workspace, scope: 'workspace', maxFileBytes: 1048576, protectedRoots: [] };
  const created = await store.write(scope, 'old.txt', Buffer.from('old fixture'), { backupPolicy: policy, createOnly: true });
  const originalRename = fs.rename;
  const mock = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (basename(String(args[0])).startsWith('.computer-write-')) throw Object.assign(new Error('synthetic rename denied'), { code: 'EACCES' });
    return originalRename(...args);
  });
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); }); syncBuiltinESMExports();
  await assert.rejects(store.write(scope, 'old.txt', Buffer.from('replacement'), { backupPolicy: policy, expectedSha256: created.sha256 }), { code: 'EACCES' });
  assert.equal(await fs.readFile(join(workspace, 'old.txt'), 'utf8'), 'old fixture');
  assert.deepEqual(await fs.readdir(workspace), ['old.txt']);
});
