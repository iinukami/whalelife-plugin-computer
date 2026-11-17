/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './temporary-directory.ts';
import { FileStore } from '../src/files.ts';
import { ComputerEngine } from '../src/engine.ts';
import { SettingsStore, defaults } from '../src/settings.ts';
import { ComputerError, type ComputerSettings, type FileOperation, type FileScope, type TaskOrigin } from '../src/types.ts';
import type { ExecuteRequest, ExecuteResult } from '../src/executor.ts';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return {promise,resolve};
}
const web = async (): Promise<TaskOrigin> => ({kind:'web',sessionId:'session-fixture'});
const success = (): ExecuteResult => ({status:'completed',exitCode:0,stdout:'fixture output',stderr:'',truncated:false,elapsedMs:1});
const execution = (extra: Partial<Extract<FileOperation,{action:'execute'}>> = {}): FileOperation => ({action:'execute',runtime:'node',code:'fixture code is never executed',...extra});
const create = (path: string, text = 'fixture'): FileOperation => ({action:'write',path,text,createOnly:true});
const windows = {skip:process.platform !== 'win32',timeout:10000};

async function fixture(t: TestContext, execute: (request: ExecuteRequest) => Promise<ExecuteResult> = async () => success()) {
  const root = await temporaryDirectory(t), workspace = join(root,'workspace'), outside = join(root,'outside');
  const scratch = join(root,'scratch'), protectedRoot = join(root,'protected');
  await Promise.all([workspace,outside,scratch,protectedRoot].map(path => mkdir(path)));
  const initial = defaults(workspace);
  Object.assign(initial.grants,{read:true,write:true,execute:true,delete:true,restore:true});
  const settings = new SettingsStore(initial,async () => {});
  const files = new FileStore({backupRoot:join(root,'backups')});
  const calls: ExecuteRequest[] = [], deliveries: {path:string;scope:FileScope;sessionId:string}[] = [];
  const engine = new ComputerEngine({settings,files,scratchRoot:scratch,trustedWorkspace:workspace,protectedRoots:[protectedRoot],executor:{async execute(request) { calls.push(request); return execute(request); }},download:async (path,scope,sessionId) => {
    // Read through the same real broker to verify delivery has no scope bypass.
    await files.readBytes(scope,path); deliveries.push({path,scope,sessionId}); return {name:path,url:'/plugins/computer/download/fixture'};
  }});
  return {root,workspace,outside,scratch,protectedRoot,settings,files,engine,calls,deliveries};
}
async function update(settings: SettingsStore, change: (value: ComputerSettings) => void) {
  const snapshot = settings.snapshot(); change(snapshot.settings); await settings.save(snapshot.revision,snapshot.settings);
}
async function absent(path: string) { await assert.rejects(readFile(path),{code:'ENOENT'}); }

test('started batch retains grants while a queued new task observes their revocation',windows,async t => {
  const entered = deferred(), release = deferred();
  const env = await fixture(t,async () => { entered.resolve(); await release.promise; return success(); });
  const first = env.engine.run([execution(),create('old-batch.txt')],web);
  await entered.promise;
  const queued = env.engine.run([create('new-task.txt')],web);
  // Attach a rejection observer before releasing the queue.
  const denied = assert.rejects(queued,(error: unknown) => error instanceof ComputerError && error.code === 'permission');
  try { await update(env.settings,value => { value.grants.write = false; value.grants.execute = false; }); }
  finally { release.resolve(); }
  const result = await first; await denied;
  assert.equal(result.state,'completed'); assert.equal(result.steps.length,2);
  assert.equal(await readFile(join(env.workspace,'old-batch.txt'),'utf8'),'fixture');
  await absent(join(env.workspace,'new-task.txt')); assert.equal(env.calls.length,1);
  assert.deepEqual(await readdir(env.scratch),[]);
  assert.equal(env.engine.tasks().length,1);
});

