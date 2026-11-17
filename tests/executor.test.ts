/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, readdir, writeFile, access, copyFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WindowsExecutor, type ExecuteRequest } from '../src/executor.ts';
import { temporaryDirectory } from './temporary-directory.ts';

const native = process.platform === 'win32' && process.env.WHALELIFE_NATIVE_TESTS === '1';
const nativeOptions = { skip: native ? false : 'Set WHALELIFE_NATIVE_TESTS=1 for explicitly authorized isolated Windows fixtures.' };
const runFile = promisify(execFile);
const request = (cwd: string, code: string, more: Partial<ExecuteRequest> = {}): ExecuteRequest => ({
  runtime: 'node', cwd, code, timeoutMs: 10_000, maxOutputBytes: 16_384, ...more,
});

test('executor rejects missing helper without invoking an unrestricted fallback', async (t) => {
  const root = await temporaryDirectory(t);
  const executor = new WindowsExecutor({ scratchRoot: root, helperPath: path.join(root, 'absent.exe') });
  assert.equal((await executor.probe()).available, false);
  const result = await executor.execute(request(path.join(root, 'task'), 'throw new Error("must never run")'));
  assert.equal(result.status, 'unavailable');
  assert.equal(result.exitCode, null);
  assert.deepEqual(await readdir(root), []);
});

test('executor rejects invalid limits and pre-cancelled work before creating resources', async (t) => {
  const root = await temporaryDirectory(t);
  const executor = new WindowsExecutor({ scratchRoot: root });
  for (const extra of [{ timeoutMs: 0 }, { timeoutMs: 300_001 }, { maxOutputBytes: 262_145 }, { code: '\0' }]) {
    assert.equal((await executor.execute(request(root, '1', extra))).status, 'failed');
  }
  assert.equal((await executor.execute(request(root, '1', { signal: AbortSignal.abort() }))).status, 'cancelled');
  assert.deepEqual(await readdir(root), []);
});

test('native broker returns actual exit code, Unicode output and task output without deleting cwd', nativeOptions, async (t) => {
  const root = await temporaryDirectory(t), cwd = path.join(root, 'task');
  await mkdir(cwd);
  const executor = new WindowsExecutor({ scratchRoot: root });
  const result = await executor.execute(request(cwd, 'require("node:fs").writeFileSync("result.txt","合成结果"); console.log("中文输出"); console.error("诊断"); process.exitCode=7;'));
  assert.equal(result.status, 'completed', result.reason);
  assert.equal(result.exitCode, 7, JSON.stringify(result));
  assert.match(result.stdout, /中文输出/); assert.match(result.stderr, /诊断/);
  assert.equal(await readFile(path.join(cwd, 'result.txt'), 'utf8'), '合成结果');
  assert.deepEqual(await readdir(root), ['task']);
});

test('native broker denies files outside snapshot and denies loopback for parent and descendant', nativeOptions, async (t) => {
  const root = await temporaryDirectory(t), scratch = path.join(root, 'scratch'), cwd = path.join(scratch, 'task');
  await mkdir(cwd, { recursive: true });
  const canary = path.join(root, 'private-canary.txt');
  await writeFile(canary, 'synthetic-private-value');
  let connections = 0;
  const server = createServer((socket) => { connections++; socket.destroy(); });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const childCode = `const net=require('node:net'); const s=net.connect(${address.port},'127.0.0.1'); s.on('connect',()=>{console.log('CONNECTED');s.destroy();process.exitCode=10});s.on('error',e=>console.log(e.code));s.setTimeout(1500,()=>{console.log('TIMEOUT');s.destroy()});`;
  const code = `const fs=require('node:fs');for(const op of ['read','write']){try{if(op==='read')fs.readFileSync(${JSON.stringify(canary)});else fs.writeFileSync(${JSON.stringify(canary)},'changed');console.log(op+':UNEXPECTED')}catch(e){console.log(op+':'+e.code)}}
    ${childCode}
    const child=require('node:child_process').spawnSync(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'inherit',timeout:5000});console.log('child-status:'+child.status);`;
  const result = await new WindowsExecutor({ scratchRoot: scratch }).execute(request(cwd, code));
  assert.equal(result.status, 'completed', result.reason);
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.match(result.stdout, /read:(EACCES|EPERM)/); assert.match(result.stdout, /write:(EACCES|EPERM)/);
  assert.match(result.stdout, /child-status:0/);
  assert.equal((result.stdout.match(/EACCES|EPERM/g) ?? []).length, 4);
  assert.doesNotMatch(result.stdout, /CONNECTED|UNEXPECTED|TIMEOUT/);
  assert.equal(connections, 0);
  assert.equal(await readFile(canary, 'utf8'), 'synthetic-private-value');
  assert.deepEqual(await readdir(scratch), ['task']);
});

