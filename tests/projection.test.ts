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

test('truncated content retains verified no-op results without implying a new write', () => {
  const result: TaskResult = { id: 'synthetic-task', state: 'completed', steps: [
    { action: 'read', ok: true, result: { text: '合成正文'.repeat(20000) } },
    { action: 'write', ok: true, result: { path: 'same.txt', outcome: 'unchanged', verified: true, bytes: 4, sha256: 'a'.repeat(64) } },
    { action: 'execute', ok: true, result: { status: 'completed', exitCode: 0, outputsImported: true,
      saved: [{ path: 'same.txt', outcome: 'unchanged', verified: true }, { path: 'new.txt', outcome: 'created', verified: true }] } },
  ] };
  const projection = toolProjection(result);
  assert.deepEqual(projection.steps[1].result, result.steps[1].result);
  assert.deepEqual(projection.steps[2].result, result.steps[2].result);
  assert.ok(Buffer.byteLength(JSON.stringify(projection)) <= 56000);
});

test('oversized output paths preserve positions of unchanged outputs and verification failure', () => {
  const saved = Array.from({ length: 16 }, (_, index) => ({ path: '合成路径'.repeat(1000) + index,
    outcome: index % 2 ? 'created' : 'unchanged', verified: true }));
  const result: TaskResult = { id: 'synthetic-task', state: 'failed', steps: [
    { action: 'write', ok: true, result: { path: '合成路径'.repeat(1000), outcome: 'unchanged', verified: true } },
    { action: 'execute', ok: false, result: { status: 'completed', exitCode: 0, saved,
      outputsImported: false, importError: '写入后未能核验最终文件，目标可能已改变；请先读取核对，不要自动重试。' } },
  ] };
  const projection = toolProjection(result), evidence = projection.steps[1].result as Record<string, unknown>;
  assert.equal((projection.steps[0].result as Record<string, unknown>).verified, true);
  assert.equal((projection.steps[0].result as Record<string, unknown>).outcome, 'unchanged');
  assert.equal(evidence.savedCount, 16);
  assert.equal(evidence.unchangedCount, 8);
  assert.deepEqual(evidence.unchangedOutputs, [1, 3, 5, 7, 9, 11, 13, 15]);
  assert.equal(evidence.outputsImported, false);
  assert.equal(evidence.importError, (result.steps[1].result as Record<string, unknown>).importError);
  assert.equal(projection.state, 'failed');
  assert.ok(Buffer.byteLength(JSON.stringify(projection)) <= 56000);
});