test('revocation during asynchronous source verification prevents a not-yet-started task',windows,async t => {
  const entered = deferred(), release = deferred(); let verifications = 0;
  const env = await fixture(t);
  const running = env.engine.run([create('must-not-start.txt')],async () => {
    verifications++; if (verifications === 1) { entered.resolve(); await release.promise; } return web();
  });
  const denied = assert.rejects(running,(error: unknown) => error instanceof ComputerError && error.code === 'permission');
  await entered.promise;
  try { await update(env.settings,value => { value.grants.write = false; }); }
  finally { release.resolve(); }
  await denied; await absent(join(env.workspace,'must-not-start.txt'));
  assert.equal(env.engine.tasks().length,0);
});

test('a running batch keeps its directory snapshot; following tasks use the updated directory',windows,async t => {
  const entered = deferred(), release = deferred();
  const env = await fixture(t,async () => { entered.resolve(); await release.promise; return success(); });
  const first = env.engine.run([execution(),create('same-name.txt','old scope')],web); await entered.promise;
  const second = env.engine.run([create('same-name.txt','new scope')],web);
  try { await update(env.settings,value => { value.workspace = env.outside; }); }
  finally { release.resolve(); }
  assert.equal((await first).state,'completed'); assert.equal((await second).state,'completed');
  assert.equal(await readFile(join(env.workspace,'same-name.txt'),'utf8'),'old scope');
  assert.equal(await readFile(join(env.outside,'same-name.txt'),'utf8'),'new scope');
  assert.notEqual(env.engine.tasks()[0].id,env.engine.tasks()[1].id);
});

test('nonzero exit and failed, unavailable or cancelled commands never report success or import files',windows,async t => {
  let reply: ExecuteResult = {...success(),exitCode:3};
  const env = await fixture(t,async request => { await writeFile(join(request.cwd,'output.txt'),'must not import'); return reply; });
  const cases: ExecuteResult[] = [reply,{...success(),status:'failed',exitCode:0},{...success(),status:'unavailable',exitCode:null},{...success(),status:'cancelled',exitCode:null},{...success(),status:'timeout',exitCode:null}];
  for (const [index,candidate] of cases.entries()) {
    reply = candidate;
    const result = await env.engine.run([execution({outputs:[{name:'output.txt',path:'output-' + index + '.txt',createOnly:true}]}),create('after-' + index + '.txt')],web);
    assert.notEqual(result.state,'completed'); assert.equal(result.steps.length,1); assert.equal(result.steps[0].ok,false);
    const evidence = result.steps[0].result as ExecuteResult & {saved:unknown[];outputsImported:boolean};
    assert.equal(evidence.status,candidate.status); assert.equal(evidence.exitCode,candidate.exitCode); assert.equal(evidence.stdout,'fixture output');
    assert.deepEqual(evidence.saved,[]); assert.equal(evidence.outputsImported,false);
    await absent(join(env.workspace,'output-' + index + '.txt')); await absent(join(env.workspace,'after-' + index + '.txt'));
    assert.deepEqual(await readdir(env.scratch),[]);
  }
});

test('partial output import preserves confirmed saved files and leaves the conflicting file unchanged',windows,async t => {
  const env = await fixture(t,async request => {
    await writeFile(join(request.cwd,'first.txt'),'first output'); await writeFile(join(request.cwd,'second.txt'),'second output'); return success();
  });
  await writeFile(join(env.workspace,'conflict.txt'),'existing content');
  const result = await env.engine.run([execution({outputs:[{name:'first.txt',path:'saved.txt',createOnly:true},{name:'second.txt',path:'conflict.txt',createOnly:true}]}),create('after.txt')],web);
  assert.equal(result.state,'failed'); assert.equal(result.steps[0].ok,false); assert.equal(result.steps.length,1);
  const evidence = result.steps[0].result as ExecuteResult & {saved:{path:string}[];outputsImported:boolean;importError?:string};
  assert.equal(evidence.exitCode,0); assert.equal(evidence.stdout,'fixture output'); assert.equal(evidence.saved.length,1);
  assert.equal(evidence.saved[0].path,join(env.workspace,'saved.txt')); assert.equal(evidence.outputsImported,false); assert.ok(evidence.importError);
  assert.equal(await readFile(join(env.workspace,'saved.txt'),'utf8'),'first output');
  assert.equal(await readFile(join(env.workspace,'conflict.txt'),'utf8'),'existing content');
  await absent(join(env.workspace,'after.txt')); assert.deepEqual(await readdir(env.scratch),[]);
});

