# WXcc 完整命令手册

本手册覆盖安装、命令语法、默认后端、原生账号与用户编号、历史查询、本地聊天副本编辑与撤销、本机发送目标、数据库发现与解密、REPL、JSON 集成和常见错误。所有名称、编号、PID 和路径示例均为虚构；替换为自己机器的实际结果。

## 先理解这些编号

| 标识 | 来自哪里 | 用于什么 | 是否可以从演示输出直接复制 |
| --- | --- | --- | --- |
| 真实用户 ID，如 `wxid_demo_friend` | 当前微信业务对象 | 内部精确路由 | 完整 ID 可用，部分隐藏的展示值不可用 |
| 用户编号 `u_0123456789abcdef` | 真实 ID 的 SHA-256 前 16 位十六进制 | `history --to`、`configure-target --to`、`send --to` | 使用本机登记且本次范围验证有效的编号 |
| 数据库编号 `d_0123456789abcdef` | 当前本人 ID 与库的相对路径的 SHA-256 前 16 位 | `db decrypt --database` | 使用当前账号 `db list` 的编号 |
| 副本编号 `c_0123456789abcdef0123456789abcdef` | 每次 `record import` 新建的本地副本 | `record` 的 `--copy` | 使用本机实际返回的 `copyId` |
| 记录编号 `m_0123456789abcdef` | 导入时为副本中的每条记录生成 | `record edit --record-id` | 使用该副本 `record show` 返回的 `recordId` |
| 修改编号 `e_0123456789abcdef0123456789abcdef` | 每次本地修改生成 | `record undo --change-id` | 使用该副本 `record edit` / `changes` 的实际 `changeId` |

用户名称完整显示，供人选择。名称不是路由 ID，同名联系人不会自动选第一个。编号不是列表行号：增加或排序不重新编号。用户改名不改变 `u_`；数据库相对路径变化会改变 `d_`。编号碰撞时拒绝覆盖。

编号提供稳定引用，不是匿名保证或访问授权。同一真实 ID 在不同机器可产生同一 `u_`，但每台机器必须自行登录、获取联系人快照和验证目标。不要搬运别人机器的 `data/recipients.json` 来规避这些验证。

## 安装与移植

当前原生环境为 Windows x64、Node.js 24 或更高版本、微信 4.1.15.13 x64。安装路径和 PID 可自动发现，二进制必须匹配 `profiles/4.1.15.13.json`：

```text
Weixin.dll SHA-256:
10f8e995453e2da46d4f2b5080cd6da1f13cc5147746adc119ceae38cb039de5
```

在程序目录执行：

```powershell
node --version
npm.cmd ci
.\wxcc.cmd help
```

`npm.cmd ci` 按锁文件安装依赖。分享的源码包不带 `node_modules`，接收者需自行安装。然后正常打开微信并登录：

```powershell
.\wxcc.cmd start
.\wxcc.cmd account
.\wxcc.cmd ids --keyword "测试联系人"
```

本机运行数据默认在程序 `data/` 中。换电脑分享程序文件与文档，在另一机器重新 `npm.cmd ci`、`start`、`account`、`ids`。发送目标也须在另一机器重新明确配置。不要分发以下内容：

- `data/`：真实 ID 映射、本人和目标配置、Token、宿主代次、发送账本、监听缓存与日志。
- `artifacts/`：本机分析、截图、历史测试输出和私有研究证据。
- 加密或明文数据库、数据库侧文件、密钥文件、个人配置、手工导出的聊天 JSON。
- 带真实姓名、正文、路径或回执的截图、日志与录屏。

原生读取和发送只适配有限版本；数据库只支持有限加密参数。自动发现和自动候选密钥提高移植便利性，不等于未知环境也能成功。

## 命令语法和输出

下文使用 PowerShell 的项目内入口 ` .\wxcc.cmd`；cmd 也可执行 `wxcc.cmd`，直接 Node 入口为 `node .\bin\wxcc.mjs`。已把可执行入口加入 PATH 时可使用帮助中的 `wxcc`。

```text
wxcc [全局选项] 命令 [命令参数] [全局选项]
```

选项可放在命令前后。`--key=value` 与 `--key value` 均支持；开关 `--json`、`--verbose`、`--pick`、`--no-redact` 不接受值。重复的值参数、未知参数、多余位置参数或不闭合引号会报错。含空格的名称、正文和路径必须用引号。

`--` 后的参数按位置参数处理，可用于以 `--` 开头的正文。正文采用 `--text` 更明确；不能把其他命令不支持的参数混用。只允许声明的参数，不会自动执行拼写猜测。

正常结果写入标准输出；错误写入标准错误。退出码：`0` 成功，`1` 运行失败，`2` 命令参数无效。REPL 单条命令错误会报告并继续等待下一条命令。

`--json` 输出 JSON；普通模式通常是格式化 JSON。`watch` 输出逐行 JSON（NDJSON）。不要把 stderr 合并到 stdout 后再当作一个 JSON 文档解析。发送选择器 `send --pick` 含交互与列表输出，不适合当作单个 JSON 对象的接口。

### 通用选项

| 参数 | 默认或范围 | 适用场景 |
| --- | --- | --- |
| `--json` | 关闭 | 成功结果和错误使用 JSON |
| `--redact true\|false` | `true` | 开关 ID 展示脱敏；凭据始终隐藏 |
| `--no-redact` | 不指定 | 等同主动设置 `--redact false` |
| `--backend NAME` | 依命令而定 | 显式选择后端，见后端表 |
| `--verbose` | 关闭 | `doctor` 返回更多安装诊断字段 |
| `--pid PID` | 自动选择唯一主进程 | `start` / 安装诊断；正整数，不能选微信子进程 |
| `--install-path DIR` | 自动发现 | 明确微信安装位置 |
| `--profile FILE` | 本版 profile | `start` 指定校验 profile，不可绕过实际支持的 ABI |
| `--timeout MS` | `start` 为 60000；自动取数据库密钥为 15000 | `start` 范围 1000–180000；`db decrypt` 自动密钥扫描范围 100–30000 毫秒 |
| `--token-file FILE` | 依后端和读写功能而定 | 本机宿主描述或 WeFlow Token 文件，不能互换 |
| `--data-root DIR` | 已知文件夹与注册表候选 | `db` 的 `xwechat_files` 数据根 |
| `--account-dir DIR` | 当前账号发现 | `db` 明确账号目录；WeFlow native 显式账号目录 |
| `--key-file FILE` | 未指定 | `db decrypt` 或 WeFlow native 的私有密钥文件 |
| `--root DIR` | WeFlow 原生资源默认目录 | `weflow-native` 资源根，推荐显式配置 |
| `--self SELF` | 原生读取自动获取 | 非原生监听和本机消息缓存的准确本人 ID；离线 `record import --input` 必填完整本人 ID |
| `--url URL` | WeFlow 环境配置或默认值 | `weflow-http` 本机 API |
| `--interval MS` | 1000 | 非原生 `watch` 轮询间隔；1–2147483647 |

