/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { temporaryDirectory } from './temporary-directory.ts';

// These are integration-test imports only. The shipped plugin uses public Context
// types and never imports a host implementation or frozen compatibility fixture.
// Set WHALELIFE_SDK explicitly to the selected supported source checkout.
const sdk = process.env.WHALELIFE_SDK;
const source = fileURLToPath(new URL('../', import.meta.url));
const enabled = {skip:!sdk ? 'WHALELIFE_SDK is unset: real host compatibility was not tested.' : process.platform !== 'win32' ? 'The computer plugin supports Windows only.' : false,timeout:20000};

async function fixture(t: TestContext, options: { corruptFinalWrite?: boolean } = {}) {
  let app: any;
  const cleanups: (() => unknown | Promise<unknown>)[] = [];
  // One ordered owner cleanup: close the isolated host/children before removing
  // the test directory, even when initialization or an assertion fails.
  t.after(async () => {
    try { await app?.close(); }
    finally { for (const cleanup of cleanups) await cleanup(); }
  });
  const root = await temporaryDirectory({after(fn) { assert.ok(fn); cleanups.push(() => fn(t,error => { if (error) throw error; })); }});
  const modules = await Promise.all(['core/index.ts','core/runtime.ts','core/tools.ts'].map(path => import(pathToFileURL(join(resolve(sdk!),path)).href)));
  const [{boot},{Runtime},{Tools}] = modules;
  await mkdir(join(root,'config'),{recursive:true});
  await writeFile(join(root,'config','config.json'),JSON.stringify({
    log:{level:'error'}, web:{host:'127.0.0.1',port:0,password:'synthetic-local-fixture-password'},
    providers:[{id:'fixture',name:'Synthetic provider',base_url:'http://127.0.0.1:1/v1',api_key:'synthetic-never-used-key'}],
    models:[{id:'fixture-chat',name:'Synthetic chat',provider:'fixture',model:'fixture-model',type:'chat',enabled:true,context_window:200000}],
    model_bindings:{chat:'fixture-chat'},personas:{fixture:{name:'Synthetic fixture',file:'personas/fixture.md',model:'fixture-chat',permission:'full'}},
    channels:{web:{persona:'fixture',permission:'full'}},memory:{root:'memory',budget_tokens:6000,diary_enabled:false},
    plugin_runtime:{startupTimeoutMs:5000,callTimeoutMs:5000,heartbeatTimeoutMs:5000,stopTimeoutMs:500},
  }));
  app = await boot(root);
  assert.ok(app.runtime instanceof Runtime); assert.ok(app.tools instanceof Tools);
  // Nothing can contact a real model, even if a test accidentally enters chat.
  app.llm.chat = async () => { throw new Error('Test must install its synthetic model response before chat'); };
  const install = join(root,'plugins','computer'); await mkdir(install,{recursive:true});
  await cp(join(source,'src'),join(install,'src'),{recursive:true});
  await Promise.all(['index.ts','plugin.yaml'].map(name => cp(join(source,name),join(install,name))));
  const interference = options.corruptFinalWrite ? 'synthetic post-commit interference ' + randomUUID() : undefined;
  if (interference) {
    // Only this owned fixture entrypoint is instrumented. All production modules
    // remain byte-for-byte copies. Change real disk bytes after the child's real
    // rename, before its final readback, without timing-dependent external races.
    const entry = await readFile(join(install,'index.ts'),'utf8');
    await writeFile(join(install,'index.ts'), `import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const originalRename = fs.rename;
fs.rename = async (from, to) => {
  await originalRename(from, to);
  if (String(to).toLowerCase() === ${JSON.stringify(join(install,'data','workspace','contract-input.txt').toLowerCase())}) {
    fs.rename = originalRename; syncBuiltinESMExports();
    await fs.writeFile(to, ${JSON.stringify(interference)});
  }
};
syncBuiltinESMExports();
${entry}`);
  }
  await app.runtime.scan();
  const record = app.runtime.records.get('computer');
  assert.equal(record?.status,'active',record?.error);
  assert.equal(record.manifest.id,'computer'); assert.equal(record.manifest.apiVersion,'1.0.0');
  assert.ok(Number.isInteger(record.execution?.pid)); assert.notEqual(record.execution.pid,process.pid,'plugin must run in a real child process');
  const address = app.web.server.address(); assert.ok(address && typeof address === 'object');
  const url = 'http://127.0.0.1:' + address.port;
  const login = await fetch(url + '/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'synthetic-local-fixture-password'})});
  assert.equal(login.status,200);
  const cookie = login.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie);
  const request = (path: string, body?: unknown) => fetch(url + path,{method:body === undefined ? 'GET' : 'POST',headers:{Cookie:cookie,...(body === undefined ? {} : {'Content-Type':'application/json'})},...(body === undefined ? {} : {body:JSON.stringify(body)})});
  const current = await app.sessions.current({create:true});
  const session = {id:current,permission:'full',channel:'web',account:'local',peer:current,origin:{plugin:'core',channel:'web',platform:'控制台'}};
  const marker = 'temporary-file-content-' + randomUUID();
  await writeFile(join(install,'data','workspace','contract-input.txt'),marker);
  const observed: any[] = [], originalObserve = app.tools.observe;
  app.tools.observe = async (event: any) => {
    observed.push({name:event.name,result:event.result,transient:event.transient,source:event.source,session:{id:event.session?.id,channel:event.session?.channel,account:event.session?.account,origin:event.session?.origin}});
    await originalObserve?.(event);
  };
  const authorizeFiles = async () => {
    const response = await request('/plugins/computer/api/state'); assert.equal(response.status,200);
    const state = await response.json() as any;
    state.settings.grants.read = true; state.settings.grants.write = true;
    const saved = await request('/plugins/computer/api/settings',{revision:state.revision,settings:state.settings});
    assert.equal(saved.status,200); return saved.json();
  };
  return {root,app,install,url,request,current,session,marker,observed,authorizeFiles,record,interference};
}

