/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, stat, open, unlink, link } from 'node:fs/promises';
import { join } from 'node:path';
import { FileStore } from '../src/files.ts';
import type { BackupPolicy, FileScope } from '../src/types.ts';
import { temporaryDirectory } from './temporary-directory.ts';

const backupPolicy: BackupPolicy = { keepDays: 14, maxBytes: 1024 * 1024 };
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function fixture(t: TestContext) {
  // Register ownership-checked cleanup before creating any fixture contents.
  const root = await temporaryDirectory(t);
  const workspace = join(root, 'workspace'), backupRoot = join(root, 'backups');
  await mkdir(workspace);
  const store = new FileStore({ backupRoot });
  const scope: FileScope = { workspace, scope: 'workspace', protectedRoots: [], maxFileBytes: 1024 * 1024 };
  return { root, workspace, backupRoot, store, scope };
}

for (const mode of ['creation', 'overwrite'] as const) {
  for (const fault of ['rewrite', 'truncate', 'delete', 'hard link'] as const) {
    test(`${mode}: real post-commit ${fault} is detected without rollback or automatic retry`, async t => {
      const f = await fixture(t), target = join(f.workspace, 'target.bin'), donor = join(f.root, 'owned-link-donor.bin');
      const original = Buffer.from('original synthetic version'), intended = Buffer.from('new synthetic version');
      const corrupted = Buffer.from(intended);
      corrupted[0] ^= 1; // Same length: checking only the final length cannot catch this.
      if (mode === 'overwrite') await f.store.write(f.scope, target, original, { createOnly: true, backupPolicy });
      if (fault === 'hard link') await writeFile(donor, intended);

      const reader = f.store.readBytes.bind(f.store);
      let injected = 0, actualReadAttempts = 0, readerError: string | undefined;
      let observedBytes: Uint8Array | undefined, observedSha256: string | undefined;
      const mock = t.mock.method(f.store, 'readBytes', async (...args: Parameters<FileStore['readBytes']>) => {
        if (args[1] === target && injected === 0) {
          let current: Buffer | undefined;
          try { current = await readFile(target); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          // A deterministic rendezvous after rename/link has committed. Both
          // pre-write version checks still observe the absent/original target.
          if (current?.equals(intended)) {
            injected++;
            if (fault === 'rewrite') await writeFile(target, corrupted);
            if (fault === 'truncate') {
              const handle = await open(target, 'r+');
              try { await handle.truncate(0); } finally { await handle.close(); }
            }
            if (fault === 'delete') await unlink(target);
            if (fault === 'hard link') {
              await unlink(target);
              await link(donor, target);
            }
          }
        }
        if (injected) actualReadAttempts++;
        try {
          // No fabricated bytes, digest or error: use the real file broker on
          // the changed disk state and pass its result through unchanged.
          const result = await reader(...args);
          if (injected) { observedBytes = result.bytes; observedSha256 = result.sha256; }
          return result;
        } catch (error) {
          if (injected) readerError = (error as NodeJS.ErrnoException).code;
          throw error;
        }
      });

      let failureMessage = '';
      await assert.rejects(f.store.write(f.scope, target, intended, {
        backupPolicy, ...(mode === 'creation' ? { createOnly: true } : { expectedSha256: digest(original) }),
      }), (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'WRITE_UNVERIFIED');
        failureMessage = (error as Error).message;
        assert.match(failureMessage, /目标可能已改变/);
        assert.match(failureMessage, /不要自动重试/);
        return true;
      });
      assert.equal(injected, 1);
      assert.equal(actualReadAttempts, 1, 'verification must fail instead of reading again to retry the write');
      mock.mock.restore();

      // Observe the adversarial state before any explicit recovery. A hidden
      // rollback/retry would replace or recreate this state and fail these checks.
      if (fault === 'rewrite' || fault === 'truncate') {
        const actual = await readFile(target), expected = fault === 'rewrite' ? corrupted : Buffer.alloc(0);
        assert.deepEqual(actual, expected);
        assert.deepEqual(Buffer.from(observedBytes!), expected);
        assert.equal(observedSha256, digest(expected));
        assert.equal(readerError, undefined);
      } else if (fault === 'delete') {
        await assert.rejects(stat(target), { code: 'ENOENT' });
        assert.equal(readerError, 'ENOENT');
      } else {
        const targetStat = await stat(target), donorStat = await stat(donor);
        assert.equal(targetStat.ino, donorStat.ino);
        assert.equal(targetStat.dev, donorStat.dev);
        assert.equal(targetStat.nlink, 2);
        assert.deepEqual(await readFile(donor), intended);
        assert.equal(readerError, 'UNSAFE_LINK', 'identical bytes still must not allow a hard-link target');
      }

      if (mode === 'overwrite') {
        const backups = await f.store.backups(f.scope);
        assert.equal(backups.total, 1);
        const recovery = backups.items[0];
        assert.equal(recovery.path, target);
        assert.equal(recovery.sha256, digest(original));
        assert.deepEqual(await readFile(join(f.backupRoot, `${recovery.id}.bin`)), original);
        assert.ok(failureMessage.includes(recovery.id));

        if (fault === 'hard link') {
          await assert.rejects(f.store.restore(f.scope, recovery.id, { expectedSha256: digest(intended), backupPolicy }), { code: 'UNSAFE_LINK' });
          // Explicit test-owned cleanup only: remove this alias, never its donor.
          await unlink(target);
        }
        const options = fault === 'delete' || fault === 'hard link'
          ? { createOnly: true, backupPolicy }
          : { expectedSha256: digest(await readFile(target)), backupPolicy };
        const restored = await f.store.restore(f.scope, recovery.id, options);
        assert.equal(restored.outcome, 'restored');
        assert.equal(restored.verified, true);
        assert.deepEqual(await readFile(target), original);
        if (fault === 'hard link') {
          assert.deepEqual(await readFile(donor), intended);
          assert.equal((await stat(donor)).nlink, 1);
        }
      } else {
        await assert.rejects(stat(f.backupRoot), { code: 'ENOENT' });
      }
      const next = await f.store.write(f.scope, 'after-failure.txt', Buffer.from('queue still usable'), { createOnly: true, backupPolicy });
      assert.equal(next.verified, true);
      assert.ok(!(await readdir(f.workspace)).some(name => name.startsWith('.computer-write-')));
    });
  }
}

