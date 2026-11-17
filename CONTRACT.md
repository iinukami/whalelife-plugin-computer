# Computer 插件公开契约 v0.1.0

插件 ID 为 `computer`，manifest API 版本为 `1.0.0`。当前不发布扩展服务，也没有主干或 QQ 的强依赖。所有业务动作通过一个临时模型工具或经过宿主认证的 Web API 进入同一任务引擎。

## 模型工具

`computer_task({ operations: [...] })`，`danger: full`。`operations` 必须有 1–16 个动作，仅接受各动作声明的字段，拒绝携带来源、权限、目录范围或可复用授权令牌。

| action | 主要参数 | 所需勾选 |
| --- | --- | --- |
| `list` | `path?`, `offset?`, `limit?` | read |
| `search` | `path?`, `query`, `content?`, `offset?`, `limit?` | read |
| `read` | `path`, `offset?`, `limit?` | read |
| `write` | `path`, `text`, `expectedSha256?`, `createOnly?` | write |
| `edit` | `path`, `find`, `replace`, `expectedSha256` | read + write |
| `delete` | `path`, `expectedSha256` | delete |
| `mkdir` | `path` | write |
| `backups` | `offset?`, `limit?` | read |
| `restore` | `backupId`, `expectedSha256?`, `createOnly?` | restore + write |
| `document` | `path`, `format`, `title`, `paragraphs`, `expectedSha256?`, `createOnly?` | write |
| `execute` | `runtime: "node"`, `code`, `inputs?`, `outputs?`, `timeoutSeconds?` | execute；有输入另需 read，有导出另需 write |
| `deliver` | `path` | read |

相对路径基于已授权工作目录。全部文件范围允许普通本地绝对路径，仍排除受保护目录。文本为 UTF-8；`read.offset` 与 `nextOffset` 是 UTF-16 字符位置，分页不拆分代理对。`read.truncated` 表示本页不是整个文件，不等于还有下一页；是否有下一页取决于 `nextOffset`。目录列表默认 50 条，最多 200 条；读取正文默认请求 16,000 个字符，`limit` 最多 65,536。起止位置为保护代理对可能稍作扩展，返回单元数可略超 `limit`。

`write`、`document`、导出和 `restore` 覆盖已有文件时需要当前 SHA-256；缺失文件若提供旧摘要则冲突。`edit.find` 必须恰好匹配一次。`delete` 仅接受普通文件。文档格式为 `docx`、`md`、`html`，路径扩展名必须一致。

`execute.inputs` 最多 16 项，每项 `{ path, name }`；`outputs` 最多 16 项，每项 `{ name, path, expectedSha256?, createOnly? }`。`name` 是临时目录中的简单文件名，不可包含目录、保留设备名或大小写重复项。脚本工作目录只含输入副本，运行时文件位于另一只读目录。输入总量不超过单文件上限，输出逐文件校验。`timeoutSeconds` 范围 1–300，实际不超过任务设置。

工具请求字符串累计最多 768,000 字节、6,000 个节点、嵌套深度 5；`text`/`code` 每字段最多 256,000 个字符，原生脚本进一步限制为 128 KiB。文档最多 2,000 段、每段 16,000 字符、总文字 512,000 字节。较大的资料应分步处理。

工具临时内容正常形态：

```json
{
  "id": "task-uuid",
  "state": "completed",
  "steps": [{ "action": "write", "ok": true, "result": { "outcome": "created" } }]
}
```

`state` 为 `completed`、`failed` 或 `cancelled`；拒绝任务时为 `{ state: "rejected", error: { code, message }, retryAutomatically: false }`。外层工具调用 `ok` 仅表示协议调用完成，业务结果以这些字段为准。动作失败后不继续后续动作，已完成结果保留。

执行结果含 `status`、`exitCode`、`stdout`、`stderr`、`truncated`、`elapsedMs`、`saved`、`outputsImported` 及可选失败说明。`status` 正常且 `exitCode === 0` 才能导出；部分导出失败时 `saved` 保留成功项并提供 `importError`。清理失败提供失败状态或 `cleanupError`。超时和取消也不是成功。不得从“工具返回成功”或“文件生成成功”推断已向 QQ 发出文件。

整个工具临时返回超出 56,000 字节时省略正文并设置 `truncated: true`，保留部分导入及清理失败信息。元数据仍然过大时也省略路径，`savedCount` 表示原请求 `outputs` 中从第一项起已经确认保存的连续项数。调用者应缩小读取范围核对结果，不能重放已完成动作。持久回执仅保留受信任务编号、状态、动作及成功标记，不保存路径、文件正文、命令或输出。

## 来源核验

- Web：宿主会话提供 `channel=web`、`account=local`、`origin.plugin=core`。
- QQ：宿主会话提供 `channel=qq`、`origin.plugin=qq`、数字发送者、对应 `direct:<sender>`。通过公开 `qq_list_recipients` 核验在线状态、当前账号、当前收件人及白名单成员，缺失或不一致时拒绝。
- 自主性：`channel=plugin`、`account=autonomy`、`origin.plugin=autonomy`，并额外要求 `autonomous` 勾选。

这些字段依赖正常宿主调用链；不是对恶意插件自行伪造 ToolSession 的认证协议。文件或网页内容、引用消息以及模型参数都不能改变这些核验规则。

每项任务在队列中真正开始时核验来源与最新授权。异步核验期间设置发生变化则重新核验；持续变化时拒绝。任务开始后保存固定动作及设置快照；后续工具调用属于新任务。当前无公开整轮任务 ID，不建立模型可填写的“继续旧授权”机制。

## Web

所有路由由 `ctx.web` 注册，继承宿主认证及 HTTP 桥接。不要将它们脱离宿主开放成无认证服务。

| 路由 | 用途 |
| --- | --- |
| `GET /plugins/computer/settings` | 设置和手动任务页面 |
| `GET /plugins/computer/api/state` | `{ revision, settings, availability, tasks, limitations }` |
| `POST /plugins/computer/api/settings` | `{ revision, settings }`，保存完整设置；并发冲突拒绝 |
| `POST /plugins/computer/api/task` | `{ operations }`，返回任务结果 |
| `GET /plugins/computer/download?token=...` | 当前会话及文件版本绑定的下载 |

POST 只接受 `application/json`，正文上限 1 MiB。错误返回 `{ error: { code, message } }`。状态接口的执行探测 `check: "files-only"` 仅验证代理和运行时文件存在，不是一次实际启动验收。两项安装能力返回 `available: false`。任务列表为内存中最近 100 项最小状态，重启不会恢复或重放任务。

设置持久化经 `ctx.config.read/save('computer.json')`。所有能力初始为 false，`scope=workspace`；默认值及限制见 README。下载令牌随机生成、最多 100 个、30 分钟过期，只保存在内存中；停用清空。它不能绕过会话、当前读取授权和文件 SHA-256 检查。

## 对外部契约的需求

QQ 通用文件发送仍缺公开方法、文件输入约定和实际发送回执。本插件不会私调 OneBot、读取 QQ 私有配置或把本地路径当附件发出。需要提供方先给出公开契约，再接入此插件。

跨多次工具调用保留同一任务授权需要宿主提供不可由模型伪造的执行身份及生命周期。当前只支持固定批次。

网上冲浪插件的搜索、阅读和图片接口不等于通用文件下载，更不为其他子进程提供网络隔离。本版执行代理自行强制断网，联网协作与桌面控制留待后续版本。