通用解析允许的选项不代表每个命令都会消费该选项。例如 `--timeout` 不是历史查询或发送重试参数；`--pid` 不会自动改变已驻留宿主。

### 默认后端和能力

| 命令 | 默认后端 | 原生实现情况 |
| --- | --- | --- |
| `start`、`account`、`accounts`、`ids`、`history` | `reverse-native` | 当前账号、缓存联系人和最近个人会话历史 |
| `record import --to` | `reverse-native` | 读取指定历史并保存为本地副本；读取能力与相应历史后端相同 |
| `record import --input`、`record list/show/edit/changes/undo/export` | 不需要连接后端 | 完全离线操作 WXcc 私有聊天副本 |
| `configure-target`、`send`、`send-status`、`db` | `reverse-native` | 本机单目标发送及独立数据库模块 |
| `doctor`、`status`、`inspect` | `weflow-http` | 原生检查加 `--backend reverse-native` |
| `list`、`contacts`、`watch` | `weflow-http` | 当前没有原生会话列表或监听；联系人用 `ids` |
| `help`、`exit`、`quit` | 不需要后端 | 本地命令帮助或 REPL 控制 |
| `probe` | 不提供有效接收探针 | 已停用 |

`weflow-http` 使用另外部署的本机 API；`weflow-native` 使用有效兼容 WeFlow WCDB 资源及自己的密钥；`cache` 只读取 WXcc 曾保存的消息。HTTP / WCDB / cache 的历史目标并不自动解析原生 `u_` 编号，按相应后端要求提供完整会话 ID。

## 智能帮助

```powershell
.\wxcc.cmd help
.\wxcc.cmd help start
.\wxcc.cmd help history
.\wxcc.cmd help record
.\wxcc.cmd help record edit
.\wxcc.cmd record edit --help
.\wxcc.cmd help db decrypt
.\wxcc.cmd history --help
.\wxcc.cmd db decrypt --help
.\wxcc.cmd help --json
```

命令专属帮助包括说明、用法、示例、边界及推荐下一步。`help --json` 返回结构化命令目录、工作流和文档位置；`help history --json` 返回某条命令的结构化帮助。帮助不会连接宿主、读取账号、扫描数据库或发送消息。

例如错写 `hstory` 或 `--limt` 时，CLI 可能给出唯一最接近的建议。相近候选不唯一或距离太远时只提示查看帮助，不替使用者选择和执行。

## 启动和状态命令

### `start`

```text
wxcc start [--pid PID] [--install-path DIR] [--profile FILE]
           [--timeout MS] [--token-file FILE] [--json]
```

前置条件：微信已运行并登录、支持的 Windows x64 二进制、Node.js 24+、依赖已安装。安装发现读取路径元数据、运行进程、注册表与常见位置；唯一主进程自动选择，多个主进程须显式 `--pid`。

```powershell
.\wxcc.cmd start --json
.\wxcc.cmd start --pid 12345 --install-path "D:\Apps\Weixin" --timeout 60000 --json
```

返回 `ready`、`reused`、`pid`、`version`、`architecture`、`accountVerified`、`historyAvailable`、`automaticMessagesSent` 等摘要。`reused:true` 表示复用了匹配的就绪读取宿主。`ready:true` 是读取就绪，不表示发送可用。

`start` 不启动或重启微信，不发送消息。它保持只读宿主常驻；源代码改变、任务阻塞、身份不匹配或旧状态未知时拒绝覆盖。启动超时可能仍有宿主准备任务，应先检查状态，不反复删除锁或重复 attach。

### `doctor` / `status`

```text
wxcc doctor [--backend NAME] [--install-path DIR] [--pid PID] [--verbose] [--json]
wxcc status [同上]
```

`status` 是 `doctor` 同义命令。安装诊断不会运行微信 EXE 或加载微信 DLL。选择的后端会执行健康检查，原生检查复用已有宿主。

```powershell
.\wxcc.cmd doctor --backend reverse-native --json
```

重点字段：`installation.version` / `architecture` / `hashes` / `diagnostics`，`installation.processes` 的 `pid`、`parentPid`、`role`、`roleEvidence`，`connection` 与 `capabilities`。进程列表可能包含主进程与子进程，不能随便取第一条 PID。

读取和发送能力分开报告。安装存在、Token 描述存在或顶层 ready 并不能证明发送就绪。默认检查 `weflow-http`，若未部署 WeFlow 出现连接错误，不等于原生能力一定不可用。

### `inspect`

```text
wxcc inspect --backend reverse-native [--token-file FILE] [--json]
```

返回原生宿主与独立 `read` / `send` 状态。关注 `read.ready`、`historyAvailable`、`send.ready` / `sendAvailable`、`generation`、本人验证和未完成任务。顶层 `ready:true` 可能仅由读取侧提供。

默认只读描述 `data/native-read-host.json`，发送描述 `data/research-host.json`。`--token-file` 是高级明确选择，读取与发送文件应分别管理。描述中的 Token 不会输出，文件本身仍敏感。

## 账号、编号和聊天记录

### `account`

```text
wxcc account [--json] [--no-redact]
```

读取当前本人账号并登记自己的稳定编号，不需要手填 `--self`。结果 `scope:"current-account"`；`self` 为本人内部 ID，`displayName` 为完整名称，`alias` 为可用于本人会话读取的编号。PID / generation / accountVerified 验证当前来源，`automaticMessagesSent:0` 表示不发消息。

```powershell
.\wxcc.cmd account --json
```

### `accounts`

```text
wxcc accounts [--json]
```

