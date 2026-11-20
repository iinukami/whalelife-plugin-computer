/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { mkdirSync, existsSync, lstatSync, realpathSync, rmSync, cpSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
if (process.platform !== 'win32' || Number(process.versions.node.split('.')[0]) < 24) throw Error('Build requires Windows and Node 24.');
const csc = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
const compile = spawnSync(csc, ['/nologo', '/target:exe', '/platform:x64', '/optimize+', '/reference:System.Web.Extensions.dll', '/out:native\\SandboxRunner.exe', 'native\\SandboxRunner.cs'], { cwd: root, stdio: 'inherit', windowsHide: true });
if (compile.error) throw compile.error;
if (compile.status !== 0) throw Error('Native sandbox compilation failed.');
const dist = join(root, 'dist'), out = join(dist, 'computer');
mkdirSync(dist, { recursive: true });
if (lstatSync(dist).isSymbolicLink() || resolve(realpathSync(dist)).toLowerCase() !== dist.toLowerCase()) throw Error('Unsafe build root.');
if (existsSync(out)) {
  if (dirname(out) !== dist || lstatSync(out).isSymbolicLink() || resolve(realpathSync(out)).toLowerCase() !== out.toLowerCase() ||
    !existsSync(join(out, 'BUILD.json')) || existsSync(join(out, 'data'))) throw Error('Refusing to overwrite unowned build output.');
  rmSync(out, { recursive: true });
}
mkdirSync(out);
for (const file of ['src', 'native', 'index.ts', 'plugin.yaml', 'package.json', 'README.md', 'CONTRACT.md', 'LICENSE', 'LICENSE-ADDITIONAL', 'NOTICE.md', 'THIRD_PARTY_NOTICES.md'])
  cpSync(join(root, file), join(out, file), { recursive: true });
const files = {};
function visit(directory) {
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isSymbolicLink()) throw Error('Build contains a link.');
    if (item.isDirectory()) visit(path);
    else files[relative(out, path).replaceAll('\\', '/')] = createHash('sha256').update(readFileSync(path)).digest('hex');
  }
}
visit(out);
writeFileSync(join(out, 'BUILD.json'), JSON.stringify({ package: 'whalelife-plugin-computer', version: '0.1.2', node: process.version, platform: process.platform, arch: process.arch, files }, null, 2) + '\n');
console.log(`Built ${Object.keys(files).length} files in dist/computer.`);
