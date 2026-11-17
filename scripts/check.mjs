/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
const sdk = resolve(process.env.WHALELIFE_SDK ?? join(root, '../whalelife'));
if (!existsSync(join(sdk, 'core/context.ts'))) throw Error('Set WHALELIFE_SDK to the supported WhaleLife source checkout.');
mkdirSync(join(root, '.artifacts'), { recursive: true });
const project = join(root, '.artifacts/typecheck.json');
writeFileSync(project, JSON.stringify({ extends: '../tsconfig.json', compilerOptions: {
  paths: { whalelife: [join(sdk, 'core/context.ts')] },
}, include: ['../index.ts', '../src/**/*.ts', '../tests/**/*.ts'] }, null, 2));
const result = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--project', project], { cwd: root, stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