当前实现返回运行代次已验证的当前一条账号，`accounts` 数组和 `complete:false`。不是电脑所有账号、历史登录者或所有数据文件的清单。切换账号后重新启动 / 核验读取状态。

### `ids`

```text
wxcc ids [--keyword NAME_OR_ALIAS] [--json] [--no-redact]
```

读取已加载联系人缓存，校验后登记本机映射。关键字按名称、编号或 ID 筛选。没有 `--keyword` 返回当前缓存全部记录，未保证完整通讯录。

```powershell
.\wxcc.cmd ids --keyword "测试联系人" --json
```

结果包含 `scope:"loaded-contact-cache"`、`complete:false`、`users`。每条用户含 `alias`、完整 `displayName`、默认部分隐藏的 `chatId`、`canSend`。`canSend:false` 不影响普通读取，它表示没有当前有效发送绑定。关键字查询或编号登记不授权发送。

选择时复制完整 `u_` 编号；不要复制含省略号 / 星号的展示 ID，不要把第几行或名称作为路由参数。

### `history`

```text
wxcc history --to USER [--limit 30] [--json]
wxcc history USER [--limit 30] [--json]
```

原生 USER 为本机登记编号或准确完整个人会话 ID，必须明确指定。其他人的会话须存在于当前验证的联系人缓存；本人会话可使用 `account.alias`。默认 limit 30，原生范围 1–200。

```powershell
.\wxcc.cmd history --to u_0123456789abcdef --limit 30 --json
```

输出 `messages` 数组及当前账号、目标与代次核验信息。消息 `serverId`、`id`、`type`、`createTime` 等使用十进制字符串；64 位 ID 不转换为 Number。`timestamp` 为已验证可精确表示的毫秒数，`text` / `content` 为实际返回正文，发言人缺失时 `isSelf:null`，不会猜成本人。

最近历史没有分页、全量导出或新消息监听。单次查询不自动保存正文。原生 `history` 不要求数据库解密；解密副本也不会自动变成 `history` 的另一个输入。

## 本地聊天副本：修改、撤销与导出

`record` 允许先取得指定聊天的历史，再修改保存在 WXcc `data/history-copies/` 中的本地副本。微信本机数据库、服务端记录、对方聊天及已有监听缓存均不改变。导入保留原文，每次修改和撤销都有历史；可以恢复某次修改前的内容。

直接 `record import --to` 读取指定会话，默认使用 `reverse-native`。`record import --input` 完全离线；保存后，`list`、`show`、`edit`、`changes`、`undo`、`export` 都不访问微信、不加载原生宿主、不发送消息。微信未运行时也可以编辑已有副本。

副本含完整原文及修改后的正文，变更日志也含修改前后的内容。默认输出 ID 脱敏不会清除正文和完整名称；这些本机副本与导出 JSON 都应留在私有目录，排除在源码、ZIP、截图及公开演示之外。

### `record import`：直接取得指定聊天

```text
wxcc record import --to USER [--limit 30] [--json]
```

```powershell
.\wxcc.cmd start
.\wxcc.cmd ids --keyword "测试联系人" --json
.\wxcc.cmd record import --to u_0123456789abcdef --limit 30 --json
```

使用本机登记的完整 `u_` 编号或精确完整个人会话 ID；不能用昵称、列表序号或脱敏 ID。账号及目标验证沿用 `history`，原生 `limit` 范围 1–200，默认 30；其他历史后端遵循其自身能力和限制。导入在服务内部取得未脱敏的原始历史，再建立副本，终端仍按隐私选项展示结果。

每次导入创建一个全新的副本，不会合并新消息、刷新旧副本或覆盖旧修改。成功返回 `copyId`、`source:"local-history-copy"`、`localOnly:true`、`revision:0` 等信息。`copyId` 格式为 `c_` 加 32 位十六进制；后续命令必须复制自己的实际返回值。副本摘要还包括 `accountAlias`、`chatAlias`、`displayName`、`messageCount`、`activeEditCount`、`edited`、`createdAt` 和 `updatedAt`，`origin.source` 保留导入来源。

### `record import`：离线导入已有历史 JSON

```text
wxcc record import --input FILE --self SELF [--to USER] [--json]
```

```powershell
.\wxcc.cmd record import --input "D:\Private\private-history.json" --self wxid_demo_self --to wxid_demo_friend --json
```

输入必须是普通文件，内容为有效 UTF-8 JSON，最大 64 MiB，最多 10000 条消息。对象形状为 `history --no-redact --json` 的返回对象：

```json
{
  "self": "wxid_demo_self",
  "chatId": "wxid_demo_friend",
  "messages": [
    {
      "id": "0",
      "chatId": "wxid_demo_friend",
      "senderId": "wxid_demo_friend",
      "isSelf": false,
      "type": "text",
      "timestamp": 1791321600000,
      "text": "虚构的原始正文"
    }
  ]
}
```

`self` / `chatId` 是可选文件字段；命令行 `--self` 必须明确给出精确完整本人 ID。如果文件也有 `self`，必须一致。`--to` 支持精确完整聊天 ID 或本机已登记的 `u_` 编号；省略时从文件 `chatId` 或所有消息证明唯一聊天。所有消息须符合该本人和聊天范围，混合聊天、冲突目标、无法确认唯一聊天或脱敏 ID 都会被拒绝。离线编号解析只读取本机登记数据，不会访问微信补齐缺失编号。

默认脱敏的 `history --json` 结果不能直接作为原始导入材料。需要保存完整历史时使用 `history --no-redact --json`，把文件留在私有目录。消息 `id`、`serverId` 等来源 ID 应保留十进制字符串，避免把 64 位值转成 JS Number / PowerShell `[double]`。文件导入不需要数据库密钥或原生宿主。

### `record list` / `record show`

```text
wxcc record list [--json]
wxcc record show --copy COPY [--limit 30] [--json]
```

```powershell
.\wxcc.cmd record list --json
.\wxcc.cmd record show --copy c_0123456789abcdef0123456789abcdef --limit 30 --json
```

