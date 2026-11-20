/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderPage } from '../src/ui.ts';
import { CAPABILITIES, type ComputerSettings, type FileOperation, type FileRead, type TaskResult } from '../src/types.ts';
import { FileStore } from '../src/files.ts';
import { temporaryDirectory } from './temporary-directory.ts';

// This small DOM double deliberately forbids HTML parsing at runtime. It runs the
// delivered page script, exercises the actual handlers and records API requests.
class Element {
  tagName: string;
  id = '';
  value = '';
  checked = false;
  hidden = false;
  disabled = false;
  readOnly = false;
  className = '';
  title = '';
  type = '';
  href = '';
  max: string | number = '';
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  children: Element[] = [];
  options: Element[] = [];
  listeners: Record<string, ((event: { preventDefault(): void }) => unknown)[]> = {};
  private ownText = '';
  constructor(tag: string) { this.tagName = tag.toUpperCase(); }
  set textContent(value: string) { this.ownText = String(value); this.children = []; }
  get textContent(): string { return this.ownText + this.children.map(child => child.textContent).join(''); }
  set innerHTML(_value: string) { throw new Error('Untrusted HTML insertion is forbidden'); }
  append(...items: Element[]) { this.children.push(...items); }
  replaceChildren(...items: Element[]) { this.ownText = ''; this.children = [...items]; }
  setAttribute(name: string, value: string) { this.attributes[name] = String(value); }
  addEventListener(name: string, listener: (event: { preventDefault(): void }) => unknown) {
    (this.listeners[name] ||= []).push(listener);
  }
}

const settings = (): ComputerSettings => ({
  version: 1,
  grants: Object.fromEntries(CAPABILITIES.map(cap => [cap, ['read', 'write', 'delete', 'restore'].includes(cap)])) as ComputerSettings['grants'],
  scope: 'workspace', workspace: 'C:\\fixture', backupKeepDays: 30, backupMaxBytes: 64 * 1048576,
  maxFileBytes: 4 * 1048576, taskTimeoutSeconds: 60,
});
type Request = { path: string; method: string; credentials: string; body?: any };
type Reply = { status?: number; data: unknown };
async function flush() { for (let index = 0; index < 6; index++) await new Promise<void>(resolve => setImmediate(resolve)); }