test('native broker drains output with a bounded combined byte budget', nativeOptions, async (t) => {
  const root = await temporaryDirectory(t), cwd = path.join(root, 'task'); await mkdir(cwd);
  const result = await new WindowsExecutor({ scratchRoot: root }).execute(request(cwd,
    'for(let i=0;i<2000;i++){process.stdout.write("o".repeat(1024));process.stderr.write("e".repeat(1024));}', { maxOutputBytes: 4096 }));
  assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 4096);
});

test('native broker denies public-route TEST-NET sockets and private HKCU canary', nativeOptions, async (t) => {
  const root = await temporaryDirectory(t), cwd = path.join(root, 'task'); await mkdir(cwd);
  const key = `HKCU\\Software\\WhaleLifeFixture-${randomUUID()}`;
  const reg = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
  let created = false;
  t.after(async () => { if (created) await runFile(reg, ['delete', key, '/f'], { windowsHide: true }); });
  await runFile(reg, ['add', key, '/v', 'fixture', '/t', 'REG_SZ', '/d', 'synthetic-private-value', '/f'], { windowsHide: true });
  created = true;
  const childCode = `const s=require('node:net').connect(9,'192.0.2.1');s.on('connect',()=>{console.log('CONNECTED');s.destroy();process.exitCode=9});s.on('error',e=>console.log(e.code));s.setTimeout(1500,()=>{console.log('TIMEOUT');s.destroy()});`;
  const code = `const cp=require('node:child_process');const r=cp.spawnSync(${JSON.stringify(reg)},['query',${JSON.stringify(key)},'/v','fixture'],{stdio:'inherit',timeout:2000});console.log('registry-status:'+r.status);
    const child=cp.spawnSync(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'inherit',timeout:5000});console.log('child-status:'+child.status);
    ${childCode}`;
  const result = await new WindowsExecutor({ scratchRoot: root }).execute(request(cwd, code));
  assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.match(result.stdout, /registry-status:1/); assert.doesNotMatch(result.stdout, /synthetic-private-value/);
  assert.match(result.stdout, /child-status:0/); assert.equal((result.stdout.match(/EACCES|EPERM/g) ?? []).length, 2);
  assert.doesNotMatch(result.stdout, /CONNECTED|TIMEOUT/);
  const original = await runFile(reg, ['query', key, '/v', 'fixture'], { windowsHide: true });
  assert.match(original.stdout, /synthetic-private-value/);
});

test('native broker timeout kills descendants and stops their writes', nativeOptions, async (t) => {
  const root = await temporaryDirectory(t), cwd = path.join(root, 'task'); await mkdir(cwd);
  const childCode = 'const fs=require("node:fs");setInterval(()=>fs.appendFileSync("heartbeat.txt","x"),50)';
  const result = await new WindowsExecutor({ scratchRoot: root }).execute(request(cwd,
    `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'inherit'});setInterval(()=>{},50);`, { timeoutMs: 1500 }));
  assert.equal(result.status, 'timeout', result.reason); assert.equal(result.exitCode, null);
  const first = await readFile(path.join(cwd, 'heartbeat.txt'), 'utf8'); assert.ok(first.length > 0);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(await readFile(path.join(cwd, 'heartbeat.txt'), 'utf8'), first);
  assert.deepEqual(await readdir(root), ['task']);
});