`list` 不需要额外参数，以 `copies` 数组列出已有副本。`show` 返回副本摘要、当前 `revision` 及 `messages` 数组中每条记录的 `recordId`；`limit` 为 1–10000，默认 30。`recordId` 格式为 `m_` 加 16 位十六进制，由 `copyId` 和原始行号生成，在同一副本内固定，不会因修改正文或时间而变化；重新导入会生成新 `copyId` 和新 `recordId`。消息的 `source:"local-history-copy"` / `localOnly:true` 标明本地副本，`message.origin.source` 保留该消息的原始来源；当前有效修改存在时，消息和副本的 `edited` 为 true。

来源消息 `id` 保持完整字符串，不会因为建立副本而重新编号。它可能重复，包括多个 `"0"`。本地 `recordId` 用于准确区分这些记录；不要把 `recordId`、来源 `id` 和 `changeId` 互换。

### `record edit`

```text
wxcc record edit --copy COPY (--record-id RECORD | --message-id SOURCE_ID)
  [--text TEXT | --text-file FILE] [--timestamp MS] [--revision N] [--json]
```

必须使用 `--record-id` 或 `--message-id` 精确选中一条记录，二者互斥。至少提供正文或 `--timestamp`；`--text` 与 `--text-file` 互斥，可与 `--timestamp` 一起使用。只允许修改正文和时间，不能改变本人、聊天、发言人身份或来源消息 ID。

```powershell
.\wxcc.cmd record edit --copy c_0123456789abcdef0123456789abcdef --record-id m_0123456789abcdef --text "本地修改示例" --revision 0 --json
.\wxcc.cmd record edit --copy c_0123456789abcdef0123456789abcdef --record-id m_0123456789abcdef --text-file "D:\Private\replacement.txt" --revision 1 --json
.\wxcc.cmd record edit --copy c_0123456789abcdef0123456789abcdef --record-id m_0123456789abcdef --timestamp 1791321600000 --revision 2 --json
```

空字符串正文合法，可在支持保留空参数的终端中使用 `--text ""`，或通过空的 UTF-8 `--text-file` 提供。直接正文和正文文件均须为有效 Unicode、不能包含 NUL，最多 1 MiB（1048576 UTF-8 字节）；正文文件须是有效 UTF-8。含引号、换行或长正文时推荐私有 `--text-file`。

`--timestamp` 是毫秒整数，不是秒或本地时间字符串。`timestamp` 与 `revision` 均要求 0–9007199254740991 的整数（JavaScript `Number.MAX_SAFE_INTEGER`），`revision:0` 合法。建议把 `show` 返回的当前版本传入 `--revision`：若期间已有修改或撤销，旧版本会拒绝修改，避免覆盖自己尚未查看的变化。

也可以使用 `--message-id "完整来源消息ID"`，按字符串精确匹配；匹配多条时拒绝，不会自动选择第一条，应改用 `show` 返回的 `recordId`。每次修改把副本 `revision` 加 1，返回 `changeId`（`e_` 加 32 位十六进制）、`recordId`、`messageId` 和副本摘要字段。原文及修改前后内容继续保留。含原文及审计的单份副本最多 64 MiB，每份副本最多 10000 次修改、20000 个总审计事件（含撤销）。每次修改会预留当前有效修改未来撤销所需的空间，达到修改次数或空间上限后，已有保存修改仍可按顺序撤销。

### `record changes` / `record undo`

```text
wxcc record changes --copy COPY [--limit 30] [--json]
wxcc record undo --copy COPY [--change-id CHANGE] [--revision N] [--json]
```

```powershell
.\wxcc.cmd record changes --copy c_0123456789abcdef0123456789abcdef --limit 30 --json
.\wxcc.cmd record undo --copy c_0123456789abcdef0123456789abcdef --revision 3 --json
```

`changes` 包含修改前 `before`、修改后 `after` 和撤销事件；`limit` 范围 1–10000，默认 30。变更历史同样会暴露原文，分享终端输出前应使用虚构材料。

省略 `--change-id` 时，撤销最近尚未撤销的修改。也可按 `changes` 的实际 `changeId` 指定目标：

```powershell
.\wxcc.cmd record undo --copy c_0123456789abcdef0123456789abcdef --change-id e_0123456789abcdef0123456789abcdef --revision 3 --json
```

撤销目标必须是该条记录当前最新的有效修改。若先对同一记录修改 A、再修改 B，不能直接撤销 A；先撤销 B，再撤销 A。其他记录的修改不构成同一条记录的覆盖。已撤销、未知或不属于该副本的修改不能再次撤销。

`--revision` 同样可保护当前版本。撤销恢复该次修改前的正文和时间，保留历史并更新副本版本；返回 `undoId`、被撤销修改的 `changeId`、`recordId`、`messageId` 和副本摘要，不会删除原始历史，也不会触及微信。可连续查看 `changes` 和执行 `undo`，恢复每条记录最初导入的内容。所有有效修改都撤销后 `edited:false`，版本和审计历史仍保留。

### `record export`

```text
wxcc record export --copy COPY --output NEW_FILE [--no-redact] [--json]
```

```powershell
.\wxcc.cmd record export --copy c_0123456789abcdef0123456789abcdef --output "D:\Private\edited-history.json" --json
```

输出当前副本内容到新的 JSON 文件，不覆盖已存在的路径；重试或导出另一版本时使用新文件名。禁止输出到微信实时 `db_storage` 目录或程序源码位置，选择自己私有的数据目录。输出最多 64 MiB；所有导出始终附带 `source:"local-history-copy"`、`localOnly`、`edited`、`revision`、`exportedAt`、`redacted` 等元数据，保留这是 WXcc 本地副本及其修改状态的标记。命令成功结果包括 `ok`、`copyId`、`revision`、`messageCount`、`edited`、`redacted` 和 `bytes`，不会把私有输出路径写到标准输出。

默认沿用 `--redact true`，对文件中的 ID 脱敏；主动指定 `--no-redact` 或 `--redact false` 才关闭 ID 脱敏。完整名称与正文不会自动隐藏，因此即使脱敏导出仍是私人聊天数据。完整 ID 的导出也保留本地副本标记，不能代表微信或对方记录已更改。

## 目标配置、发送与账本

### `configure-target`

```text
wxcc configure-target --to USER [--json]
wxcc configure-target USER [--json]
```

明确选择当前本人账号快照中的一个个人联系人，保存到本机 `data/native-target.json`。USER 为已登记 `u_` 或准确完整 ID；不能用名称，不能配置群聊、公众号或服务会话。

