/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
const base = fileURLToPath(new URL('../.artifacts/tests/', import.meta.url));
export async function temporaryDirectory(t: Pick<TestContext, 'after'>): Promise<string> {
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(resolve(base, 'case-'));
  t.after(async () => {
    const realBase = await realpath(base), realRoot = await realpath(root);
    const rel = relative(realBase, realRoot);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Unsafe test cleanup path');
    await rm(realRoot, { recursive: true, force: true });
  });
  return root;
}