async function page(options: {
  configure?: (state: any) => void;
  task?: (operations: FileOperation[]) => TaskResult | Promise<TaskResult>;
  respond?: (request: Request) => Reply | undefined;
} = {}) {
  const html = renderPage(), nodes: Element[] = [], ids = new Map<string, Element>();
  for (const match of html.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*)>/gi)) {
    const node = new Element(match[1]);
    for (const attr of match[2].matchAll(/([a-z][a-z0-9-]*)="([^"]*)"/gi)) {
      node.attributes[attr[1]] = attr[2];
      if (attr[1].startsWith('data-')) node.dataset[attr[1].slice(5)] = attr[2];
    }
    node.id = node.attributes.id || '';
    node.value = node.attributes.value || '';
    node.disabled = /\bdisabled\b/.test(match[2]);
    node.hidden = /\bhidden\b/.test(match[2]);
    nodes.push(node); if (node.id) ids.set(node.id, node);
  }
  for (const match of html.matchAll(/<select\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const select = ids.get(match[1])!;
    select.options = [...match[2].matchAll(/<option value="([^"]+)"[^>]*>([^<]*)<\/option>/g)].map(option => {
      const node = new Element('option'); node.value = option[1]; node.textContent = option[2]; return node;
    });
    select.value = select.options[0]?.value || '';
  }
  const state = {
    revision: 'r1', settings: settings(),
    availability: { execute: { available: false, reason: '离线隔离环境不可用', runtimes: [] as string[] }, installDependencies: { available: false, reason: '安装任务依赖尚未开放' }, manageSoftware: { available: false, reason: '系统软件管理尚未开放' } },
    tasks: [] as any[], limitations: ['QQ 文件投递等待公开接口。'],
  };
  options.configure?.(state);
  const requests: Request[] = [];
  const fetch = async (path: string, init: any) => {
    const request: Request = {path,method:init.method,credentials:init.credentials,...(init.body ? {body:JSON.parse(init.body)} : {})};
    requests.push(request);
    let reply = options.respond?.(request);
    if (!reply) {
      if (path.endsWith('/state')) reply = {data:state};
      else if (path.endsWith('/settings')) {
        state.revision = 'r2'; state.settings = request.body.settings;
        reply = {data:{revision:state.revision,settings:state.settings}};
      } else if (path.endsWith('/task')) reply = {data: await options.task?.(request.body.operations) || {id:'task-fixture',state:'completed',steps:[]}};
      else throw new Error('Unexpected API request');
    }
    const status = reply.status || 200;
    return {ok:status >= 200 && status < 300,json:async () => structuredClone(reply!.data)};
  };
  const document = {
    getElementById(id: string) { const node = ids.get(id); assert.ok(node, 'Unknown page element: ' + id); return node; },
    createElement(tag: string) { assert.notEqual(tag.toLowerCase(), 'script'); const node = new Element(tag); nodes.push(node); return node; },
    querySelectorAll(selector: string) {
      if (selector === '[data-tab]') return nodes.filter(node => node.dataset.tab);
      if (selector === '[data-requires]') return nodes.filter(node => node.dataset.requires);
      if (selector === '[role="tabpanel"]') return nodes.filter(node => node.attributes.role === 'tabpanel');
      throw new Error('Unexpected selector: ' + selector);
    },
  };
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]; assert.ok(script);
  new vm.Script(script).runInNewContext({document,fetch,URL,location:{href:'https://fixture.invalid/plugins/computer/settings',origin:'https://fixture.invalid'},console});
  await flush();
  return {html,state,requests,nodes,get:(id: string) => document.getElementById(id),async fire(id: string, event: string) {
    await Promise.all(document.getElementById(id).listeners[event]?.map(listener => listener({preventDefault(){}})) || []); await flush();
  }};
}
const result = (action: string, value: unknown, ok = true): TaskResult => ({id:'task-fixture',state:ok ? 'completed' : 'failed',steps:[{action,ok,...(ok ? {result:value} : {error:String(value)})}]});
const taskRequests = (view: Awaited<ReturnType<typeof page>>) => view.requests.filter(request => request.path.endsWith('/task'));

test('page is self-contained, exposes every grant and has executable inline script', async () => {
  const view = await page();
  assert.doesNotMatch(view.html, /<script[^>]+src=|<link[^>]+href=|\binnerHTML\b|insertAdjacentHTML|document\.write/);
  assert.equal(new Set([...view.html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1])).size, [...view.html.matchAll(/\bid="([^"]+)"/g)].length);
  for (const capability of CAPABILITIES) assert.ok(view.get('grant-' + capability));
  assert.ok(view.requests.every(request => request.credentials === 'same-origin'));
  assert.equal(view.get('save-settings').disabled, false);
  assert.equal(view.get('panel-settings').hidden, true);
});

test('read text and file names remain text; overwrites use the read version', async () => {
  const payload = '<img src=x onerror=alert(1)>', sha = 'a'.repeat(64);
  const view = await page({task:operations => {
    const op = operations[0];
    if (op.action === 'list') return result('list',{items:[{path:payload,kind:'file',size:2,modifiedAt:'2026-01-01T00:00:00Z'}]});
    if (op.action === 'read') return result('read',{path:'C:\\fixture\\notes.txt',text:payload,sha256:sha,totalBytes:payload.length,truncated:false,offset:0});
    return result(op.action,{path:'C:\\fixture\\notes.txt',sha256:'b'.repeat(64),outcome:'updated',verified:true});
  }});
  await view.fire('browse-form','submit'); assert.ok(view.get('file-list').textContent.includes(payload));
  view.get('editor-path').value = 'notes.txt'; await view.fire('read-file','click');
  assert.equal(view.get('editor-text').value,payload);
  view.get('editor-text').value = 'changed'; await view.fire('editor-form','submit');
  const operation = taskRequests(view).at(-1)!.body.operations[0];
  assert.equal(operation.expectedSha256,sha); assert.equal(operation.createOnly,undefined);
  assert.equal(view.nodes.filter(node => node.tagName === 'IMG').length,0);
  view.get('editor-path').value = 'new.txt'; await view.fire('editor-form','submit');
  assert.equal(taskRequests(view).at(-1)!.body.operations[0].createOnly,true);
});