test('real host loads the manifest and transient tool; full still needs plugin grants and ask/off do not execute',enabled,async t => {
  const f = await fixture(t);
  const registered = f.app.tools.entries.get('computer_task');
  assert.ok(registered); assert.equal(registered.owner,'computer'); assert.equal(registered.transientResult,true); assert.equal(registered.danger,'full');
  const args = {operations:[{action:'read',path:'contract-input.txt'}]};
  const ungranted = await f.app.tools.call('computer_task',args,f.session);
  assert.equal(ungranted.ok,true); assert.equal(ungranted.result.state,'rejected'); assert.equal(ungranted.result.error.code,'permission');
  await f.authorizeFiles();
  for (const permission of ['ask','off']) {
    const denied = await f.app.tools.call('computer_task',args,{...f.session,permission});
    assert.equal(denied.ok,false); assert.ok(!JSON.stringify(denied).includes(f.marker));
  }
  const answer = await f.app.tools.call('computer_task',args,f.session);
  assert.equal(answer.ok,true); assert.equal(answer.result.state,'completed'); assert.equal(answer.result.steps[0].result.text,f.marker);
  const retained = f.app.tools.stored(answer);
  assert.equal(retained.transient,true);
  assert.deepEqual(Object.keys(retained.result).sort(),['action','state','steps','taskId']);
  assert.deepEqual(retained.result.steps,[{action:'read',ok:true}]);
  assert.ok(!JSON.stringify(retained).includes(f.marker)); assert.ok(!JSON.stringify(retained).includes('contract-input.txt'));
  const last = f.observed.at(-1); assert.equal(last.transient,true); assert.equal(last.source,'computer');
  assert.deepEqual(last.result,retained.result);
  const rejectedOrigin = await f.app.tools.call('computer_task',args,{...f.session,origin:{plugin:'other',platform:'控制台'}});
  assert.equal(rejectedOrigin.result.state,'rejected'); assert.equal(rejectedOrigin.result.error.code,'origin');
});