```powershell
.\wxcc.cmd configure-target --to u_0123456789abcdef --json
```

此命令不发送消息，结果 `configured:true`、`requiresFreshSendBinding:true`、`automaticMessagesSent:0`。配置绑定本人、目标、名称和二进制，实际发送还需要单独发送宿主、准确目标及新的运行代次绑定。

同一本人账号重启后可重新核验并建立绑定；切换账号、目标或版本时重新配置。已经驻留的发送代次若绑定其他目标，不自动替换它。分享程序时不带目标配置。

### 发送宿主初始化

这是独立宿主入口，不是 `wxcc start --send`：

```powershell
.\wxcc.cmd doctor --backend reverse-native --json
.\wxcc-native-host.cmd --pid 12345 --send
```

PID 须从当前主进程诊断选择。`--send` 加载并准备原生 agent、核验账号和目标、建立 `data/native-send-binding.json`，不自动发送。读取宿主和发送宿主分开，`--read` / `--send` 互斥。已有宿主重新核验可用 `node .\src\native-runtime-bootstrap.mjs`。

### `send`

```text
wxcc send (--to USER | --session STATE | --pick) --text TEXT
          [--request-id UNIQUE] [--json]
wxcc send USER TEXT [--request-id UNIQUE]
```

三种目标形式互斥。USER 使用本机单目标编号或完整 ID；STATE 使用有效绑定会话状态，也可解析绑定目标编号。部分隐藏展示值不可用。发送前检查 `inspect --backend reverse-native` 的 **`send.ready:true`**。

```powershell
.\wxcc.cmd send --to u_0123456789abcdef --text "命令测试" --request-id demo-001 --json
.\wxcc.cmd send --pick --text "命令测试" --request-id demo-002
```

`--pick` 先获取本次编号列表再等输入，只接受本次列表中 `canSend:true` 的目标。输入 `cancel`、空输入或结束输入可取消；不会自动选择第一个。选人流程含交互，不作为单对象 JSON 接口使用。

正文非空、不全为空白、Unicode 完整、不含 NUL，UTF-8 最多 1024 字节。当前仅文字，群发、群聊、文件、图片和语音发送未实现。

请求 ID 为 1–128 位 ASCII，首位字母或数字，其余可含 `._:-`，规范化小写；省略自动 UUID。账本在原生入口前保留请求，同一 ID 不会重复发送。新的消息使用新的 ID；结果未知不能换 ID 盲目补发。

`accepted` 是客户端内部提交成功，`deliveryConfirmed:false` 不能解释为发送失败，也不能解释为对方已收到。独立服务端 ACK 和已读接口尚未实现。超时和回执异常报告 unknown，不自动重试。

### `send-status`

```text
wxcc send-status --request-id UNIQUE [--json]
```

离线读本机持久化账本，不连接发送业务或重发。主要状态 `reserved`、`accepted`、`failed`、`unknown`；账本不存在报 `E_SEND_REQUEST_UNKNOWN`，不能据此断定消息从未发出。

```powershell
.\wxcc.cmd send-status --request-id demo-001 --json
```

更多绑定、回调及恢复边界见 [原生发送说明](native-send.md)。

## 数据库命令

数据库模块独立于 WeFlow WCDB 资源和发送 adapter。目标是发现当前账号库，并生成经过认证的明文副本；它不修改或写回实时微信数据库，不提供跨库事务一致性，也不承诺任意加密版本均可解密。

### `db list` / `db status`

```text
wxcc db list [--data-root DIR] [--account-dir DIR] [--json]
wxcc db status [同上]
wxcc db [同上]
```

省略子命令等同 `status`。当前 list/status 均返回数据库发现摘要和条目。先 `start`，模块自动读当前本人账号，再查已知 Documents、注册表及显式路径中的 `xwechat_files` / `db_storage`。

```powershell
.\wxcc.cmd db list --json
.\wxcc.cmd db status --data-root "D:\WechatData\xwechat_files" --json
```

目录匹配采用完整本人 ID 的精确名称或严格后缀形式，拒绝猜测最新、相似前缀或其他账号。多个有效候选需要明确选择，必要时指定账号目录：

```powershell
.\wxcc.cmd db list --data-root "D:\WechatData\xwechat_files" --account-dir "D:\WechatData\xwechat_files\wxid_demo_self_demo" --json
```

此路径是虚构结构示例；实际账号目录必须与当前本人 ID 对应，不能拿任意其他目录强行指定。当前默认发现上限为 512 个 `.db`，存储子目录最多 4 层，跳过符号链接。

公共摘要不输出账户目录、绝对路径、salt 或 key。主要字段：

| 字段 | 含义 |
| --- | --- |
| `accountAlias`、`accountDisplayName` | 当前本人稳定编号和完整名称 |
| `databaseCount`、`encryptedCount`、`totalBytes` | 数量和文件大小汇总 |
| `directoryMatchVerified:true` | 目录命名关系已匹配，不等于密码学归属已验证 |
| `binding:"pending-page-auth"` | 仍待当前进程密钥与文件页面认证 |
| `accountVerified:false` / `cryptographicAccountVerified:false` | 此处指数据库归属未完成认证；不否定前置原生本人账号验证 |
| `databases[].alias` | `d_` 稳定编号，用于后续选择 |
| `databases[].kind` | 文件所在类型目录，如 session、message、contact 或 other；不输出原文件名 |
| `bytes`、`encrypted`、`walBytes`、`aligned4096` | 文件元数据；页对齐不证明支持的加密格式 |

库大小、类型和个数也可能反映使用信息，公开演示时仍应使用测试账号。

### `db decrypt`：当前账号自动密钥

```text
wxcc db decrypt --database DB --output NEW_FILE [--json]
```

```powershell
.\wxcc.cmd db decrypt --database d_0123456789abcdef --output "D:\Private\session-copy.sqlite" --json
```

DB 必须是当前本人发现结果的 `d_` 编号。没有 `--key-file` 时，只读扫描当前已验证微信主进程的有限内存候选；核验进程路径、宿主版本和 DLL，并在读取前后确认同一本人账号、PID 和 generation。候选须通过选定数据库首页 HMAC 与 SQLite 头部认证，不能只靠“看起来像 64 位十六进制”就接受。