test('native broker explicit cancellation preserves completed outputs and cleans owned runtime', nativeOptions, async (t) => {
  const root = await temporaryDirectory(t), cwd = path.join(root, 'task'); await mkdir(cwd);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1000); t.after(() => clearTimeout(timer));
  const result = await new WindowsExecutor({ scratchRoot: root }).execute(request(cwd,
    'require("node:fs").writeFileSync("started.txt","started");setInterval(()=>{},100);', { signal: controller.signal }));
  assert.equal(result.status, 'cancelled', result.reason); assert.equal(result.exitCode, null);
  await access(path.join(cwd, 'started.txt'));
  assert.deepEqual(await readdir(root), ['task']);
});

test('native executor rejects a cwd outside its owned scratch root', nativeOptions, async (t) => {
  const root = await temporaryDirectory(t), scratch = path.join(root, 'scratch'), other = path.join(root, 'other');
  await mkdir(scratch); await mkdir(other);
  const result = await new WindowsExecutor({ scratchRoot: scratch }).execute(request(other, 'console.log("must not run")'));
  assert.equal(result.status, 'failed'); assert.match(result.reason ?? '', /inside.*scratch root/);
  assert.deepEqual(await readdir(scratch), []);
});

test('PowerShell stays isolated or returns an explicit availability failure', nativeOptions, async (t) => {
  const root = await temporaryDirectory(t), cwd = path.join(root, 'task'); await mkdir(cwd);
  const result = await new WindowsExecutor({ scratchRoot: root }).execute(request(cwd,
    '[IO.File]::WriteAllText((Join-Path (Get-Location) "powershell.txt"), "fixture"); Write-Output "powershell-fixture"', { runtime: 'powershell' }));
  if (result.status === 'completed' && result.exitCode === 0) {
    assert.match(result.stdout, /powershell-fixture/);
    assert.equal(await readFile(path.join(cwd, 'powershell.txt'), 'utf8'), 'fixture');
  } else {
    assert.ok(['completed', 'unavailable', 'failed'].includes(result.status), result.reason);
    assert.ok(result.reason || result.exitCode !== 0 || result.stderr);
    t.diagnostic(`PowerShell under LPAC unavailable: ${result.reason ?? `exit ${result.exitCode}`}`);
  }
  assert.deepEqual(await readdir(root), ['task']);
});

async function faultFixture(t: Parameters<typeof temporaryDirectory>[0], symbols = 'WHALELIFE_TEST_FAULTS') {
  const root = await temporaryDirectory(t), cwd = path.join(root, 'task'), runtimeDirectory = path.join(root, 'runtime');
  await mkdir(cwd); await mkdir(runtimeDirectory);
  const helperPath = path.join(root, 'SandboxRunner.test.exe');
  const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  await runFile(compiler, ['/nologo', '/target:exe', '/platform:x64', '/optimize+', '/reference:System.Web.Extensions.dll',
    `/define:${symbols}`, `/out:${helperPath}`, 'native\\SandboxRunner.cs'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), windowsHide: true,
  });
  const executable = path.join(runtimeDirectory, 'node.exe'); await copyFile(process.execPath, executable);
  return { root, cwd, helperPath, envelope: { root, cwd, runtimeDirectory, executable,
    arguments: ['-e', 'console.log("synthetic fixture")'], timeoutMs: 3000, maxOutputBytes: 4096 } };
}