test('actual authenticated GET/POST and download cross the real plugin HTTP bridge and disappear after stop',enabled,async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.url + '/plugins/computer/settings')).status,401);
  assert.equal((await fetch(f.url + '/plugins/computer/api/state')).status,401);
  const page = await f.request('/plugins/computer/settings'); assert.equal(page.status,200); assert.match(await page.text(),/电脑与文件/);
  await f.authorizeFiles();
  const response = await f.request('/plugins/computer/api/task',{operations:[{action:'write',path:'web-output.txt',text:'synthetic web output',createOnly:true},{action:'deliver',path:'web-output.txt'}]});
  assert.equal(response.status,200); const task = await response.json() as any;
  assert.equal(task.state,'completed'); assert.equal(task.steps.length,2);
  const download = task.steps[1].result.url;
  assert.equal((await fetch(f.url + download)).status,401);
  const file = await f.request(download); assert.equal(file.status,200); assert.equal(await file.text(),'synthetic web output');
  assert.match(file.headers.get('content-disposition') || '',/^attachment;/);
  const state = await (await f.request('/plugins/computer/api/state')).json() as any;
  assert.equal(state.tasks[0].origin.kind,'web'); assert.equal(state.tasks[0].origin.sessionId,f.current);
  assert.equal(state.availability.execute.check,'files-only');
  assert.ok(!state.availability.execute.runtimes.includes('powershell'));
  await f.app.runtime.action('computer','stop');
  assert.equal(f.app.runtime.records.get('computer')?.status,'stopped');
  assert.equal(f.app.tools.entries.has('computer_task'),false);
  assert.equal((await f.request('/plugins/computer/api/state')).status,404);
  assert.equal((await f.request(download)).status,404);
  const missing = await f.app.tools.call('computer_task',{operations:[{action:'list'}]},f.session); assert.equal(missing.ok,false);
  assert.equal(await readFile(join(f.install,'data','workspace','web-output.txt'),'utf8'),'synthetic web output');
  assert.ok(JSON.parse(await readFile(join(f.install,'data','computer.json'),'utf8')).settings.grants.read);
  // The child belongs to this fixture; close() awaits its owned process exit.
  await f.record.execution.close();
  const child = f.record.execution.child;
  assert.ok(child && (child.exitCode !== null || child.signalCode !== null),'stopped child must have exited');
});

test('real Web conversation supplies current route identity while file body stays out of retained history',enabled,async t => {
  const f = await fixture(t); await f.authorizeFiles(); let rounds = 0;
  f.app.llm.chat = async (input: any) => {
    rounds++;
    if (rounds === 2) assert.ok(JSON.stringify(input.messages).includes(f.marker),'file body must be available to the current model continuation');
    return rounds === 1 ? {text:'',toolCalls:[{id:'synthetic-read-call',name:'computer_task',arguments:JSON.stringify({operations:[{action:'read',path:'contract-input.txt'}]})}],usage:{prompt_tokens:10,completion_tokens:5}}
      : {text:'合成任务已完成。',toolCalls:[],usage:{prompt_tokens:15,completion_tokens:4}};
  };
  const reply = await f.app.channels.web(f.current,'读取测试文件并说明是否完成。',() => {});
  assert.equal(reply,'合成任务已完成。'); assert.equal(rounds,2);
  const event = f.observed.find(event => event.name === 'computer_task'); assert.ok(event);
  assert.equal(event.session.id,f.current); assert.equal(event.session.channel,'web'); assert.equal(event.session.account,'local'); assert.equal(event.session.origin.plugin,'core');
  assert.equal(event.result.state,'completed'); assert.equal(event.transient,true);
  const rows = await f.app.memory.readSession(f.current);
  assert.ok(rows.some((row: any) => row.role === 'assistant' && row.text === '合成任务已完成。'));
  assert.ok(!JSON.stringify(rows).includes(f.marker),'temporary file body must not enter durable conversation/tool history');
});