自动模式不打印或保存候选密钥，不要求重新登录或重启微信，不调用发送入口。没有可认证候选时明确失败，不能承诺任意机器的内存都有可发现的候选。可改用自己的 `--key-file`。

只有当前进程候选验证及导出成功时，返回 `accountCryptographicBinding:true`、`binding:"current-process-page-auth"`。账号在读取期间或发布前变化会停止；只选中了同名目录不构成这项证明。

自动密钥扫描默认限时 15000 毫秒，读取预算 512 MiB。`--timeout 100–30000` 可调整取密钥时限，不能调整整个解密时限。它尝试盐匹配的文本 key specification 和有限 SQLCipher 二进制上下文候选，任何候选都必须通过页面认证；未加载的库、定制上下文或超出扫描预算仍可能无法自动取得。

当前本机自动取密钥实测仍返回 `E_DB_KEY_NOT_FOUND`，因此还没有真实数据库自动解密成功的验证记录。模块的 raw key、32 字节 passphrase、逐页认证、WAL 重放及完整性检查使用合成 SQLite 库验证；这不替代实际客户端加密参数适配。

### `db decrypt`：自己的密钥文件

```text
wxcc db decrypt --database DB --key-file FILE --output NEW_FILE
                [--key-mode raw|passphrase|auto] [--json]
```

```powershell
.\wxcc.cmd db decrypt --database d_0123456789abcdef --key-file "D:\Private\db-key.txt" --output "D:\Private\session-copy-2.sqlite" --json
```

当前密钥文件支持以下格式，最大 256 字节：

- 32 字节的二进制密钥文件。
- 64 位十六进制文本，表示 32 字节。
- SQLCipher `x'64hex'` 形式，或 `x'96hex'` 形式（32 字节 key 加 16 字节 salt）。

`64hex` / `96hex` 是格式说明，不是可以写入文件的有效密钥。文本首尾空白会移除；附带 salt 时必须匹配当前库首页。工具不提供 `--key 明文` 或把 key 显示到日志的参数。

`--key-mode` 默认 `raw`：32 字节直接作为 AES key；`passphrase` 将这些 32 字节按相应参数做 PBKDF2；`auto` 有限尝试两种模式。当前不是任意长度密码解密器。`--key-mode` 仅配合显式 `--key-file`，不能用于自动进程模式。

手动 keyfile 导出报告 `accountCryptographicBinding:false`、`binding:"directory-match-key-file-auth"`：它证明页面可用该 key 解密，不能证明 key 来源于当前微信进程。不会把手动 key 认证冒称为自动当前账号认证。

### 离线 `db decrypt --input`

```text
wxcc db decrypt --input ENCRYPTED_FILE --key-file FILE --output NEW_FILE
                [--key-mode raw|passphrase|auto] [--json]
```

```powershell
.\wxcc.cmd db decrypt --input "D:\Private\Encrypted\session.db" --key-file "D:\Private\db-key.txt" --key-mode raw --output "D:\Private\Offline\session-copy.sqlite" --json
```

`--database` 和 `--input` 必须且只能选一个。离线模式必须给 `--key-file`，不连接读取宿主，不扫描进程，不需要先 `start`；没有 current-process 归属证明，`source:"offline-database-copy"`、`accountCryptographicBinding:false`。

如果离线库来自仍使用 WAL 的数据库，复制时也需拿到与主库一致的 `文件名-wal`，不能把不一致的文件随意拼起来。模块检查同目录同名侧文件，并只应用合法已提交事务。

### 输出限制、加密参数和结果

输出 `--output` 必須明确指定，目标不能存在、不能位于实时库的 `db_storage` 内、不能等于输入或其侧文件。使用新的私有文件名；工具不覆盖旧副本。输出父目录会创建，明文临时文件采用受限目录权限，全部验证通过才发布。

当前支持以下有限 profile，未知参数明确失败：

| profile | 页大小 | 保留区 | HMAC / KDF |
| --- | --- | --- | --- |
| `sqlcipher4-4096` | 4096 | 80 | SHA-512 / 256000 次 SHA-512 PBKDF2 |
| `sqlcipher3-4096` | 4096 | 48 | SHA-1 / 64000 次 SHA-1 PBKDF2 |
| `sqlcipher3-1024` | 1024 | 48 | SHA-1 / 64000 次 SHA-1 PBKDF2 |

模块先双读主库与 WAL，核对文件元数据及内容一致性；默认最多 3 次稳定快照尝试，单个主库或 WAL 默认大小上限 256 MiB。当前 CLI 未提供放大该上限的参数。存在活动 rollback journal、持续变化或同代次撕裂 WAL 时不发布。

全部主库页和已提交 WAL 页验证 HMAC，再解密已提交页面。WAL header/checksum/事务提交检查通过后输出独立快照，不生成额外明文 WAL。最后只读打开副本验证 schema 与 `PRAGMA quick_check`，不加载 SQLite 扩展。

返回 `ok`、`profile`、`keyMode`、`pages`、`bytes`、`authenticatedPages`、`quickCheck:"ok"`、`schemaObjects` 和 `wal` 摘要。`wal.committedFrames` 表示处理的已提交帧，`uncommittedFrames` 不作为已提交记录导出；`staleBytes` 仅代表识别出的旧 WAL 尾部。摘要不含 key、盐和明文正文。

**输出文件包含完整明文数据库，未做 ID 或正文脱敏。** 即使 CLI `--redact true`，副本仍有真实账号、联系人、消息与其他个人内容。不要放入项目分发目录、公开仓库或分享 ZIP。单库快照不保证 message/session/contact 等多个库之间同一时刻一致，也不保证 SQLite `quick_check` 能检测所有业务语义错误。

## 其他读取后端

### `list`

```text
wxcc list [--keyword NAME] [--backend weflow-http|weflow-native|cache]
```

读取对应后端会话，返回 `chats`。原生 reverse-native 尚未实现该命令。cache 仅查询已保存消息构建的会话索引，并需要准确 `--self` 隔离账号，不主动获取微信消息。

### `contacts`

```text
wxcc contacts [--keyword NAME] [--backend weflow-http|weflow-native]
```

通过外部 WeFlow 读取后端获取联系人，返回 `contacts`；原生联系人请使用 `ids`。cache 不含联系人。参数支持程度和结果数量由后端决定。

