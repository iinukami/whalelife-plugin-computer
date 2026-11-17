/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import type { ToolSession } from 'whalelife';
import { ComputerError } from './types.ts';
import type { Capability, FileOperation, Grants, TaskOrigin } from './types.ts';

export async function authorizeOrigin(session: ToolSession, grants: Grants,
  qqRecipients: () => Promise<unknown>): Promise<TaskOrigin> {
  if (session.permission !== 'full') throw new ComputerError('permission', '此能力需要主干 full 工具权限。');
  if (typeof session.id !== 'string' || !session.id || session.id.length > 200)
    throw new ComputerError('origin', '缺少可信会话身份。');
  if (session.channel === 'web' && session.account === 'local' && session.origin?.plugin === 'core')
    return { kind: 'web', sessionId: session.id };
  if (session.channel === 'plugin' && session.account === 'autonomy' && session.origin?.plugin === 'autonomy') {
    if (!grants.autonomous) throw new ComputerError('permission', '尚未勾选允许自主调用。');
    return { kind: 'autonomy', sessionId: session.id };
  }
  if (session.channel === 'qq' && session.origin?.plugin === 'qq' && typeof session.sender === 'string' &&
      /^\d{5,20}$/.test(session.sender) && session.peer === `direct:${session.sender}` && typeof session.account === 'string') {
    const raw = await qqRecipients();
    const row = raw as { status?: string; accountId?: string; currentRecipient?: string; recipients?: { userId?: string }[] } | undefined;
    if (row?.status === 'ready' && row.accountId === session.account && row.currentRecipient === session.sender &&
        Array.isArray(row.recipients) && row.recipients.some(r => r.userId === session.sender))
      return { kind: 'qq', sessionId: session.id, sender: session.sender, account: session.account };
    throw new ComputerError('origin', '未能通过 QQ 公开接口核验当前账号和白名单，未执行。');
  }
  throw new ComputerError('origin', '只接受 Web、QQ 白名单或已授权的自主调用。');
}
export function requiredGrants(operation: FileOperation): Capability[] {
  switch (operation.action) {
    case 'list': case 'search': case 'read': case 'backups': case 'deliver': return ['read'];
    case 'write': case 'document': case 'mkdir': return ['write'];
    case 'edit': return ['read', 'write'];
    case 'delete': return ['delete'];
    case 'restore': return ['restore', 'write'];
    case 'execute': return ['execute', ...(operation.inputs?.length ? ['read' as const] : []), ...(operation.outputs?.length ? ['write' as const] : [])];
  }
}
export function checkGrants(operations: FileOperation[], grants: Grants) {
  for (const operation of operations) for (const capability of requiredGrants(operation))
    if (!grants[capability]) throw new ComputerError('permission', `尚未授权能力：${capability}。`);
}
const fields: Record<FileOperation['action'], string[]> = {
  list: ['path', 'offset', 'limit'], search: ['path', 'query', 'content', 'offset', 'limit'],
  read: ['path', 'offset', 'limit'], write: ['path', 'text', 'expectedSha256', 'createOnly'],
  edit: ['path', 'find', 'replace', 'expectedSha256'], delete: ['path', 'expectedSha256'], mkdir: ['path'],
  backups: ['offset', 'limit'], restore: ['backupId', 'expectedSha256', 'createOnly'],
  document: ['path', 'title', 'paragraphs', 'format', 'expectedSha256', 'createOnly'],
  execute: ['runtime', 'code', 'inputs', 'outputs', 'timeoutSeconds'], deliver: ['path'],
};
export function parseOperations(value: unknown): FileOperation[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) throw new ComputerError('input', '每项任务须包含 1–16 个动作。');
  let total = 0, nodes = 0;
  function budget(item: unknown, depth = 0): void {
    if (++nodes > 6000 || depth > 5) throw new ComputerError('limit', '任务参数过多或嵌套过深。');
    if (typeof item === 'string') total += Buffer.byteLength(item);
    else if (Array.isArray(item)) for (const child of item) budget(child, depth + 1);
    else if (item && typeof item === 'object') for (const [key, child] of Object.entries(item)) { total += Buffer.byteLength(key); budget(child, depth + 1); }
    if (total > 768000) throw new ComputerError('limit', '任务参数总量超过 750 KB，请拆分资料。');
  }
  budget(value);
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ComputerError('input', '动作格式无效。');
    const op = raw as Record<string, unknown>;
    if (typeof op.action !== 'string' || !Object.hasOwn(fields, op.action) ||
      Object.keys(op).some(k => k !== 'action' && !fields[op.action as FileOperation['action']].includes(k)))
      throw new ComputerError('input', '未知动作或多余字段。');
    for (const key of ['path', 'query', 'text', 'find', 'replace', 'backupId', 'title', 'code'])
      if (op[key] !== undefined && (typeof op[key] !== 'string' || (op[key] as string).length > (['code', 'text'].includes(key) ? 256000 : 4000)))
        throw new ComputerError('input', `动作字段 ${key} 格式或长度无效。`);
    for (const key of ['offset', 'limit', 'timeoutSeconds'])
      if (op[key] !== undefined && (!Number.isSafeInteger(op[key]) || (op[key] as number) < 0)) throw new ComputerError('input', `${key} 无效。`);
    for (const key of ['content', 'createOnly']) if (op[key] !== undefined && typeof op[key] !== 'boolean') throw new ComputerError('input', `${key} 必须为布尔值。`);
    if (op.expectedSha256 !== undefined && (typeof op.expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(op.expectedSha256)))
      throw new ComputerError('input', '文件版本摘要无效。');
    if (['read','write','edit','delete','mkdir','document','deliver'].includes(op.action) && (typeof op.path !== 'string' || !op.path))
      throw new ComputerError('input', '缺少文件路径。');
    if (op.action === 'search' && (typeof op.query !== 'string' || !op.query.trim())) throw new ComputerError('input', '搜索内容不能为空。');
    if (op.action === 'write' && typeof op.text !== 'string') throw new ComputerError('input', '缺少文件正文。');
    if (op.action === 'edit' && (typeof op.find !== 'string' || !op.find || typeof op.replace !== 'string' || !op.expectedSha256))
      throw new ComputerError('input', '编辑需要查找内容、替换内容和已读文件版本。');
    if (op.action === 'delete' && !op.expectedSha256) throw new ComputerError('input', '删除需要已读文件版本。');
    if (op.action === 'restore' && (typeof op.backupId !== 'string' || !op.backupId)) throw new ComputerError('input', '缺少副本编号。');
    if (op.action === 'document' && (!['docx','md','html'].includes(op.format as string) || typeof op.title !== 'string' ||
      !Array.isArray(op.paragraphs) || op.paragraphs.length > 2000 || op.paragraphs.some(p => typeof p !== 'string' || p.length > 16000)))
      throw new ComputerError('input', '文档需要格式、标题和文字段落。');
    if (op.action === 'execute') {
      if (op.runtime === 'powershell') throw new ComputerError('unavailable', 'PowerShell 在当前隔离策略下不可用；首版只支持 Node。');
      if (op.runtime !== 'node' || typeof op.code !== 'string' || !op.code.trim())
        throw new ComputerError('input', '执行需要选择 Node 并提供代码。');
      if (op.timeoutSeconds !== undefined && ((op.timeoutSeconds as number) < 1 || (op.timeoutSeconds as number) > 300))
        throw new ComputerError('input', '执行超时必须介于 1–300 秒。');
      for (const key of ['inputs','outputs']) if (op[key] !== undefined) {
        const entries = op[key];
        if (!Array.isArray(entries) || entries.length > 16) throw new ComputerError('input', '一次执行最多传入或导出 16 个文件。');
        const names = new Set<string>();
        for (const entry of entries) {
          if (!entry || typeof entry !== 'object' || Object.keys(entry).some(k => !(key === 'inputs' ? ['path','name'] : ['path','name','expectedSha256','createOnly']).includes(k)) ||
            typeof entry.path !== 'string' || !entry.path || typeof entry.name !== 'string' || !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,119}$/.test(entry.name) ||
            /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(entry.name) || /[. ]$/.test(entry.name) || names.has(entry.name.toLowerCase()))
            throw new ComputerError('input', '执行文件名无效、重复或含路径。');
          if (entry.expectedSha256 !== undefined && (typeof entry.expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.expectedSha256))) throw new ComputerError('input', '输出版本摘要无效。');
          if (entry.createOnly !== undefined && typeof entry.createOnly !== 'boolean') throw new ComputerError('input', '输出 createOnly 无效。');
          names.add(entry.name.toLowerCase());
        }
      }
    }
  }
  return structuredClone(value) as FileOperation[];
}
export function publicError(error: unknown): { code: string; message: string } {
  if (error instanceof ComputerError) return { code: error.code, message: error.message };
  if (error instanceof Error && error.name === 'AbortError') return { code: 'cancelled', message: '任务已取消。已完成的动作不会自动重放。' };
  return { code: 'operation_failed', message: '操作失败。请检查路径、文件占用、访问权限或执行环境；不会自动重试。' };
}