test('real host forwards a verified unchanged write while retaining only the minimal action receipt',enabled,async t => {
  const f = await fixture(t); await f.authorizeFiles();
  const target = join(f.install,'data','workspace','contract-input.txt');
  const read = await f.app.tools.call('computer_task',{operations:[{action:'read',path:'contract-input.txt'}]},f.session);
  assert.equal(read.result.state,'completed');
  const digest = read.result.steps[0].result.sha256, before = await stat(target,{bigint:true});
  const answer = await f.app.tools.call('computer_task',{operations:[{action:'write',path:'contract-input.txt',text:f.marker,expectedSha256:digest}]},f.session);
  assert.equal(answer.ok,true); assert.equal(answer.result.state,'completed');
  assert.equal(answer.result.steps.length,1); assert.equal(answer.result.steps[0].ok,true);
  const written = answer.result.steps[0].result;
  assert.equal(written.outcome,'unchanged'); assert.equal(written.verified,true);
  assert.equal(written.sha256,digest); assert.equal(written.bytes,Buffer.byteLength(f.marker));
  assert.equal(written.backupId,undefined);
  const after = await stat(target,{bigint:true});
  assert.equal(after.ino,before.ino); assert.equal(after.mtimeNs,before.mtimeNs);
  assert.equal(await readFile(target,'utf8'),f.marker);
  await assert.rejects(stat(join(f.install,'data','backups')),{code:'ENOENT'});
  const retained = f.app.tools.stored(answer);
  assert.equal(retained.transient,true);
  assert.deepEqual(retained.result,{action:'computer_task',taskId:answer.result.id,state:'completed',steps:[{action:'write',ok:true}]});
  assert.deepEqual(f.observed.at(-1).result,retained.result);
  assert.ok(!JSON.stringify(retained).includes(f.marker)); assert.ok(!JSON.stringify(retained).includes('contract-input.txt'));
});

test('real host forwards final-write verification failure and recovery reference without persisting file details',enabled,async t => {
  const f = await fixture(t,{corruptFinalWrite:true}); await f.authorizeFiles();
  const read = await f.app.tools.call('computer_task',{operations:[{action:'read',path:'contract-input.txt'}]},f.session);
  assert.equal(read.result.state,'completed');
  const intended = 'synthetic intended replacement ' + randomUUID();
  const answer = await f.app.tools.call('computer_task',{operations:[
    {action:'write',path:'contract-input.txt',text:intended,expectedSha256:read.result.steps[0].result.sha256},
    {action:'write',path:'must-not-run.txt',text:'must not be created after failure',createOnly:true},
  ]},f.session);
  assert.equal(answer.ok,true,'host protocol completion is separate from the task outcome');
  assert.equal(answer.result.state,'failed'); assert.equal(answer.result.steps.length,1);
  const step = answer.result.steps[0]; assert.equal(step.action,'write'); assert.equal(step.ok,false); assert.equal(step.result,undefined);
  // TaskResult exposes the safe WRITE_UNVERIFIED message, not the internal error code.
  assert.match(step.error,/写入后未能核验最终文件/); assert.match(step.error,/目标可能已改变/);
  assert.match(step.error,/请先读取核对/); assert.match(step.error,/不要自动重试/);
  const backupId = /原内容副本：([0-9a-f-]{36})/.exec(step.error)?.[1]; assert.ok(backupId);
  assert.equal(await readFile(join(f.install,'data','backups',backupId + '.bin'),'utf8'),f.marker);
  assert.equal(await readFile(join(f.install,'data','workspace','contract-input.txt'),'utf8'),f.interference,'the real post-commit interference was not retried away');
  await assert.rejects(stat(join(f.install,'data','workspace','must-not-run.txt')),{code:'ENOENT'});
  const immediate = JSON.stringify(answer);
  for (const content of [f.marker,intended,f.interference!]) assert.ok(!immediate.includes(content));
  const retained = f.app.tools.stored(answer);
  assert.equal(retained.transient,true);
  assert.deepEqual(retained.result,{action:'computer_task',taskId:answer.result.id,state:'failed',steps:[{action:'write',ok:false}]});
  assert.deepEqual(f.observed.at(-1).result,retained.result);
  const durable = JSON.stringify(retained);
  for (const detail of [f.marker,intended,f.interference!,backupId,'contract-input.txt',step.error]) assert.ok(!durable.includes(detail));
});
