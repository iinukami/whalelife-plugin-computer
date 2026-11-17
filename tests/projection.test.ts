/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { toolProjection } from '../src/index.ts';
import type { TaskResult } from '../src/types.ts';

test('large transient results keep confirmed partial imports and cleanup failures', () => {
  const saved = [{ path: 'synthetic-output.txt', outcome: 'created', sha256: 'a'.repeat(64) }];
  const result: TaskResult = { id: 'synthetic-task', state: 'failed', steps: [
    { action: 'read', ok: true, result: { text: '合成正文'.repeat(20000) } },
    { action: 'execute', ok: false, result: { status: 'completed', exitCode: 0, saved,
      outputsImported: false, importError: 'synthetic conflict', cleanupError: 'synthetic cleanup failure' } },
  ] };
  const projection = toolProjection(result);
  const evidence = projection.steps[1].result as Record<string, unknown>;
  assert.deepEqual(evidence.saved, saved);
  assert.equal(evidence.importError, 'synthetic conflict');
  assert.equal(evidence.cleanupError, 'synthetic cleanup failure');
  assert.equal(projection.state, 'failed');
  assert.ok(Buffer.byteLength(JSON.stringify(projection)) < 56000);
  assert.ok(!JSON.stringify(projection).includes('合成正文'));
});

test('oversized path metadata is bounded while preserving how many outputs were saved', () => {
  const saved = Array.from({ length: 16 }, (_, index) => ({ path: '合成路径'.repeat(1000) + index, outcome: 'created' }));
  const result: TaskResult = { id: 'synthetic-task', state: 'failed', steps: [{ action: 'execute', ok: false,
    result: { status: 'completed', exitCode: 0, saved, outputsImported: false, importError: 'synthetic conflict' } }] };
  const projection = toolProjection(result), evidence = projection.steps[0].result as Record<string, unknown>;
  assert.equal(evidence.savedCount, 16);
  assert.equal(evidence.outputsImported, false);
  assert.equal(evidence.importError, 'synthetic conflict');
  assert.equal(projection.state, 'failed');
  assert.ok(Buffer.byteLength(JSON.stringify(projection)) < 56000);
});