function rawFixture(helper: string, envelope: object): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn(helper, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let text = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('Fixture helper timed out')); }, 15_000);
    child.stdin.on('error', () => {}); child.stderr.resume();
    child.stdout.on('data', (data: Buffer) => { text += data.toString('utf8'); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', () => { clearTimeout(timer); try { resolve(JSON.parse(text.trim()) as Record<string, unknown>); } catch (error) { reject(error); } });
    child.stdin.write(`${JSON.stringify(envelope)}\n`);
  });
}

async function cleanFixtureProfile(helper: string, profileId: unknown): Promise<void> {
  assert.equal(typeof profileId, 'string'); assert.match(profileId as string, /^WhaleLife\.Computer\.[0-9a-f]{32}$/);
  const cleanup = await rawFixture(helper, { testCleanupProfile: profileId });
  assert.equal(cleanup.testCleanup, true, `Synthetic profile cleanup failed: ${profileId}`);
}

test('native creation-time Job kills an unresumed child when its broker dies', nativeOptions, async (t) => {
  const fixture = await faultFixture(t);
  let profileId: unknown, pid = 0;
  const broker = spawn(fixture.helperPath, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  broker.stdin.on('error', () => {}); broker.stderr.resume();
  const exited = new Promise<void>((resolve) => broker.on('close', () => resolve()));
  try {
    const marker = new Promise<Record<string, unknown>>((resolve, reject) => {
      let text = ''; const timer = setTimeout(() => reject(new Error('Creation marker did not arrive')), 10_000);
      broker.on('error', (error) => { clearTimeout(timer); reject(error); });
      broker.stdout.on('data', (chunk: Buffer) => {
        text += chunk.toString('utf8');
        if (text.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(text.split('\n')[0]!) as Record<string, unknown>); } catch (error) { reject(error); } }
      });
    });
    broker.stdin.write(`${JSON.stringify({ ...fixture.envelope, testFault: 'pause-after-create' })}\n`);
    const stage = await marker;
    assert.equal(stage.testStage, 'created'); profileId = stage.profileId; pid = Number(stage.pid);
    assert.ok(Number.isInteger(pid) && pid > 0);
    assert.equal(broker.kill(), true); await exited;
    let gone = false;
    for (let i = 0; i < 100; i++) {
      try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') { gone = true; break; } throw error; }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(gone, true, 'A suspended task survived broker termination.');
  } finally {
    if (broker.exitCode === null && broker.signalCode === null) broker.kill();
    await exited;
    if (profileId) await cleanFixtureProfile(fixture.helperPath, profileId);
  }
});

test('native output-thread startup failure still deletes the owned profile', nativeOptions, async (t) => {
  const fixture = await faultFixture(t);
  const result = await rawFixture(fixture.helperPath, { ...fixture.envelope, testFault: 'thread-start' });
  try {
    assert.equal(result.status, 'failed');
    assert.equal(result.profileDeleted, true, JSON.stringify(result));
    assert.match(String(result.reason), /Injected output thread startup failure/);
    assert.doesNotMatch(String(result.reason), /Invalid execution request/);
  } finally {
    if (result.profileId && result.profileDeleted !== true) await cleanFixtureProfile(fixture.helperPath, result.profileId);
  }
});

test('executor exposes the exact owned profile when profile cleanup fails', nativeOptions, async (t) => {
  const fixture = await faultFixture(t, 'WHALELIFE_TEST_FAULTS;WHALELIFE_TEST_PROFILE_CLEANUP_FAILURE');
  const executor = new WindowsExecutor({ scratchRoot: fixture.root, helperPath: fixture.helperPath });
  const result = await executor.execute(request(fixture.cwd, 'console.log("synthetic cleanup failure")'));
  const profileId = result.reason?.match(/WhaleLife\.Computer\.[0-9a-f]{32}/)?.[0];
  try {
    assert.equal(result.status, 'failed'); assert.match(result.reason ?? '', /cleanup was incomplete or unverified/);
    assert.ok(profileId, JSON.stringify(result));
  } finally { if (profileId) await cleanFixtureProfile(fixture.helperPath, profileId); }
});