test('partly read files cannot be overwritten, and changed continuation invalidates the old version', async () => {
  let reads = 0;
  const view = await page({task:operations => {
    const op = operations[0]; assert.equal(op.action,'read'); reads++;
    return result('read',{path:'C:\\fixture\\large.txt',text:'part',sha256:(reads === 1 ? 'a' : 'b').repeat(64),totalBytes:20,truncated:reads === 1,offset:reads === 1 ? 0 : 4,...(reads === 1 ? {nextOffset:4} : {})});
  }});
  view.get('editor-path').value = 'large.txt'; await view.fire('read-file','click');
  await view.fire('editor-form','submit'); assert.equal(taskRequests(view).length,1);
  assert.match(view.get('notice').textContent,/完整文件/);
  await view.fire('read-more','click'); assert.match(view.get('notice').textContent,/文件已变化/);
  assert.equal(view.get('read-more').hidden,true);
});

test('ungranted operations and unavailable execution never issue tasks; installation grants can still be saved', async () => {
  const view = await page({configure:state => { for (const capability of CAPABILITIES) state.settings.grants[capability] = false; }});
  view.get('editor-path').value = 'notes.txt'; await view.fire('read-file','click'); assert.equal(taskRequests(view).length,0);
  view.get('grant-execute').checked = true; view.get('grant-installDependencies').checked = true; view.get('grant-manageSoftware').checked = true;
  await view.fire('settings-form','submit');
  const saved = view.requests.find(request => request.path.endsWith('/settings'))!.body;
  assert.equal(saved.revision,'r1'); assert.equal(saved.settings.grants.installDependencies,true); assert.equal(saved.settings.grants.manageSoftware,true);
  await view.fire('execute-form','submit'); assert.equal(taskRequests(view).length,0);
  assert.match(view.get('grant-installDependencies-note').textContent,/尚未开放/);
  assert.match(view.get('notice').textContent,/隔离环境不可用/);
});

test('download results reject external, executable, credentialed and unrelated URLs', async () => {
  let url = '';
  const view = await page({task:() => result('deliver',{name:'<img src=x>',url})});
  view.get('editor-path').value = 'report.docx';
  for (url of ['javascript:alert(1)','https://other.invalid/plugins/computer/file','https://a:b@fixture.invalid/plugins/computer/file','/api/config','/plugins/computer/%2e%2e/config','/plugins/computer/%2fother']) {
    await view.fire('deliver-file','click'); assert.match(view.get('files-result').textContent,/未通过校验/);
  }
  assert.equal(view.nodes.filter(node => node.tagName === 'A').length,0);
  url = '/plugins/computer/download/opaque-fixture'; await view.fire('deliver-file','click');
  const anchor = view.nodes.find(node => node.tagName === 'A')!;
  assert.equal(anchor.href,'https://fixture.invalid/plugins/computer/download/opaque-fixture');
  assert.equal(anchor.textContent,'下载 <img src=x>');
});

test('document creation and offline execution send bounded structured operations', async () => {
  const view = await page({configure:state => { state.settings.grants.execute = true; state.availability.execute = {available:true,runtimes:['node']}; },task:ops => result(ops[0].action,{status:'completed',exitCode:0,stdout:'<script>bad()</script>',stderr:''})});
  view.get('document-path').value = 'report.docx'; view.get('document-title').value = '报告'; view.get('document-body').value = '第一段\n\n第二段';
  await view.fire('document-form','submit');
  const document = taskRequests(view).at(-1)!.body.operations[0];
  assert.deepEqual(document.paragraphs,['第一段','第二段']); assert.equal(document.createOnly,true);
  view.get('execute-code').value = 'console.log("hello")'; view.get('execute-inputs').value = 'input.txt => input.txt'; view.get('execute-output').value = 'output.txt => reports/output.txt';
  await view.fire('execute-form','submit');
  const execute = taskRequests(view).at(-1)!.body.operations[0];
  assert.deepEqual(execute.inputs,[{path:'input.txt',name:'input.txt'}]);
  assert.deepEqual(execute.outputs,[{name:'output.txt',path:'reports/output.txt',createOnly:true}]);
  assert.equal(execute.runtime,'node'); assert.equal(execute.timeoutSeconds,60);
  assert.ok(view.get('execute-result').textContent.includes('<script>bad()</script>'));
  view.get('execute-timeout').value = '61'; await view.fire('execute-form','submit'); assert.equal(taskRequests(view).length,2);
});

