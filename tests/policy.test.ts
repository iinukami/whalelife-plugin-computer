/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ToolSession } from 'whalelife';
import { authorizeOrigin, checkGrants, parseOperations, publicError } from '../src/policy.ts';
import { CAPABILITIES, ComputerError, type Grants } from '../src/types.ts';

const grants = (enabled = false): Grants => Object.fromEntries(CAPABILITIES.map(cap => [cap, enabled])) as Grants;
const web = (): ToolSession => ({id:'session-fixture',permission:'full',channel:'web',account:'local',origin:{plugin:'core',channel:'web',platform:'控制台'}});
const qq = (): ToolSession => ({id:'session-fixture',permission:'full',channel:'qq',account:'20001',sender:'10001',peer:'direct:10001',origin:{plugin:'qq',channel:'qq'}});
const recipients = () => ({status:'ready',accountId:'20001',currentRecipient:'10001',recipients:[{userId:'10001'}]});
const neverQQ = async () => { throw new Error('This source must not query QQ'); };
const coded = (code: string) => (error: unknown) => error instanceof ComputerError && error.code === code;

test('Web source comes from its trusted route, independently of each action grant', async () => {
  assert.deepEqual(await authorizeOrigin(web(),grants(),neverQQ),{kind:'web',sessionId:'session-fixture'});
  for (const source of [
    {...web(),account:'elsewhere'}, {...web(),origin:{plugin:'another-plugin',platform:'控制台'}},
    {...web(),channel:'plugin',account:'another-plugin'}, {...web(),id:''},
  ]) await assert.rejects(authorizeOrigin(source,grants(true),neverQQ),coded('origin'));
});

test('QQ admission requires the same account, direct sender and configured whitelist', async () => {
  assert.deepEqual(await authorizeOrigin(qq(),grants(true),async () => recipients()),{kind:'qq',sessionId:'session-fixture',sender:'10001',account:'20001'});
  for (const answer of [
    {...recipients(),accountId:'20002'}, {...recipients(),currentRecipient:'10002'},
    {...recipients(),recipients:[{userId:'10002'}]}, {...recipients(),status:'blocked'},
    {...recipients(),recipients:[]}, null,
  ]) await assert.rejects(authorizeOrigin(qq(),grants(true),async () => answer),coded('origin'));
  for (const source of [
    {...qq(),sender:'10002'}, {...qq(),peer:'group:10001'},
    {...qq(),origin:{plugin:'another-plugin',platform:'QQ 私聊'}}, {...qq(),sender:undefined},
  ]) await assert.rejects(authorizeOrigin(source,grants(true),neverQQ),coded('origin'));
});

test('autonomous source needs its own grant; descriptive platform and full do not grant it', async () => {
  const source: ToolSession = {id:'session-fixture',permission:'full',channel:'plugin',account:'autonomy',origin:{plugin:'autonomy',platform:'自主性',action:'自主唤起'}};
  await assert.rejects(authorizeOrigin(source,grants(),neverQQ),coded('permission'));
  const allowed = grants(); allowed.autonomous = true;
  assert.deepEqual(await authorizeOrigin(source,allowed,neverQQ),{kind:'autonomy',sessionId:'session-fixture'});
  for (const forged of [
    {...source,account:'other'}, {...source,origin:{plugin:'other',platform:'自主性',action:'自主唤起'}},
    {...source,origin:{platform:'自主性'}}, {...source,channel:'qq'},
  ]) await assert.rejects(authorizeOrigin(forged,grants(true),neverQQ),coded('origin'));
});

test('host ask/off and missing source identity deny all origins, even with all plugin grants', async () => {
  for (const source of [web(),qq(),{...web(),channel:'plugin',account:'autonomy',origin:{plugin:'autonomy'}}]) {
    await assert.rejects(authorizeOrigin({...source,permission:'off'},grants(true),neverQQ),coded('permission'));
    await assert.rejects(authorizeOrigin({...source,permission:'ask'},grants(true),neverQQ),coded('permission'));
    await assert.rejects(authorizeOrigin({...source,id:undefined},grants(true),neverQQ),coded('origin'));
  }
});