test('file, execution input/output and download paths all use the same scope and protected roots',windows,async t => {
  const env = await fixture(t,async request => { await writeFile(join(request.cwd,'output.txt'),'generated'); return success(); });
  const outsideFile = join(env.outside,'outside.txt'), protectedFile = join(env.protectedRoot,'private-fixture.txt');
  await writeFile(outsideFile,'outside fixture'); await writeFile(protectedFile,'protected fixture');
  const scoped: FileOperation[][] = [
    [{action:'read',path:outsideFile}], [{action:'deliver',path:outsideFile}],
    [execution({inputs:[{path:outsideFile,name:'input.txt'}]})],
    [execution({outputs:[{name:'output.txt',path:join(env.outside,'new.txt'),createOnly:true}]})],
  ];
  for (const operations of scoped) assert.equal((await env.engine.run(operations,web)).state,'failed');
  await absent(join(env.outside,'new.txt')); assert.equal(env.deliveries.length,0);
  // Relaxing the directory setting permits ordinary outside files, but not host data.
  await update(env.settings,value => { value.scope = 'all'; });
  assert.equal((await env.engine.run([{action:'read',path:outsideFile}],web)).state,'completed');
  assert.equal((await env.engine.run([{action:'read',path:protectedFile}],web)).state,'failed');
  assert.equal((await env.engine.run([execution({inputs:[{path:protectedFile,name:'input.txt'}]})],web)).state,'failed');
  assert.deepEqual(await readdir(env.scratch),[]);
});

test('only explicitly staged input files reach executor; successful output import keeps source untouched',windows,async t => {
  let staged = '';
  const env = await fixture(t,async request => {
    staged = await readFile(join(request.cwd,'data.txt'),'utf8');
    assert.deepEqual(await readdir(request.cwd),['data.txt']);
    await writeFile(join(request.cwd,'result.txt'),staged.toUpperCase()); return success();
  });
  await writeFile(join(env.workspace,'source.txt'),'source content'); await writeFile(join(env.workspace,'unlisted.txt'),'not staged');
  const result = await env.engine.run([execution({inputs:[{path:'source.txt',name:'data.txt'}],outputs:[{name:'result.txt',path:'result.txt',createOnly:true}]})],web);
  assert.equal(result.state,'completed'); assert.equal(staged,'source content');
  assert.equal(await readFile(join(env.workspace,'source.txt'),'utf8'),'source content');
  assert.equal(await readFile(join(env.workspace,'result.txt'),'utf8'),'SOURCE CONTENT');
  assert.notEqual(env.calls[0].cwd,env.workspace); assert.deepEqual(await readdir(env.scratch),[]);
});

test('QQ file delivery fails explicitly without claiming a send or calling the Web delivery adapter',windows,async t => {
  const env = await fixture(t); await writeFile(join(env.workspace,'report.txt'),'report');
  const result = await env.engine.run([{action:'deliver',path:'report.txt'}],async () => ({kind:'qq',sessionId:'session-fixture',account:'20001',sender:'10001'}));
  assert.equal(result.state,'failed'); assert.equal(result.steps[0].ok,false); assert.match(result.steps[0].error || '',/未发送/);
  assert.equal(env.deliveries.length,0); assert.equal(await readFile(join(env.workspace,'report.txt'),'utf8'),'report');
});