test('server conflict is shown as text, preserves draft settings and does not retry mutation', async () => {
  const attack = '<img src=x onerror=alert(1)> 设置已变化';
  const view = await page({respond:request => request.path.endsWith('/settings') ? {status:409,data:{error:{code:'conflict',message:attack}}} : undefined});
  view.get('setting-workspace').value = 'C:\\new-fixture'; await view.fire('settings-form','submit');
  assert.equal(view.get('notice').textContent,attack); assert.equal(view.get('setting-workspace').value,'C:\\new-fixture');
  assert.equal(view.requests.filter(request => request.path.endsWith('/settings')).length,1);
  assert.equal(view.get('save-settings').disabled,false);
});

test('restoring over an existing file requires its matching read version', async () => {
  const sha = 'c'.repeat(64), path = 'C:\\fixture\\notes.txt';
  const view = await page({task:ops => {
    const op = ops[0];
    if (op.action === 'backups') return result('backups',{items:[{id:'backup-fixture',path,createdAt:'2026-01-01T00:00:00Z',size:4,sha256:sha,reason:'overwrite'}]});
    if (op.action === 'read') return result('read',{path,text:'current',sha256:sha,totalBytes:7,truncated:false,offset:0});
    return result(op.action,{path,outcome:'restored',verified:true});
  }});
  await view.fire('load-backups','click');
  const select = view.nodes.find(node => node.tagName === 'BUTTON' && node.textContent === '选择此版本')!;
  await select.listeners.click[0]({preventDefault(){}}); view.get('restore-mode').value = 'existing';
  await view.fire('restore-backup','click'); assert.equal(taskRequests(view).length,1);
  view.get('editor-path').value = path; await view.fire('read-file','click'); await view.fire('restore-backup','click');
  assert.deepEqual(taskRequests(view).at(-1)!.body.operations[0],{action:'restore',backupId:'backup-fixture',expectedSha256:sha});
  assert.match(view.get('backups-result').textContent,/写入并核验完成/);
});

test('failed execution preserves visible diagnostics and imported outputs, and restoration needs write authority', async () => {
  const view = await page({configure:state => {
    state.settings.grants.write = false; state.settings.grants.execute = true;
    state.availability.execute = {available:true,runtimes:['node']};
  },task:() => ({id:'task-fixture',state:'failed',steps:[{action:'execute',ok:false,error:'部分输出未保存',result:{status:'completed',exitCode:0,stdout:'已计算',saved:[{path:'C:\\fixture\\first.txt'}]}}]})});
  assert.equal(view.get('load-backups').disabled,false);
  assert.equal(view.get('restore-backup').disabled,true);
  view.get('execute-code').value = 'console.log(1)'; await view.fire('execute-form','submit');
  assert.ok(view.get('execute-result').textContent.includes('已计算'));
  assert.ok(view.get('execute-result').textContent.includes('C:\\fixture\\first.txt'));
  assert.ok(view.get('execute-result').textContent.includes('部分输出未保存'));
});

