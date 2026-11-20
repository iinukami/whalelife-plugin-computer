/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */

/** The host authenticates this page and every API request. No external assets. */
export function renderPage(): string {
  return String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>电脑与文件</title>
<style>
:root{color-scheme:light dark;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#172c3b;background:#f4f7f9;font-size:15px}
*{box-sizing:border-box}body{margin:0}main{max-width:1080px;margin:auto;padding:22px}h1{font-size:24px;margin:0 0 6px}h2{font-size:19px;margin:0 0 16px}h3{font-size:16px;margin:18px 0 10px}p{line-height:1.65}button,input,select,textarea{font:inherit}button,a.button{cursor:pointer;border:1px solid #b9cbd4;border-radius:8px;padding:9px 14px;background:#fff;color:inherit;text-decoration:none}button.primary{background:#146f69;color:white;border-color:#146f69}button:disabled{cursor:not-allowed;opacity:.48}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,a:focus-visible{outline:3px solid #35a99a;outline-offset:2px}input:not([type=checkbox]),select,textarea{width:100%;border:1px solid #b9cbd4;border-radius:7px;padding:9px;background:#fff;color:inherit}textarea{resize:vertical;min-height:120px;line-height:1.6}label{display:block;margin:12px 0 6px}label.check{display:flex;align-items:flex-start;gap:10px;margin:0}input[type=checkbox]{width:18px;height:18px;flex:none;accent-color:#146f69}small,.muted{color:#546b7b;line-height:1.6}.intro{margin:0 0 16px}.tabs{display:flex;gap:8px;flex-wrap:wrap;margin:18px 0}.tabs button[aria-selected=true]{background:#173e4a;border-color:#173e4a;color:#fff}.panel,.card{background:#fff;border:1px solid #d5e0e5;border-radius:12px;padding:20px;margin:14px 0}.panel[hidden]{display:none}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.row .grow{flex:1;min-width:180px}.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}.notice{border-left:4px solid #35958c;background:#eaf5f2;padding:10px 14px;border-radius:6px;white-space:pre-wrap;overflow-wrap:anywhere}.notice.error{border-color:#bf5c42;background:#fff0e9}.notice:empty{display:none}.list{list-style:none;padding:0;margin:12px 0}.list li{padding:12px 0;border-bottom:1px solid #e4ebef;overflow-wrap:anywhere}.list li:last-child{border-bottom:0}.list strong{display:block;margin-bottom:5px}.list .row{justify-content:space-between}.grant{border:1px solid #d5e0e5;border-radius:9px;padding:13px}.grant small{display:block;margin-left:28px;margin-top:5px}.code,pre{font-family:Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}pre{max-height:420px;overflow:auto;background:#f0f4f7;padding:12px;border-radius:7px}.danger{color:#a33621}.result{margin-top:16px}.result:empty{display:none}a{color:#126c67}.badge{font-size:13px;color:#466576}.limit{margin:4px 0}.compact{min-height:80px}.spaced{margin-top:18px}
@media(max-width:640px){main{padding:14px}.grid{grid-template-columns:1fr}.panel,.card{padding:15px}.tabs button{flex:1}}
@media(prefers-color-scheme:dark){:root{color:#e1eaf0;background:#111d25}.panel,.card,button,input:not([type=checkbox]),select,textarea{background:#1b2b35;color:#e1eaf0;border-color:#425b68}.grant{border-color:#425b68}.muted,small{color:#b3c5ce}.notice{background:#163b38}.notice.error{background:#462e27}.list li{border-color:#334a56}pre{background:#12232e}a{color:#83d5c7}.danger{color:#ffb29c}.badge{color:#b5cbd5}}
</style></head><body><main>
<header><h1>电脑与文件</h1><p class="intro muted">在你允许的目录内查找资料、编辑文件、生成文档，并使用本机工具完成任务。</p></header>
<div id="notice" role="status" aria-live="polite" class="notice">正在读取设置…</div>
<nav class="tabs" aria-label="功能导航" role="tablist">
<button type="button" data-tab="files" role="tab" aria-selected="true" aria-controls="panel-files">文件</button>
<button type="button" data-tab="documents" role="tab" aria-selected="false" aria-controls="panel-documents">生成文档</button>
<button type="button" data-tab="execute" role="tab" aria-selected="false" aria-controls="panel-execute">离线执行</button>
<button type="button" data-tab="backups" role="tab" aria-selected="false" aria-controls="panel-backups">恢复文件</button>
<button type="button" data-tab="settings" role="tab" aria-selected="false" aria-controls="panel-settings">授权与设置</button>
<button type="button" data-tab="tasks" role="tab" aria-selected="false" aria-controls="panel-tasks">最近任务</button>
</nav>
<section id="panel-files" class="panel" role="tabpanel"><h2>浏览与编辑</h2><p id="scope-note" class="muted"></p>
<form id="browse-form"><label for="browse-path">目录路径</label><div class="row"><input id="browse-path" class="grow" placeholder="留空表示工作目录"><button data-requires="read" disabled>浏览目录</button></div></form>
<form id="search-form"><label for="search-query">搜索文件名或内容</label><div class="row"><input id="search-query" class="grow" required maxlength="1000" placeholder="输入搜索词"><label class="check"><input type="checkbox" id="search-content">搜索文件内容</label><button data-requires="read" disabled>搜索</button></div></form>
<p id="file-list-note" class="muted">从浏览目录或搜索开始。</p><ul id="file-list" class="list"></ul><button id="file-more" type="button" data-requires="read" hidden disabled>加载更多</button>
<h3>文本文件</h3><form id="editor-form"><label for="editor-path">文件路径</label><div class="row"><input id="editor-path" class="grow" required placeholder="例如 notes.txt"><button type="button" id="read-file" data-requires="read" disabled>读取</button></div><p id="editor-note" class="muted">新文件可直接填写路径与正文。覆盖已有文件前，先读取当前版本。</p><label for="editor-text">正文</label><textarea id="editor-text" rows="12" spellcheck="false"></textarea><button type="button" id="read-more" data-requires="read" hidden disabled>继续读取</button><div class="actions"><button class="primary" data-requires="write" disabled>保存文件</button><button type="button" id="deliver-file" data-requires="read" disabled>获取下载</button><button type="button" id="delete-file" class="danger" data-requires="delete" disabled>删除并保留副本</button></div></form>
<form id="mkdir-form" class="spaced"><label for="mkdir-path">新建文件夹</label><div class="row"><input id="mkdir-path" class="grow" required placeholder="例如 reports"><button data-requires="write" disabled>创建文件夹</button></div></form><div id="files-result" class="result" aria-live="polite"></div></section>
<section id="panel-documents" class="panel" role="tabpanel" hidden><h2>生成文档</h2><p class="muted">填写标题和正文，生成的文件保留在指定目录；完成后可获取下载。</p><form id="document-form"><div class="grid"><div><label for="document-format">格式</label><select id="document-format"><option value="docx">Word 文档（.docx）</option><option value="md">Markdown（.md）</option><option value="html">网页文档（.html）</option></select></div><div><label for="document-path">保存路径</label><input id="document-path" required placeholder="例如 reports/说明.docx"></div></div><label for="document-title">文档标题</label><input id="document-title" required maxlength="1000"><label for="document-body">正文段落</label><textarea id="document-body" rows="12" placeholder="用空行分隔段落"></textarea><p class="muted">此入口只创建新文件，已有同名文件会保留。需要修改时请先读取文件。</p><button class="primary" data-requires="write" disabled>生成文档</button></form><div id="documents-result" class="result" aria-live="polite"></div></section>
<section id="panel-execute" class="panel" role="tabpanel" hidden><h2>离线执行</h2><p id="execute-availability" class="notice">正在核验本机执行环境…</p><p class="muted">首版支持 Node.js，PowerShell 尚未验收，暂不开放。只使用本机已有工具与本地依赖，代码无法直接联网；输入文件须明确列出，输出只按下面的设置保存。</p><form id="execute-form"><div class="grid"><div><label for="execute-runtime">运行方式</label><select id="execute-runtime"><option value="node">Node.js（首版支持）</option><option value="powershell" disabled>PowerShell（未验收，暂不可用）</option></select></div><div><label for="execute-timeout">本次超时（秒）</label><input id="execute-timeout" type="number" min="1" step="1" value="60" required></div></div><label for="execute-code">代码</label><textarea id="execute-code" class="code" rows="12" spellcheck="false" required></textarea><label for="execute-inputs">输入文件（可选，每行一项）</label><textarea id="execute-inputs" class="code compact" placeholder="原文件路径 => 运行环境中的相对文件名"></textarea><label for="execute-output">保存一个输出文件（可选）</label><input id="execute-output" class="code" placeholder="运行环境中的相对文件名 => 目标路径"><p class="muted">输出保存为新文件；不会覆盖已有同名文件。代码运行成功与文件保存成功分别显示。</p><button class="primary" data-requires="execute" disabled>开始执行</button></form><div id="execute-result" class="result" aria-live="polite"></div></section>
<section id="panel-backups" class="panel" role="tabpanel" hidden><h2>恢复文件</h2><p class="muted">这里仅列出本插件保留的副本。查看需要读取权限；恢复需要同时开放恢复与写入权限。恢复前会核对目标文件当前版本；如目标已变化，请重新读取后再恢复。</p><button type="button" id="load-backups" data-requires="read" disabled>查看可恢复副本</button><ul id="backup-list" class="list"></ul><button id="backup-more" type="button" data-requires="read" hidden disabled>加载更多</button><div id="backup-choice" hidden><h3 id="backup-choice-title"></h3><label for="restore-mode">目标文件状态</label><select id="restore-mode"><option value="new">目标文件不存在</option><option value="existing">替换已在“文件”页读取的当前版本</option></select><p class="muted">替换且内容有变化时会保留当前版本；内容相同则不改写。仅当已读取文件与所选副本路径一致时可替换。</p><button type="button" id="restore-backup" class="primary" data-requires="restore write" disabled>恢复所选副本</button></div><div id="backups-result" class="result" aria-live="polite"></div></section>
<section id="panel-settings" class="panel" role="tabpanel" hidden><h2>授权与设置</h2><p class="muted">勾选允许使用的能力后保存。取消勾选影响随后启动的任务，已启动任务按原授权完成；显式取消、停用与超时仍然有效。</p><form id="settings-form"><div class="grid">
<div class="grant"><label class="check"><input id="grant-read" type="checkbox">读取与搜索文件</label><small>浏览目录、读取文件及获取下载。</small></div>
<div class="grant"><label class="check"><input id="grant-write" type="checkbox">创建与编辑文件</label><small>写文件、创建文件夹及生成文档。</small></div>
<div class="grant"><label class="check"><input id="grant-delete" type="checkbox">删除文件</label><small>先保留可恢复副本，再删除原文件。</small></div>
<div class="grant"><label class="check"><input id="grant-restore" type="checkbox">恢复文件</label><small>查看本插件副本并恢复对应版本。</small></div>
<div class="grant"><label class="check"><input id="grant-execute" type="checkbox">执行命令与脚本</label><small id="grant-execute-note">仅在离线隔离环境可用时开放执行。</small></div>
<div class="grant"><label class="check"><input id="grant-installDependencies" type="checkbox">安装任务依赖</label><small id="grant-installDependencies-note">仅限任务专用环境；当前功能尚未开放。</small></div>
<div class="grant"><label class="check"><input id="grant-manageSoftware" type="checkbox">管理系统软件</label><small id="grant-manageSoftware-note">安装、升级与卸载系统软件；当前功能尚未开放。</small></div>
<div class="grant"><label class="check"><input id="grant-autonomous" type="checkbox">允许自主调用</label><small>允许自主性插件发起任务，仍须满足其他能力与目录授权。</small></div></div>
<div class="grid"><div><label for="setting-scope">访问范围</label><select id="setting-scope"><option value="workspace">仅指定工作目录</option><option value="all">允许其他目录</option></select></div><div><label for="setting-workspace">工作目录</label><input id="setting-workspace" required placeholder="填写本机绝对路径"></div></div><p class="muted">放宽目录范围仍受运行账户权限及核心数据保护约束，不代表管理员提权。</p><div class="grid"><div><label for="setting-days">副本保留天数</label><input id="setting-days" type="number" min="1" step="1" required></div><div><label for="setting-bytes">副本容量上限（MiB）</label><input id="setting-bytes" type="number" min="1" step="1" required></div><div><label for="setting-file-bytes">单文件大小上限（MiB）</label><input id="setting-file-bytes" type="number" min="1" step="1" required></div><div><label for="setting-timeout">任务超时（秒）</label><input id="setting-timeout" type="number" min="1" step="1" required></div></div><p class="muted">超期或超限时自动清理最旧副本，只处理本插件创建的备份。</p><button class="primary" id="save-settings" disabled>保存授权与设置</button></form><h3>当前能力说明</h3><div id="limitations"></div></section>
<section id="panel-tasks" class="panel" role="tabpanel" hidden><div class="row"><h2>最近任务</h2><button type="button" id="refresh-tasks">刷新</button></div><p class="muted">每项记录对应本插件实际启动的一项任务。生成文件、执行成功与发送完成分别以真实结果为准。</p><ul id="task-list" class="list"></ul></section>
</main>
<script>
'use strict';
(() => {
  const BASE = '/plugins/computer';
  const capabilities = ['read', 'write', 'delete', 'restore', 'execute', 'installDependencies', 'manageSoftware', 'autonomous'];
  const actionNames = {list:'浏览目录',search:'搜索文件',read:'读取文件',write:'保存文件',edit:'编辑文件',delete:'删除文件',mkdir:'创建文件夹',backups:'查看副本',restore:'恢复文件',document:'生成文档',execute:'执行代码',deliver:'提供下载'};
  const stateNames = {completed:'已完成',failed:'失败',cancelled:'已取消',running:'执行中',queued:'等待中'};
  let state = null, busy = false, loaded = null, listing = null, backupOffset, selectedBackup = null;
  const el = id => document.getElementById(id);
  const text = (tag, value, className) => { const item = document.createElement(tag); item.textContent = String(value ?? ''); if (className) item.className = className; return item; };
  const say = (message, error = false) => { el('notice').textContent = message; el('notice').className = error ? 'notice error' : 'notice'; };
  function showTab(name) {
    document.querySelectorAll('[data-tab]').forEach(button => button.setAttribute('aria-selected', String(button.dataset.tab === name)));
    document.querySelectorAll('[role="tabpanel"]').forEach(panel => { panel.hidden = panel.id !== 'panel-' + name; });
  }
  document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => showTab(button.dataset.tab)));
  function executionReady() {
    const execution = state?.availability?.execute;
    return execution?.available === true && Array.isArray(execution.runtimes) && execution.runtimes.includes('node');
  }
  function executionReason() {
    return state?.availability?.execute?.reason || '当前没有可用的 Node.js 离线运行环境。PowerShell 尚未验收，暂不开放。';
  }
  function allowed(capability) {
    return capability.split(' ').every(cap => !!state?.settings?.grants?.[cap] && (cap !== 'execute' || executionReady()));
  }
  function gates() {
    document.querySelectorAll('[data-requires]').forEach(button => { button.disabled = busy || !allowed(button.dataset.requires); button.title = allowed(button.dataset.requires) ? '' : '请先在“授权与设置”中开放此能力；执行能力还须满足本机环境要求。'; });
    el('save-settings').disabled = busy || !state;
  }
  function need(capability) {
    if (busy) { say('当前操作尚未结束，请稍候。', true); return false; }
    if (!allowed(capability)) { say(capability === 'execute' && state?.settings?.grants?.execute ? executionReason() : '此能力尚未授权，请到“授权与设置”勾选并保存。', true); return false; }
    return true;
  }
  async function api(path, body) {
    const response = await fetch(BASE + '/api/' + path, {method:body === undefined ? 'GET' : 'POST',credentials:'same-origin',headers:body === undefined ? {} : {'Content-Type':'application/json'},...(body === undefined ? {} : {body:JSON.stringify(body)})});
    let data;
    try { data = await response.json(); } catch { throw new Error('服务返回的内容无法读取，请刷新后重试。'); }
    if (!response.ok || data?.error) throw new Error(typeof data?.error?.message === 'string' ? data.error.message : '请求失败，请检查插件状态。');
    return data;
  }
  function errorMessage(error) { return error instanceof Error ? error.message : '操作未完成，请检查插件状态。'; }
  function size(bytes) { return Number.isFinite(bytes) ? (bytes < 1024 ? bytes + ' B' : bytes < 1048576 ? (bytes / 1024).toFixed(1) + ' KiB' : (bytes / 1048576).toFixed(1) + ' MiB') : ''; }
  function date(value) { const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? '时间未知' : parsed.toLocaleString(); }
  function renderTasks(tasks) {
    const target = el('task-list'); target.replaceChildren();
    if (!Array.isArray(tasks) || !tasks.length) { target.append(text('li','还没有任务记录。','muted')); return; }
    for (const task of tasks) {
      const row = text('li',''); row.append(text('strong',task.summary || stateNames[task.state] || '任务'));
      const origin = typeof task.origin === 'object' ? task.origin?.kind : task.origin;
      row.append(text('div',(stateNames[task.state] || '状态待核对') + ' · ' + ({web:'网页',qq:'QQ',autonomy:'自主调用'}[origin] || '插件任务') + ' · ' + date(task.startedAt),'muted')); target.append(row);
    }
  }
  function renderSettings(settings) {
    capabilities.forEach(cap => { el('grant-' + cap).checked = settings.grants[cap] === true; });
    el('setting-scope').value = settings.scope; el('setting-workspace').value = settings.workspace;
    el('setting-days').value = settings.backupKeepDays; el('setting-bytes').value = settings.backupMaxBytes / 1048576;
    el('setting-file-bytes').value = settings.maxFileBytes / 1048576; el('setting-timeout').value = settings.taskTimeoutSeconds;
  }
  function renderState(fillSettings) {
    if (fillSettings) renderSettings(state.settings);
    el('scope-note').textContent = '工作目录：' + state.settings.workspace + (state.settings.scope === 'workspace' ? '。路径相对于此目录。' : '。可使用工作目录相对路径或其他目录的绝对路径。');
    const execution = state.availability?.execute;
    el('execute-availability').textContent = executionReady() ? '已检测到 Node.js 执行组件；这不代表实际启动验收通过，运行结果以本次任务回执为准。PowerShell 尚未验收，暂不开放。' : executionReason();
    el('grant-execute-note').textContent = executionReady() ? '允许 Node.js 在离线隔离环境执行；PowerShell 暂不开放。' : executionReason();
    for (const cap of ['installDependencies','manageSoftware']) el('grant-' + cap + '-note').textContent = state.availability?.[cap]?.reason || '当前功能尚未开放；勾选仅保存授权，不会开始安装。';
    for (const option of el('execute-runtime').options) option.disabled = option.value !== 'node' || !executionReady();
    el('execute-runtime').value = 'node';
    el('execute-timeout').max = state.settings.taskTimeoutSeconds;
    if (Number(el('execute-timeout').value) > state.settings.taskTimeoutSeconds) el('execute-timeout').value = state.settings.taskTimeoutSeconds;
    const limits = el('limitations'); limits.replaceChildren();
    for (const limitation of state.limitations || []) limits.append(text('p',limitation,'muted limit'));
    renderTasks(state.tasks); gates();
  }
  async function refresh(fillSettings = false) { state = await api('state'); renderState(fillSettings); }
  function safeDownload(value) {
    if (typeof value !== 'string') return null;
    try {
      const url = new URL(value, location.href);
      if (!['http:','https:'].includes(url.protocol) || url.origin !== location.origin || url.username || url.password || !url.pathname.startsWith(BASE + '/') || /%2f|%5c|%2e/i.test(url.pathname)) return null;
      return url.href;
    } catch { return null; }
  }
  function downloadLink(result) {
    const href = safeDownload(result?.url);
    if (!href) return text('p','下载地址未通过校验，未创建链接。','danger');
    const anchor = text('a','下载 ' + (result.name || '文件'),'button'); anchor.href = href; anchor.setAttribute('download',''); return anchor;
  }
  function addDownload(target, path) {
    if (typeof path !== 'string' || !path) return;
    const button = text('button','获取下载'); button.type = 'button'; button.dataset.requires = 'read';
    button.addEventListener('click', () => task([{action:'deliver',path}],'read',target)); target.append(button);
  }
  function mutationMessage(value) {
    if (value.outcome === 'unchanged') return value.verified === true ? '内容已相同，未改写；已读取核验。' : '结果报告内容相同、未改写，但未提供读回核验记录；请先读取核对。';
    if (['created','updated','restored'].includes(value.outcome)) return value.verified === true ? '写入并核验完成。' : '已返回写入结果，未提供读回核验记录；请先读取核对。';
    return '';
  }
  function renderResults(target, result) {
    target.replaceChildren(text('h3',stateNames[result.state] || '任务结果'));
    for (const step of result.steps || []) {
      const executionFailed = step.action === 'execute' && step.result && (step.result.status !== 'completed' || step.result.exitCode !== 0 || step.result.importError || step.result.cleanupError);
      const succeeded = step.ok && !executionFailed;
      const row = text('div',''); row.append(text('p',(actionNames[step.action] || '操作') + '：' + (succeeded ? '完成' : '未完成'),succeeded ? '' : 'danger'));
      if (!step.ok) row.append(text('p',step.error || '结果需要核对，请勿盲目重复操作。','muted'));
      const value = step.result;
      if (value && typeof value === 'object') {
        if (step.action === 'deliver') row.append(downloadLink(value));
        else {
          if (typeof value.path === 'string') row.append(text('p',value.path,'muted'));
          if (value.backupId) row.append(text('p','已保留恢复副本。','muted'));
          if (['write','edit','document','restore'].includes(step.action)) {
            const message = mutationMessage(value); if (message) row.append(text('p',message));
            if (value.verified === true) row.append(text('p','核验仅反映当次文件内容，之后仍可能被其他程序修改。','muted'));
            addDownload(row,value.path);
          }
          if (step.action === 'execute') {
            for (const message of new Set([value.reason,value.importError,value.cleanupError])) if (typeof message === 'string' && message && message !== step.error) row.append(text('p',message,'danger'));
            if (value.exitCode !== undefined) row.append(text('p','退出状态：' + (value.exitCode === null ? '未取得退出码' : value.exitCode)));
            if (value.timedOut) row.append(text('p','已达到执行超时。','danger'));
            if (typeof value.stdout === 'string' && value.stdout) { row.append(text('h4','标准输出'),text('pre',value.stdout)); }
            if (typeof value.stderr === 'string' && value.stderr) { row.append(text('h4','错误输出'),text('pre',value.stderr)); }
            if (value.outputTruncated || value.truncated) row.append(text('p','输出已限量显示。','muted'));
            const outputs = Array.isArray(value.saved) ? value.saved : value.outputs;
            if (Array.isArray(outputs)) for (const output of outputs) {
              if (typeof output.path === 'string') {
                row.append(text('p','输出文件：' + output.path));
                const message = mutationMessage(output); if (message) row.append(text('p',message));
                addDownload(row,output.path);
              }
            }
            if (Array.isArray(outputs) && outputs.some(output => output.verified === true)) row.append(text('p','以上核验仅反映当次文件内容；内容已相同的输出未改写。','muted'));
          }
        }
      }
      target.append(row);
    }
  }
  async function task(operations, capability, target, consume) {
    if (!need(capability)) return;
    busy = true; gates(); say('正在执行，请稍候…');
    try {
      const result = await api('task',{operations});
      if (target) renderResults(target,result);
      if (consume) await consume(result);
      say(result.state === 'completed' ? '操作已完成。' : result.state === 'cancelled' ? '任务已取消，请核对已完成的步骤。' : '任务未全部完成，请查看结果；不要盲目重复操作。',result.state !== 'completed');
      try { await refresh(); } catch { say('已收到操作结果，但刷新状态失败。请保留当前结果并稍后刷新。',true); }
      return result;
    } catch (error) { say(errorMessage(error),true); }
    finally { busy = false; gates(); }
  }
  const success = result => result.steps?.find(step => step.ok)?.result;
  function fileRows(data, append) {
    const target = el('file-list'); if (!append) target.replaceChildren();
    const items = Array.isArray(data?.items) ? data.items : [];
    for (const item of items) {
      const row = text('li',''), heading = text('div','','row'), label = text('div','');
      label.append(text('strong',item.path),text('small',item.kind === 'directory' ? '文件夹' : [size(item.size),item.modifiedAt ? date(item.modifiedAt) : ''].filter(Boolean).join(' · ')));
      const button = text('button',item.kind === 'directory' ? '打开目录' : '读取文本'); button.type = 'button'; button.dataset.requires = 'read';
      button.addEventListener('click', () => { if (item.kind === 'directory') { el('browse-path').value = item.path; browse(false,'list'); } else readFile(item.path); });
      heading.append(label,button); row.append(heading); if (typeof item.snippet === 'string') row.append(text('p',item.snippet,'muted')); target.append(row);
    }
    el('file-list-note').textContent = items.length ? '已显示本页 ' + items.length + ' 项。' : '未找到符合条件的项目。';
    listing.nextOffset = data?.nextOffset; el('file-more').hidden = !Number.isInteger(data?.nextOffset);
  }
  function browse(append, action) {
    if (!append) listing = {action,path:el('browse-path').value.trim(),query:el('search-query').value,content:el('search-content').checked};
    if (!listing) return;
    const operation = {action:listing.action,path:listing.path,limit:50,...(append ? {offset:listing.nextOffset} : {})};
    if (operation.action === 'search') Object.assign(operation,{query:listing.query,content:listing.content});
    return task([operation],'read',null,result => { const data = success(result); if (data) fileRows(data,append); });
  }
  el('browse-form').addEventListener('submit',event => { event.preventDefault(); browse(false,'list'); });
  el('search-form').addEventListener('submit',event => { event.preventDefault(); browse(false,'search'); });
  el('file-more').addEventListener('click',() => browse(true));
  function readFile(path, append = false) {
    path = path.trim(); if (!path) { say('请填写文件路径。',true); return; }
    const previous = loaded;
    return task([{action:'read',path,...(append && previous ? {offset:previous.nextOffset} : {})}],'read',null,result => {
      const data = success(result); if (!data) return;
      if (append && (previous?.sha256 !== data.sha256 || previous?.path !== data.path)) { loaded = null; el('read-more').hidden = true; el('editor-note').textContent = '读取过程中源文件已变化，请重新读取；当前正文不能覆盖保存。'; throw new Error('文件已变化，请重新读取。'); }
      const expectedOffset = append ? previous?.nextOffset : 0;
      if (typeof data.text !== 'string' || data.offset !== expectedOffset || (data.nextOffset !== undefined && data.nextOffset !== data.offset + data.text.length)) {
        loaded = null; el('read-more').hidden = true; throw new Error('读取片段不连续，请重新读取文件。');
      }
      // FileRead.truncated describes this page, including any nonzero offset.
      // A final continuation is still truncated, but the accumulated text is complete.
      const combinedText = append ? previous.combinedText + data.text : data.text;
      const complete = data.nextOffset === undefined && (append ? previous.fromStart === true : data.truncated === false);
      loaded = {...data,inputPath:path,combinedText,fromStart:append ? previous.fromStart : data.offset === 0,complete}; el('editor-path').value = data.path;
      el('editor-text').value = combinedText; el('editor-text').readOnly = !complete;
      el('editor-note').textContent = complete ? '已读取当前完整版本。保存时核对当前版本；内容相同则不改写，内容不同时先保留副本。' : '当前只读取了部分正文，暂为只读。继续读取完整文件后才可编辑和覆盖保存。';
      el('read-more').hidden = !Number.isInteger(data.nextOffset); showTab('files');
    });
  }
  el('read-file').addEventListener('click',() => readFile(el('editor-path').value));
  el('read-more').addEventListener('click',() => { if (loaded && Number.isInteger(loaded.nextOffset)) return readFile(loaded.path,true); });
  el('editor-path').addEventListener('input',() => {
    const path = el('editor-path').value.trim();
    el('editor-text').readOnly = !!loaded && !loaded.complete && (path === loaded.path || path === loaded.inputPath);
  });
  el('editor-form').addEventListener('submit',async event => {
    event.preventDefault(); if (!need('write')) return;
    const path = el('editor-path').value.trim();
    const existing = loaded && (loaded.path === path || loaded.inputPath === path);
    if (existing && !loaded.complete) { say('尚未读取完整文件，不能覆盖保存。',true); return; }
    const operation = {action:'write',path,text:el('editor-text').value,...(existing ? {expectedSha256:loaded.sha256} : {createOnly:true})};
    const pathReadOnly = el('editor-path').readOnly;
    el('editor-path').readOnly = true; el('editor-text').readOnly = true;
    try {
      return await task([operation],'write',el('files-result'),result => { const data = success(result); if (data?.sha256) { loaded = {path:data.path || path,inputPath:path,sha256:data.sha256,complete:true}; el('read-more').hidden = true; el('editor-note').textContent = (mutationMessage(data) || '已收到文件保存结果。') + '后续覆盖仍会核对当前版本。'; } });
    } finally {
      el('editor-path').readOnly = pathReadOnly;
      const current = el('editor-path').value.trim();
      el('editor-text').readOnly = !!loaded && !loaded.complete && (current === loaded.path || current === loaded.inputPath);
    }
  });
  el('delete-file').addEventListener('click',() => {
    const path = el('editor-path').value.trim();
    if (!loaded || (loaded.path !== path && loaded.inputPath !== path)) { say('请先读取要删除的文件，确认当前版本。',true); return; }
    task([{action:'delete',path,expectedSha256:loaded.sha256}],'delete',el('files-result'),result => { if (success(result)) { loaded = null; el('editor-text').value = ''; el('editor-text').readOnly = false; el('read-more').hidden = true; el('editor-note').textContent = '文件已删除，可到“恢复文件”查找副本。'; } });
  });
  el('deliver-file').addEventListener('click',() => { const path = el('editor-path').value.trim(); if (path) task([{action:'deliver',path}],'read',el('files-result')); else say('请填写文件路径。',true); });
  el('mkdir-form').addEventListener('submit',event => { event.preventDefault(); task([{action:'mkdir',path:el('mkdir-path').value.trim()}],'write',el('files-result')); });
  el('document-form').addEventListener('submit',event => { event.preventDefault(); task([{action:'document',path:el('document-path').value.trim(),title:el('document-title').value,paragraphs:el('document-body').value.split(/\n\s*\n/).filter(value => value.trim()),format:el('document-format').value,createOnly:true}],'write',el('documents-result')); });
  function mapping(value, kind) {
    const parts = value.split('=>');
    if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) throw new Error(kind + '请按“左侧路径 => 右侧路径”填写。');
    return parts.map(part => part.trim());
  }
  el('execute-form').addEventListener('submit',event => {
    event.preventDefault(); if (!need('execute')) return;
    try {
      const runtime = el('execute-runtime').value;
      if (runtime !== 'node') throw new Error('首版仅支持 Node.js；PowerShell 尚未验收，暂不开放。');
      const timeoutSeconds = Number(el('execute-timeout').value);
      if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > state.settings.taskTimeoutSeconds) throw new Error('本次超时必须在已保存的任务超时范围内。');
      const inputs = el('execute-inputs').value.split(/\r?\n/).filter(line => line.trim()).map(line => { const [path,name] = mapping(line,'输入文件'); return {path,name}; });
      const output = el('execute-output').value.trim(), outputs = [];
      if (output) { const [name,path] = mapping(output,'输出文件'); outputs.push({name,path,createOnly:true}); }
      task([{action:'execute',runtime,code:el('execute-code').value,timeoutSeconds,inputs,outputs}],'execute',el('execute-result'));
    } catch (error) { say(errorMessage(error),true); }
  });
  function loadBackups(append = false) {
    return task([{action:'backups',limit:50,...(append ? {offset:backupOffset} : {})}],'read',null,result => {
      const data = success(result); if (!data) return;
      const target = el('backup-list'); if (!append) { target.replaceChildren(); selectedBackup = null; el('backup-choice').hidden = true; }
      const items = Array.isArray(data) ? data : data.items || [];
      if (!items.length && !append) target.append(text('li','暂无可恢复副本。','muted'));
      for (const backup of items) {
        const row = text('li',''); row.append(text('strong',backup.path),text('p',date(backup.createdAt) + ' · ' + size(backup.size) + ' · ' + ({overwrite:'覆盖前',delete:'删除前',restore:'恢复前'}[backup.reason] || '文件副本'),'muted'));
        const button = text('button','选择此版本'); button.type = 'button'; button.dataset.requires = 'restore write'; button.addEventListener('click',() => { selectedBackup = backup; el('backup-choice').hidden = false; el('backup-choice-title').textContent = '恢复：' + backup.path + '（' + date(backup.createdAt) + '）'; }); row.append(button); target.append(row);
      }
      backupOffset = data.nextOffset; el('backup-more').hidden = !Number.isInteger(backupOffset);
    });
  }
  el('load-backups').addEventListener('click',() => loadBackups()); el('backup-more').addEventListener('click',() => loadBackups(true));
  el('restore-backup').addEventListener('click',() => {
    if (!selectedBackup) return;
    const operation = {action:'restore',backupId:selectedBackup.id};
    if (el('restore-mode').value === 'existing') {
      if (!loaded || loaded.path !== selectedBackup.path) { say('请先在“文件”页读取恢复目标的当前版本，再回来替换。',true); return; }
      operation.expectedSha256 = loaded.sha256;
    } else operation.createOnly = true;
    task([operation],'restore write',el('backups-result'),result => { if (success(result)) loaded = null; });
  });
  el('settings-form').addEventListener('submit',async event => {
    event.preventDefault(); if (busy || !state) return;
    try {
      const number = id => { const value = Number(el(id).value); if (!Number.isSafeInteger(value) || value < 1) throw new Error('天数、容量和超时须填写正整数。'); return value; };
      const settings = {...state.settings,grants:Object.fromEntries(capabilities.map(cap => [cap,el('grant-' + cap).checked])),scope:el('setting-scope').value,workspace:el('setting-workspace').value.trim(),backupKeepDays:number('setting-days'),backupMaxBytes:number('setting-bytes') * 1048576,maxFileBytes:number('setting-file-bytes') * 1048576,taskTimeoutSeconds:number('setting-timeout')};
      busy = true; gates();
      const saved = await api('settings',{revision:state.revision,settings}); state = {...state,...saved}; renderState(true); say('授权与设置已保存，对随后启动的任务生效。');
    } catch (error) { say(errorMessage(error),true); }
    finally { busy = false; gates(); }
  });
  el('refresh-tasks').addEventListener('click',async () => { try { await refresh(); say('任务状态已刷新。'); } catch (error) { say(errorMessage(error),true); } });
  refresh(true).then(() => say('请先确认“授权与设置”，未开放的能力保持关闭。')).catch(error => { say(errorMessage(error),true); gates(); });
})();
</script></body></html>`;
}
