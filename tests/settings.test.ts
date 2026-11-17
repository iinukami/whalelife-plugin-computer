/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaults, SettingsStore, validateSettings } from '../src/settings.ts';

test('settings deny every capability by default and reject unsafe paths or unknown grants', () => {
  const value = defaults('D:\\synthetic\\workspace');
  assert.ok(Object.values(value.grants).every(v => v === false));
  for (const workspace of ['\\\\server\\share', 'D:\\', 'D:\\test\\..\\private', 'D:\\file:stream', 'relative', 'D:\\trailing.', 'D:\\aux', 'D:\\safe\\COM1'])
    assert.throws(() => validateSettings({ ...value, workspace }));
  assert.throws(() => validateSettings({ ...value, grants: { ...value.grants, unrestricted: true } }));
});

test('settings conflicts and persistence failure do not silently change authorization', async () => {
  let fail = false, persisted: unknown;
  const store = await SettingsStore.load('D:\\synthetic\\workspace', {}, async row => { if (fail) throw Error('synthetic save failure'); persisted = row; });
  const before = store.snapshot();
  before.settings.grants.write = true;
  assert.equal(store.snapshot().settings.grants.write, false);
  await store.save(0, before.settings);
  assert.ok(persisted); assert.equal(store.snapshot().settings.grants.write, true);
  await assert.rejects(() => store.save(0, before.settings), /其他窗口/);
  fail = true; const next = store.snapshot(); next.settings.grants.write = false;
  await assert.rejects(() => store.save(next.revision, next.settings), /synthetic/);
  assert.equal(store.snapshot().settings.grants.write, true);
});