### WeFlow HTTP 历史和监听

```powershell
.\wxcc.cmd history --backend weflow-http --to wxid_demo_friend --self wxid_demo_self --token-file "D:\Private\weflow-token.txt" --limit 30 --json
.\wxcc.cmd watch --backend weflow-http --to wxid_demo_friend --self wxid_demo_self --token-file "D:\Private\weflow-token.txt" --interval 1000
```

需另外部署自己的 WeFlow API，配置本机 URL 和 Token。`--token-file` 在这个后端是 API Token 文本文件，不是原生宿主 JSON 描述。完整 ID 示例是虚构占位值。

### WeFlow native 历史和监听

```powershell
.\wxcc.cmd history --backend weflow-native --root "D:\Tools\WeFlow" --account-dir "D:\WechatData\xwechat_files\wxid_demo_self_demo" --key-file "D:\Private\db-key.txt" --self wxid_demo_self --to wxid_demo_friend --limit 30 --json
```

需要有效兼容的原生 WCDB 资源及自己的 key；第三方组件保护或授权检查失败会报错，不绕过。新 `db` 模块无需这个第三方组件，不能把两套参数和状态混为一谈。

### `watch`

```text
wxcc watch --to CHAT --self SELF [--interval 1000]
           [--backend weflow-http|weflow-native]
```

轮询指定个人会话的新消息，输出 NDJSON，并将标准化记录保存到本机账户隔离缓存。Ctrl+C 停止本次监听，REPL 中回到命令输入。只保存目标会话；不能省略 `--to` 或准确 `--self`。reverse-native 和 cache 尚不提供 watch。

### `probe`

旧接收探针已停用，会明确报 `E_PROCESS_HOOK_DISABLED`。当前不加载相关探针来自动恢复。不要把它当作可用的原生监听命令。

## REPL 和选项继承

```powershell
.\wxcc.cmd
.\wxcc.cmd --json
```

无命令进入 REPL。在 `wxcc>` 后输入 `help`、`start`、`account`、`ids`、`history` 等，不再输入 `wxcc` 前缀。启动时提供的全局选项作为默认值，每条命令可以覆盖；例如启动 `--json` 后单条输出均为 JSON。命令间若选项变化需重建客户端，宿主继续驻留。

引号支持单引号、双引号；Windows 路径分隔符保持字面含义。需要双引号内的引号时可使用 `\"`。`exit` / `quit` 仅退出 REPL，不停止微信或常驻宿主；单次 CLI 中执行它们会提示只用于 REPL。

## 环境变量和配置

| 变量 | 用途 | 说明 |
| --- | --- | --- |
| `WXCC_WEIXIN_PATH` | 默认微信安装路径候选 | 可被 `--install-path` 明确覆盖 |
| `WXCC_CONFIG` | 安装发现的 JSON 配置路径 | 支持 `installPath` / `weixinPath`；配置仍是本机数据 |
| `WXCC_WEFLOW_URL` | WeFlow HTTP 本机 API 地址 | 新原生读取无需它 |
| `WXCC_WEFLOW_TOKEN` | WeFlow HTTP Token | 明确 `--token-file` 时改读文件；不要记录或分享环境值 |
| `WXCC_WECHAT_DB_KEY` | 旧 WeFlow native 密钥来源 | 新 `db decrypt` 不使用此变量，采用私有 keyfile 或自动候选 |

安装发现还可读取 `%APPDATA%\WXcc\config.json`。配置示例只包含安装路径，不应加自己的 key 或联系人名单：

```json
{"installPath":"D:\\Apps\\Weixin"}
```

## 常见错误与下一步

错误 JSON 为 `{"error":{"code":"...","message":"...","hint":"..."}}`；`hint` 按已知错误提供建议，不保证每个错误都有。示例中的 `...` 是说明，不是实际输出。