test('real FileStore final page remains truncated but complete continuous reading permits a safe overwrite', {skip:process.platform !== 'win32'}, async t => {
  const root = await temporaryDirectory(t), workspace = join(root,'workspace'); await mkdir(workspace);
  const file = join(workspace,'long.txt'), original = 'a'.repeat(15999) + '😀' + '结尾'.repeat(300);
  await writeFile(file,original);
  const store = new FileStore({backupRoot:join(root,'backups')}), pages: FileRead[] = [];
  const scope = {workspace,scope:'workspace' as const,maxFileBytes:1048576,protectedRoots:[]};
  const view = await page({configure:state => { state.settings.workspace = workspace; },task:async operations => {
    const op = operations[0];
    if (op.action === 'read') { const data = await store.read(scope,op.path,op.offset,op.limit); pages.push(data); return result('read',data); }
    assert.equal(op.action,'write');
    if (op.action !== 'write') throw new Error('Unexpected operation');
    return result('write',await store.write(scope,op.path,Buffer.from(op.text),{expectedSha256:op.expectedSha256,createOnly:op.createOnly,backupPolicy:{keepDays:30,maxBytes:1048576}}));
  }});
  view.get('editor-path').value = 'long.txt'; await view.fire('read-file','click');
  assert.equal(pages[0].truncated,true); assert.equal(pages[0].nextOffset,16001);
  assert.equal(view.get('editor-text').readOnly,true);
  await view.fire('editor-form','submit'); assert.equal(taskRequests(view).length,1);
  await view.fire('read-more','click');
  assert.equal(pages[1].offset,16001); assert.equal(pages[1].truncated,true); assert.equal(pages[1].nextOffset,undefined);
  assert.equal(view.get('editor-text').value,original); assert.equal(view.get('editor-text').readOnly,false);
  assert.equal(view.get('read-more').hidden,true); assert.match(view.get('editor-note').textContent,/完整版本/);
  view.get('editor-text').value = original + '\n已编辑'; await view.fire('editor-form','submit');
  assert.equal(await readFile(file,'utf8'),original + '\n已编辑');
  assert.equal(taskRequests(view).at(-1)!.body.operations[0].expectedSha256,pages[0].sha256);
});

test('noncontiguous read continuation cannot be mistaken for a complete file', async () => {
  let count = 0;
  const view = await page({task:() => {
    count++;
    return result('read',{path:'C:\\fixture\\gap.txt',text:'abcd',sha256:'a'.repeat(64),totalBytes:12,offset:count === 1 ? 0 : 8,truncated:true,...(count === 1 ? {nextOffset:4} : {})});
  }});
  view.get('editor-path').value = 'gap.txt'; await view.fire('read-file','click'); await view.fire('read-more','click');
  assert.match(view.get('notice').textContent,/片段不连续/); assert.equal(view.get('read-more').hidden,true);
});

test('PowerShell stays unavailable even when a file-presence probe reports it', async () => {
  const view = await page({configure:state => { state.settings.grants.execute = true; state.availability.execute = {available:true,check:'files-only',runtimes:['node','powershell']}; }});
  const options = view.get('execute-runtime').options;
  assert.equal(view.get('execute-runtime').value,'node'); assert.equal(options.find(option => option.value === 'powershell')!.disabled,true);
  assert.match(options.find(option => option.value === 'powershell')!.textContent,/未验收/);
  assert.match(view.get('execute-availability').textContent,/不代表实际启动验收通过/);
  view.get('execute-runtime').value = 'powershell'; view.get('execute-code').value = 'Write-Output 1'; await view.fire('execute-form','submit');
  assert.equal(taskRequests(view).length,0); assert.match(view.get('notice').textContent,/PowerShell 尚未验收/);
  const powershellOnly = await page({configure:state => { state.settings.grants.execute = true; state.availability.execute = {available:true,runtimes:['powershell']}; }});
  assert.ok(powershellOnly.nodes.filter(node => node.dataset.requires === 'execute').every(node => node.disabled));
  assert.match(powershellOnly.get('execute-availability').textContent,/没有可用的 Node.js/);
  await powershellOnly.fire('execute-form','submit'); assert.equal(taskRequests(powershellOnly).length,0);
});

test('an unchanged save displays a verified no-op and retains the expected version for the next edit', async () => {
  const path = 'C:\\fixture\\same.txt', sha = 'd'.repeat(64);
  const view = await page({task:ops => ops[0].action === 'read'
    ? result('read',{path,text:'same content',sha256:sha,totalBytes:12,truncated:false,offset:0})
    : result('write',{path,sha256:sha,bytes:12,outcome:'unchanged',verified:true})});
  view.get('editor-path').value = 'same.txt'; await view.fire('read-file','click'); await view.fire('editor-form','submit');
  assert.match(view.get('files-result').textContent,/内容已相同，未改写；已读取核验/);
  assert.match(view.get('editor-note').textContent,/内容已相同，未改写/);
  assert.doesNotMatch(view.get('files-result').textContent,/写入并核验完成|已保留恢复副本/);
  assert.match(view.get('files-result').textContent,/核验仅反映当次文件内容/);
  assert.equal(taskRequests(view).length,2);
  assert.equal(taskRequests(view).at(-1)!.body.operations[0].expectedSha256,sha);
  view.get('editor-text').value = 'next edit'; await view.fire('editor-form','submit');
  assert.equal(taskRequests(view).at(-1)!.body.operations[0].expectedSha256,sha);
});