test('action grants are independent, including execution imports and restoration writes', () => {
  const allowed = grants(); allowed.execute = true;
  assert.doesNotThrow(() => checkGrants([{action:'execute',runtime:'node',code:'1'}],allowed));
  assert.throws(() => checkGrants([{action:'execute',runtime:'node',code:'1',inputs:[{path:'input.txt',name:'input.txt'}]}],allowed),coded('permission'));
  assert.throws(() => checkGrants([{action:'execute',runtime:'node',code:'1',outputs:[{path:'output.txt',name:'output.txt',createOnly:true}]}],allowed),coded('permission'));
  allowed.restore = true;
  assert.throws(() => checkGrants([{action:'restore',backupId:'backup-fixture',createOnly:true}],allowed),coded('permission'));
  allowed.write = true;
  assert.doesNotThrow(() => checkGrants([{action:'restore',backupId:'backup-fixture',createOnly:true}],allowed));
  assert.throws(() => checkGrants([{action:'delete',path:'file.txt',expectedSha256:'a'.repeat(64)}],allowed),coded('permission'));
});

test('parser rejects unknown actions, impersonation fields and injected execution options', () => {
  for (const input of [
    [], Array.from({length:17},() => ({action:'list'})), [{action:'__proto__'}], [{action:'install'}],
    [{action:'read',path:'file.txt',sessionId:'forged'}], [{action:'read',path:'file.txt',permission:'full'}],
    [{action:'read',path:'file.txt',origin:{plugin:'core'}}], [{action:'list',offset:-1}],
    [{action:'delete',path:'file.txt'}], [{action:'write',path:'file.txt',text:'x',expectedSha256:'not-a-hash'}],
    [{action:'execute',runtime:'node',code:'1',env:{SECRET:'fixture'}}],
    [{action:'execute',runtime:'node',code:'1',outputs:[{name:'out.txt',path:'out.txt',shell:true}]}],
    [{action:'document',path:'test.docx',format:'docx',title:'title',paragraphs:[{}]}],
  ]) assert.throws(() => parseOperations(input),coded('input'));
});

test('execution filenames cannot inject paths, Windows devices or case-colliding names', () => {
  for (const name of ['../outside','folder/file','C:\\outside.txt','CON','nul.txt','LPT1.log','name.','name ','x:y']) {
    assert.throws(() => parseOperations([{action:'execute',runtime:'node',code:'1',inputs:[{path:'input.txt',name}]}]),coded('input'));
  }
  assert.throws(() => parseOperations([{action:'execute',runtime:'node',code:'1',outputs:[{path:'a',name:'Report.txt'},{path:'b',name:'report.TXT'}]}]),coded('input'));
});

test('parser bounds both individual text and accumulated document content before copying', () => {
  assert.throws(() => parseOperations([{action:'write',path:'big.txt',text:'x'.repeat(256001)}]),coded('input'));
  const paragraph = 'x'.repeat(16000);
  assert.throws(() => parseOperations([{action:'document',path:'big.docx',format:'docx',title:'title',paragraphs:Array(2000).fill(paragraph)}]),coded('limit'));
});

test('parsed task inputs are detached from caller mutations and internal errors are not exposed', () => {
  const source = [{action:'execute',runtime:'node',code:'console.log(1)',inputs:[{path:'input.txt',name:'input.txt'}]}];
  const parsed = parseOperations(source);
  source[0].inputs[0].path = 'other.txt'; source[0].code = 'changed';
  assert.equal(parsed[0].action,'execute');
  if (parsed[0].action === 'execute') { assert.equal(parsed[0].inputs?.[0].path,'input.txt'); assert.equal(parsed[0].code,'console.log(1)'); }
  const hidden = 'fixture-private-token'; assert.ok(!publicError(new Error(hidden)).message.includes(hidden));
  assert.deepEqual(publicError(new ComputerError('conflict','文件已变化。')),{code:'conflict',message:'文件已变化。'});
});