| 错误或现象 | 原因 | 下一步 |
| --- | --- | --- |
| `INVALID_ARGUMENT` | 命令、参数、范围或互斥项错误 | `help <命令>`，检查引号和必填参数 |
| `WEIXIN_INSTALL_NOT_FOUND` | 未发现完整安装 | `--install-path` 或 `WXCC_WEIXIN_PATH` |
| `WEIXIN_INSTALL_AMBIGUOUS` | 多个运行安装候选 | 明确安装位置或 PID |
| `E_WEIXIN_NOT_RUNNING` | 微信未运行 | 正常打开并登录，然后 `start` |
| `E_NATIVE_PID_REQUIRED` | 无法证明唯一主进程 | `doctor --backend reverse-native` 后明确主 PID |
| `E_NATIVE_VERSION_UNSUPPORTED` / `E_NATIVE_HASH` | 版本 ABI 或 DLL 不匹配 | 使用确实支持的二进制或其他后端，不能只改 profile 放行 |
| `E_NATIVE_READ_CONFIG` / `E_NATIVE_HOST_OFFLINE` | 无就绪读取宿主 | 先 `start`，检查本机日志；不要分享 Token |
| `E_NATIVE_START_BUSY` | 另一初始化或未明确的旧锁 | 检查当前宿主进程与状态，不删除未知锁反复 attach |
| `E_NATIVE_START_TIMEOUT` | 初始化超时 | 先检查状态与日志，可能已有未完成准备 |
| `E_NATIVE_READ_SOURCE` | 驻留脚本源码与程序不一致 | 保留状态，在新的受控运行代次准备；不覆盖驻留脚本 |
| `E_NATIVE_READ_BUSY` | 原生任务或回调未完成 | 等结束后检查状态，持续阻塞需恢复新的运行代次 |
| `E_RECIPIENT_UNKNOWN` / `E_RECIPIENT_ALIAS` | 编号未登记或格式错误 | `ids --keyword "名称"`，使用实际完整编号 |
| `E_CHAT_SCOPE` | 目标不在当前范围或为群/公众号等 | 精确选择当前个人联系人，不用昵称或脱敏 ID |
| `E_NATIVE_TARGET` / `E_NATIVE_TARGET_SCOPE` | 缺少目标或快照不一致 | `account`、`ids`、`configure-target`，配置本身不发送 |
| `E_NATIVE_TARGET_CHANGED` / `E_NATIVE_GENERATION` | 目标或运行代次已变化 | 不复用旧 agent 绑定；新代次重新验证 |
| `E_NATIVE_SEND_NOT_READY` | 发送门禁未通过 | 检查 `inspect.send`，初始化和二进制验证均需通过 |
| `E_SEND_REQUEST_UNKNOWN` | 本机账本没有记录 | 不能当作未发送；核对原请求 ID 与客户端 |
| `E_NATIVE_OUTCOME_UNKNOWN` / transport timeout | 发送可能已提交 | 保留 ID、查询账本并核对，禁止自动重发 |
| `E_DB_NOT_FOUND` / `E_DB_ACCOUNT_BINDING` | 当前本人数据目录未找到或对应关系不符 | 指定准确 `--data-root` / `--account-dir`，不能指向别的账号 |
| `E_DB_AMBIGUOUS` | 多个同账号候选目录 | 明确根和账号目录，不按最近修改时间猜测 |
| `E_DB_UNKNOWN` | d_ 不在当前发现结果 | 重新 `db list`，切账号后不复用旧编号 |
| `E_DB_KEY_PROVIDER` / `E_DB_AUTO_KEY` / `E_DB_KEY_NOT_FOUND` | 自动候选不足或不可读 | 使用自己的私有 `--key-file`，不要把 key 贴入命令或日志 |
| `E_DB_KEY_INVALID` / `E_DB_CIPHER_PROFILE` | key、salt、模式或参数不匹配 | 检查自己的 keyfile / `--key-mode`，未知格式不放行 |
| `E_DB_PAGE_AUTH` / `E_DB_WAL` | 页认证或 WAL 格式/提交失败 | 不发布副本，取得一致的源文件后再分析 |
| `E_DB_SNAPSHOT_BUSY` / `E_DB_JOURNAL` | 活跃事务或持续变化 | 待客户端正常完成事务后重试，不强行删侧文件 |
| `E_DB_OUTPUT_EXISTS` / `E_DB_LIVE_OUTPUT` | 输出已存在或位于实时库内 | 选新的私有输出路径 |
| `E_DB_OUTPUT_PERMISSIONS` / `E_DB_CLEANUP` | 明文目录权限或清理失败 | 检查本机目录权限与残留，勿分享该目录 |
| `E_DB_INTEGRITY` | 解密副本未过 schema / quick_check | 不把不完整副本当成功结果 |
| `E_UNSUPPORTED` / `E_PROCESS_HOOK_DISABLED` | 当前后端能力未实现 | 原生联系人用 ids；监听选已配置的读取后端 |
| `E_RECORD_SELF` / `E_RECORD_ACCOUNT` / `E_RECORD_CHAT` | 缺完整本人 ID、账号冲突、聊天混合/不明确或存在脱敏身份 | `help record import`；离线 `--self` 必填完整 ID，确认唯一聊天和精确目标 |
| `E_RECORD_INPUT` / `E_RECORD_TEXT` / `E_RECORD_TEXT_FILE` | 输入不是有效 UTF-8 JSON 普通文件，文件变化/超限，正文无效、含 NUL 或超过 1 MiB | 使用稳定私有输入，检查 UTF-8、JSON、文件大小及互斥参数 |
| `E_HISTORY_COPY_ARGUMENT` / `E_HISTORY_COPY_CHAT_MISMATCH` | 副本/记录编号、消息形状、范围、毫秒时间或版本格式无效 | `help record edit`；检查实际编号，导入消息须属于同一聊天，时间和版本使用非负安全整数 |
| `E_HISTORY_COPY_NOT_FOUND` / `E_HISTORY_COPY_MESSAGE_NOT_FOUND` | 副本不存在或消息不属于该副本 | `record list` / `show` 获取该副本实际编号 |
| `E_HISTORY_COPY_MESSAGE_AMBIGUOUS` | 多条来源消息 ID 相同 | 使用 `record show` 返回的唯一 `--record-id` |
| `E_HISTORY_COPY_REVISION_CONFLICT` | 修改或撤销使用旧版本 | 重新 `record show` 并核对当前内容和版本后操作 |
| `E_HISTORY_COPY_UNDO_NOT_FOUND` / `E_HISTORY_COPY_UNDO_ORDER` | 无有效撤销目标、已撤销或同记录存在后续修改 | `record changes`；先撤销该记录最新有效修改 |
| `E_HISTORY_COPY_BUSY` / `E_HISTORY_COPY_STORE` / `E_HISTORY_COPY_PATH` | 副本锁定、写入失败、私有目录或文件不是安全普通路径 | 等当前操作结束，检查本机私有目录及权限；不盲目删除锁或手改副本 |
| `E_HISTORY_COPY_CORRUPT` / `E_HISTORY_COPY_SIZE` / `E_HISTORY_COPY_COLLISION` | 副本/审计损坏、修改及预留撤销空间超过 64 MiB、修改达到 10000 次（总审计事件上限 20000）或编号碰撞 | 保留原文件，检查错误；达到修改上限后已有保存修改仍可按顺序撤销，不手改审计或覆盖现有副本继续操作 |
| `E_RECORD_OUTPUT` / `E_RECORD_OUTPUT_SCOPE` / `E_RECORD_OUTPUT_EXISTS` | 输出无效/超限、处于源码或微信数据目录、文件已存在 | 选新的私有输出文件，置于程序和实时数据目录之外 |
| `E_RECORD_OUTPUT_PERMISSIONS` / `E_RECORD_CLEANUP` | 导出访问权限设置失败或临时私有文件清理失败 | 检查本机目录权限与残留，避免发布或分发该目录 |

## 隐私与实际验证范围

默认 ID 脱敏可用于减少演示直接泄露，但不会删除完整名称、正文中所有敏感内容或明文数据库数据。凭据即使 `--no-redact` 仍隐藏。公开输出建议使用测试账号和虚构消息，避免实际好友名称、数据库副本与本机路径。

已有匹配版本的原生账号、联系人、历史与授权文字发送验证；新安装发现、配置和数据库行为仍应按实际目标机器验证。自动 key 不是一个“保证解密所有机器”的开关。未知版本、未知加密参数、跨库一致性、全量原生通讯录、原生监听、历史分页和媒体发送均不在现有承诺中。

返回 [README](../README.md)。完整操作、脚本和公开演示示范见 [examples.md](examples.md)。