test('file mutation receipts claim verification only when explicitly confirmed and ordinary mkdir stays unchanged', async () => {
  for (const outcome of ['created','updated','restored','unchanged']) {
    for (const verified of [true,false,undefined]) {
      const view = await page({task:() => result('write',{path:'C:\\fixture\\file.txt',sha256:'a'.repeat(64),outcome,...(verified === undefined ? {} : {verified})})});
      view.get('editor-path').value = 'file.txt'; view.get('editor-text').value = 'content'; await view.fire('editor-form','submit');
      const display = view.get('files-result').textContent + view.get('editor-note').textContent;
      if (verified === true) assert.match(display,outcome === 'unchanged' ? /内容已相同，未改写；已读取核验/ : /写入并核验完成/);
      else { assert.match(display,/未提供读回核验记录/); assert.doesNotMatch(display,/写入并核验完成|已读取核验/); }
      assert.equal(taskRequests(view).at(-1)!.body.operations[0].createOnly,true);
    }
  }
  const ordinary = await page({task:() => result('mkdir',{path:'C:\\fixture\\folder',outcome:'created'})});
  ordinary.get('mkdir-path').value = 'folder'; await ordinary.fire('mkdir-form','submit');
  assert.match(ordinary.get('files-result').textContent,/创建文件夹：完成/);
  assert.doesNotMatch(ordinary.get('files-result').textContent,/读回核验|写入并核验完成/);
});

test('unverified write failure preserves its caution and backup reference without retrying or discarding the draft', async () => {
  const message = 'WRITE_UNVERIFIED：目标可能已改变，请先读取核对，勿自动重试。旧副本 backup-fixture <img src=x>。';
  const view = await page({task:() => result('write',message,false)});
  view.get('editor-path').value = 'file.txt'; view.get('editor-text').value = 'keep this draft'; await view.fire('editor-form','submit');
  assert.ok(view.get('files-result').textContent.includes(message));
  assert.doesNotMatch(view.get('files-result').textContent,/写入并核验完成/);
  assert.equal(view.get('editor-text').value,'keep this draft'); assert.equal(taskRequests(view).length,1);
  assert.equal(view.nodes.filter(node => node.tagName === 'IMG').length,0);
});

test('partial execution shows unchanged and written receipts separately and preserves import verification errors', async () => {
  const importError = 'WRITE_UNVERIFIED：第三项目标可能已改变，请先读取核对，勿自动重试。旧副本 backup-fixture <img src=x>。';
  const view = await page({configure:state => { state.settings.grants.execute = true; state.availability.execute = {available:true,runtimes:['node']}; },task:() => ({
    id:'task-fixture',state:'failed',steps:[{action:'execute',ok:false,error:'输出未全部保存',result:{
      status:'completed',exitCode:0,outputsImported:false,importError,cleanupError:'请核对本次执行目录。',
      saved:[{path:'C:\\fixture\\same.txt',outcome:'unchanged',verified:true},{path:'C:\\fixture\\changed.txt',outcome:'updated',verified:true}],
    }}],
  })});
  view.get('execute-code').value = 'console.log(1)'; await view.fire('execute-form','submit');
  const display = view.get('execute-result').textContent;
  assert.match(display,/执行代码：未完成/); assert.ok(display.includes(importError)); assert.match(display,/请核对本次执行目录/);
  assert.match(display,/输出文件：C:\\fixture\\same\.txt内容已相同，未改写；已读取核验/);
  assert.match(display,/输出文件：C:\\fixture\\changed\.txt写入并核验完成/);
  assert.doesNotMatch(display,/(?:修改|改写|写入)了?\s*2\s*(?:项|个)/);
  assert.equal(taskRequests(view).length,1); assert.equal(view.nodes.filter(node => node.tagName === 'IMG').length,0);
});