const contents = [
  { name: 'empty', original: Buffer.alloc(0), changed: Buffer.from([0]) },
  { name: 'binary', original: Buffer.from([0xff, 0, 0x80, 0xfe]), changed: Buffer.from([0xfe, 0, 0x80, 0xfe]) },
  { name: 'Unicode', original: Buffer.from('é😀中文\r\n'), changed: Buffer.from('e\u0301😀中文\r\n') },
];
for (const content of contents) {
  test(`${content.name}: unchanged means equal bytes and still requires the current digest`, async t => {
    const f = await fixture(t), target = join(f.workspace, 'bytes.bin'), sha256 = digest(content.original);
    const created = await f.store.write(f.scope, target, content.original, { createOnly: true, backupPolicy });
    assert.equal(created.verified, true);
    const before = await stat(target, { bigint: true });
    const unchanged = await f.store.write(f.scope, target, Buffer.from(content.original), { expectedSha256: sha256, backupPolicy });
    assert.equal(unchanged.outcome, 'unchanged');
    assert.equal(unchanged.verified, true);
    assert.equal(unchanged.sha256, sha256);
    assert.equal(unchanged.bytes, content.original.byteLength);
    assert.equal(unchanged.backupId, undefined);
    const after = await stat(target, { bigint: true });
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeNs, before.mtimeNs);
    for (const options of [{}, { expectedSha256: digest(Buffer.from('stale synthetic version')) }, { createOnly: true, expectedSha256: sha256 }]) {
      await assert.rejects(f.store.write(f.scope, target, Buffer.from(content.original), { ...options, backupPolicy }), { code: 'CONFLICT' });
    }
    assert.deepEqual(await readFile(target), content.original);
    await assert.rejects(stat(f.backupRoot), { code: 'ENOENT' });

    const changed = await f.store.write(f.scope, target, content.changed, { expectedSha256: sha256, backupPolicy });
    assert.equal(changed.outcome, 'updated');
    assert.equal(changed.verified, true);
    assert.equal(changed.sha256, digest(content.changed));
    assert.equal(changed.bytes, content.changed.byteLength);
    assert.deepEqual(await readFile(target), content.changed);
    assert.deepEqual(await readFile(join(f.backupRoot, `${changed.backupId}.bin`)), content.original);
    const stable = await f.store.write(f.scope, target, Buffer.from(content.changed), { expectedSha256: changed.sha256, backupPolicy });
    assert.equal(stable.outcome, 'unchanged');
    assert.equal((await f.store.backups(f.scope)).total, 1);
  });
}
