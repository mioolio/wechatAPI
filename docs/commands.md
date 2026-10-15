# WXcc 命令使用手册

WXcc 可以读取当前微信账号、查找联系人和最近聊天记录，也可以把记录保存成本地副本，再修改、撤销和导出。原生功能目前要求 **Windows x64、Node.js 24+、微信 4.1.15.13 x64**，且微信 DLL 指纹必须匹配；具体指纹见 [原生读取说明](native-read.md#版本和自动启动)。

## 目录

- [运行方式](#运行方式)
- [先读到一段聊天记录](#先读到一段聊天记录)
- [启动和状态命令](#启动和状态命令)：`start`、`doctor` / `status`、`inspect`
- [账号、编号和聊天记录](#账号编号和聊天记录)：`account`、`accounts`、`ids`、`history`
- [本地聊天副本：修改、撤销与导出](#本地聊天副本修改撤销与导出)：`record import/list/show/edit/changes/undo/export`
- [目标配置、发送与账本](#目标配置发送与账本)：`configure-target`、发送准备、`send`、`send-status`
- [数据库命令](#数据库命令)：`db list/status/decrypt`
- [其他读取后端](#其他读取后端)：`list`、`contacts`、`watch`、`probe`
- [帮助和退出](#帮助和退出)：`help`、`exit` / `quit`
- [全局选项与命令语法](#全局选项与命令语法)
- [默认后端和能力](#默认后端和能力)
- [编号怎么用](#编号怎么用)
- [JSON 输出与脚本调用](#json-输出与脚本调用)
- [环境变量和配置](#环境变量和配置)
- [常见错误与下一步](#常见错误与下一步)
- [换电脑与分享程序](#换电脑与分享程序)

## 运行方式

在 WXcc 程序目录打开 PowerShell，首次安装依赖：

```powershell
node --version
npm.cmd ci
.\wxcc.cmd help
```

`node --version` 应为 24 或更高版本；`npm.cmd ci` 按锁文件安装依赖。然后正常打开微信并登录。

**单次执行**：在 PowerShell 中，每条 WXcc 命令都加 `.\wxcc.cmd`，执行完返回终端。

```powershell
.\wxcc.cmd account
.\wxcc.cmd history --help
```

**连续输入**：只执行入口，进入 `wxcc>` 交互提示符。

```powershell
.\wxcc.cmd
```

在提示符后直接输入命令，**不再加 `.\wxcc.cmd` 或 `wxcc`**：

```text
start
account
ids --keyword "示例联系人"
help history
exit
```

交互模式也叫 REPL。启动时的全局选项会成为后续命令的默认值，每条命令可覆盖，例如 `.\wxcc.cmd --json` 会让后续结果使用 JSON。`exit` / `quit` 只退出输入界面，后台读取程序继续运行。

cmd 可使用 `wxcc.cmd`；等价的 Node 入口是 `node .\bin\wxcc.mjs`。下文统一使用 PowerShell 写法。

## 先读到一段聊天记录

按下面四步操作即可，不需要先配置发送或寻找数据库密钥。

```powershell
# 1. 准备读取，微信须已打开并登录
.\wxcc.cmd start

# 2. 确认当前登录的是自己的哪个账号
.\wxcc.cmd account

# 3. 按备注或昵称查联系人，查看 users 中的 alias
.\wxcc.cmd ids --keyword "示例联系人"

# 4. 粘贴上一步该联系人的实际 alias，再读最近 10 条
$targetAlias = Read-Host "粘贴目标的 alias（u_ 开头）"
.\wxcc.cmd history --to $targetAlias --limit 10
```

后文单条命令示例中的 `u_0123456789abcdef` 是**虚构联系人编号**，格式是 `u_` 加 16 位十六进制。实际操作从 `ids` 的 `users[].alias` 复制完整编号。名称用于找人，编号用于指定人；同名联系人应核对后选择。

结果中的 `messages` 就是本次返回的记录。原生读取默认最近 30 条，可设为 **1–200 条**；目前支持明确的个人会话，没有群聊读取、历史分页或全量历史查询。联系人结果中的 `complete:false` 表示这里只列出微信已经加载的联系人缓存。

各命令的“关键返回字段”是阅读结果的说明，**不是 CLI 会打印的表格**。文中所有编号、正文、PID、路径和 JSON 内容均为虚构示例；编号要换成对应命令在本机返回的值。

## 启动和状态命令

### `start` — 准备读取微信

找到当前微信主进程，启动或复用后台读取程序；这一步不发送消息。

```text
.\wxcc.cmd start [--pid PID] [--install-path DIR] [--profile FILE]
                 [--timeout MS] [--token-file FILE] [--json]
```

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `--pid` | 否 | 自动选唯一主进程 | 微信主进程的正整数 PID；多个主进程时须指定 |
| `--install-path` | 否 | 自动发现 | 微信安装目录 |
| `--timeout` | 否 | `60000` | 启动等待毫秒数，范围 1000–180000 |
| `--profile` | 否 | 本版 profile | 高级版本校验文件，不能让不支持的版本变得兼容 |
| `--token-file` | 否 | `data/native-read-host.json` | 高级选项，指定读取连接描述文件 |

示例：

```powershell
.\wxcc.cmd start
.\wxcc.cmd start --install-path "D:\Apps\Weixin" --timeout 90000 --json
```

第二例路径换成自己的实际安装位置。若提示多个主进程，先用下一节的 `doctor` 找到主 PID，再加 `--pid`。

| 关键返回字段 | 含义 |
| --- | --- |
| `ready`、`reused` | 读取准备完成；是否复用已有后台程序 |
| `pid`、`version`、`architecture` | 本次使用的微信进程和版本 |
| `accountVerified`、`historyAvailable` | 账号验证和历史读取是否通过 |
| `automaticMessagesSent` | 此操作为 `0` |

`start` 不负责打开或重启微信。命令退出后后台程序继续运行；这里的 `ready:true` 仅表示读取准备完成。超时或忙碌时先检查状态和日志，不重复启动或删除未知锁。详细规则见 [原生读取说明](native-read.md)。

### `doctor` / `status` — 检查安装和连接

查看微信版本、运行进程及所选后端的能力；`status` 与 `doctor` 相同。

```text
.\wxcc.cmd doctor [--backend NAME] [--install-path DIR] [--pid PID] [--verbose] [--json]
.\wxcc.cmd status [--backend NAME] [--install-path DIR] [--pid PID] [--verbose] [--json]
```

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `--backend` | 否 | `weflow-http` | 检查本项目原生读取时用 `reverse-native` |
| `--install-path` | 否 | 自动发现 | 指定微信安装目录 |
| `--pid` | 否 | 自动发现 | 缩小安装诊断的进程选择范围 |
| `--verbose` | 否 | 关闭 | 返回更多安装诊断信息 |

示例：

```powershell
.\wxcc.cmd doctor --backend reverse-native --json
.\wxcc.cmd status --backend reverse-native --verbose --json
```

| 关键返回字段 | 含义 |
| --- | --- |
| `installation.version`、`architecture`、`hashes` | 安装版本、架构、文件校验结果 |
| `installation.processes` | 进程列表；用 `role:"main"` / `main:true` 识别主进程，不能随便取第一行 |
| `connection` | 该后端是否连通；失败时含错误 |
| `capabilities` | 分别报告读取、历史和发送能力 |
| `installation.diagnostics` | 安装检查发现的问题 |

检查不会打开微信或发送消息。未部署 WeFlow 时，省略 `--backend` 可能得到 HTTP 连接错误；检查原生功能请使用上面的明确写法。

### `inspect` — 分别查看读取和发送状态

查看已经运行的原生后台程序，重点分开看 `read` 和 `send`。

```text
.\wxcc.cmd inspect --backend reverse-native [--token-file FILE] [--json]
```

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `--backend reverse-native` | 原生检查需指定 | 默认仍为 `weflow-http` | 明确检查原生功能 |
| `--token-file` | 否 | 各自默认描述文件 | 高级选项，读取与发送文件不要混用 |

示例：

```powershell
.\wxcc.cmd inspect --backend reverse-native
.\wxcc.cmd inspect --backend reverse-native --json
```

关键字段：`read.ready` / `historyAvailable` 表示读取能力；`send.ready` / `sendAvailable` 表示发送能力；各自的 `error` 解释未就绪原因；`pid` / `generation` 是排错用的进程和本次后台运行标识。

顶层 `ready:true` 可能只来自读取侧。准备发送时必须看 **`send.ready:true`**。默认读取描述是 `data/native-read-host.json`，发送描述是 `data/research-host.json`；Token 不会输出，但这些文件本身仍需保留在本机。

## 账号、编号和聊天记录

### `account` — 查看当前登录账号

读取当前本人账号，并取得可用于本人会话读取的稳定编号。

```text
.\wxcc.cmd account [--json] [--no-redact]
```

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `--json` | 否 | 关闭 | 使用紧凑 JSON 输出 |
| `--no-redact` | 否 | ID 部分隐藏 | 主动显示完整 ID；名称本来就完整显示 |

示例：

```powershell
.\wxcc.cmd account
.\wxcc.cmd account --json
```

关键字段：`displayName` 为本人名称，`alias` 为本人 `u_` 编号，`self` 为本人真实 ID（默认部分隐藏），`scope:"current-account"` 表示当前账号，`accountVerified` 表示验证结果。普通原生读取不需要手填 `--self`。

### `accounts` — 列出本次已验证的账号

目前列出当前正在使用并验证过的一条账号，不枚举电脑上的所有账号。

```text
.\wxcc.cmd accounts [--json]
```

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `--json` | 否 | 关闭 | 使用紧凑 JSON 输出 |

示例：

```powershell
.\wxcc.cmd accounts
.\wxcc.cmd accounts --json
```

关键字段：`accounts` 是账号数组，`scope:"current-account"`、`complete:false` 说明当前返回范围。切换微信账号后，重新执行 `start`、`account` 和 `ids`。

### `ids` — 找联系人并取得编号

筛选已加载联系人，后续读取或配置目标时使用其 `alias`。

```text
.\wxcc.cmd ids [--keyword NAME_OR_ALIAS] [--json] [--no-redact]
```

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `--keyword` | 否 | 不筛选 | 匹配备注、昵称、编号或 ID |
| `--no-redact` | 否 | ID 部分隐藏 | 主动显示完整真实 ID |

示例：

```powershell
.\wxcc.cmd ids --keyword "示例联系人"
.\wxcc.cmd ids --json
```

| 关键返回字段 | 含义 |
| --- | --- |
| `users[].alias` | 复制到 `history --to` 等命令的完整编号 |
| `users[].displayName` | 完整备注或昵称，供选择时核对 |
| `users[].chatId` | 真实会话 ID，默认部分隐藏 |
| `users[].canSend` | 这个联系人是否已有当前有效发送绑定 |
| `scope`、`complete` | `loaded-contact-cache`、`false`，表示已加载缓存范围 |

`canSend:false` 不妨碍读取。取得编号不会自动开放发送；名称、列表行号、带星号或省略号的展示 ID 都不能代替完整编号。

### `history` — 读取指定聊天的最近记录

返回指定个人会话最近的有限条记录，不需要数据库密钥。

```text
.\wxcc.cmd history --to USER [--limit 30] [--json]
.\wxcc.cmd history USER [--limit 30] [--json]
```

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `--to` 或位置参数 `USER` | 是 | 无 | `ids` 返回的联系人编号；本人会话可用 `account.alias`；也接受准确完整个人会话 ID |
| `--limit` | 否 | `30` | 原生范围 1–200 |

两例编号都换成同一个、刚从 `ids` 选定的实际 `alias`：

```powershell
.\wxcc.cmd history --to u_0123456789abcdef --limit 10
.\wxcc.cmd history u_0123456789abcdef --limit 30 --json
```

| 关键返回字段 | 含义 |
| --- | --- |
| `messages` | 本次返回的数组；空数组表示本次未返回记录 |
| `messages[].text` / `content` | 返回正文；媒体业务文本不代表附件已下载 |
| `messages[].id` / `serverId` | 来源消息 ID，十进制字符串，可能为 `"0"` |
| `messages[].timestamp` | 毫秒时间戳 |
| `messages[].createTime`、`type`、`subType` | 原生时间和类型，十进制字符串 |
| `messages[].senderId`、`isSelf` | 发言人；不明确时 `isSelf:null`，不会猜成本人 |
| `schemaValidated`、`historyAvailable` | 结果结构和当前读取能力的验证结果 |

其他人的目标必须在当前验证的联系人缓存中。单次读取不自动保存正文；要保留并编辑，使用 `record import`。目前没有历史分页或 `history --database`，解密数据库不会自动接入此命令。

## 本地聊天副本：修改、撤销与导出

`record` 把聊天记录保存到 WXcc 的 `data/history-copies/`，之后可以修改这份**本地副本**。修改不写回微信本机数据库、服务端或对方聊天；原文始终保留，并可查看、撤销每次修改。

顺序是：**import 取得 `copyId` → show 取得 `recordId` → edit 修改 → changes / undo 核对或撤销 → export 导出**。`record` 不带子命令等同 `record list`。除直接读取聊天的 `import --to` 外，文件导入和其余子命令全部离线，可在微信未运行时使用。

本节用同一组假值串起示例：`c_0123456789abcdef0123456789abcdef` 代表 `import` 返回的 `copyId`；`m_0123456789abcdef` 代表**该副本** `show` 返回的 `recordId`；`e_0123456789abcdef0123456789abcdef` 代表 `edit` / `changes` 返回的 `changeId`。操作时逐项换成本机结果。

### `record import`：直接取得指定聊天

读取选定聊天，创建一个新的本地副本。

```text
.\wxcc.cmd record import --to USER [--limit 30] [--json]
```

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `--to` | 是 | 无 | `ids` 返回的编号或准确完整个人会话 ID |
| `--limit` | 否 | `30` | 原生范围 1–200；其他历史后端按自身限制 |
| `--backend` | 否 | `reverse-native` | 使用哪个后端读取历史 |

先完成 `start`、`account`、`ids`，把编号换成选定联系人的实际 `alias`。两例是替代用法，每次执行都会新建副本：

```powershell
.\wxcc.cmd record import --to u_0123456789abcdef --json
.\wxcc.cmd record import --to u_0123456789abcdef --limit 100 --json
```

关键字段：`copyId` 用于后续操作；`revision:0` 是初始版本；`messageCount` 是条数；`source:"local-history-copy"`、`localOnly:true` 标记本地副本；`origin.source` 保留原始来源。重新导入不会刷新、合并或覆盖旧副本。

### `record import`：离线导入已有历史 JSON

把一份含完整 ID 的历史 JSON 导入为新副本，不连接微信。

```text
.\wxcc.cmd record import --input FILE --self SELF [--to USER] [--json]
```

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `--input` | 是 | 无 | 普通 UTF-8 JSON 文件，最多 64 MiB、10000 条消息 |
| `--self` | 是 | 无 | 精确完整本人 ID，不能用 `u_` 编号或脱敏值 |
| `--to` | 否 | 从文件确认 | 精确完整聊天 ID，或本机已登记编号；省略时文件必须证明唯一聊天 |
| `--limit` | 不接受 | 保存全部输入记录 | 文件导入不能只选其中几条 |

下面是**虚构的完整离线输入示例**，可保存为私有目录中的 `sample-history.json`。两个 `wxid_example_...` 是此离线文件内部使用的假 ID：

```json
{
  "self": "wxid_example_self",
  "chatId": "wxid_example_contact",
  "messages": [
    {
      "id": "0",
      "chatId": "wxid_example_contact",
      "senderId": "wxid_example_contact",
      "isSelf": false,
      "type": "text",
      "timestamp": 1791321600000,
      "text": "这是一条用于离线练习的虚构记录。"
    }
  ]
}
```

两例都导入上述虚构文件，第二例明确给出同一个聊天目标：

```powershell
.\wxcc.cmd record import --input "D:\Private\sample-history.json" --self wxid_example_self --json
.\wxcc.cmd record import --input "D:\Private\sample-history.json" --self wxid_example_self --to wxid_example_contact --json
```

导入自己的文件时替换路径及两个 ID。本人完整 ID 可从该账号的 `account --no-redact --json` 取得；聊天目标应与完整历史文件一致，不能照抄假值。

输入采用 `history --no-redact --json` 的对象形状 `{self?, chatId?, messages}`。文件若有 `self`，必须与 `--self` 一致；消息须属于同一聊天。默认脱敏历史、混合聊天、冲突目标或无法证明唯一聊天的输入会被拒绝。使用编号时只读取本机登记，不联网补全。

成功字段与直接导入相同。来源 `id` / `serverId` 保留字符串，尤其不要把 64 位 ID 转成 JavaScript `Number` 或 PowerShell `[double]`。

### `record list` — 查看保存过的副本

离线列出已有副本，找回它们的 `copyId`。

```text
.\wxcc.cmd record list [--json]
.\wxcc.cmd record [--json]
```

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `--json` | 否 | 关闭 | 紧凑 JSON；无需指定后端或微信账号 |

示例：

```powershell
.\wxcc.cmd record list
.\wxcc.cmd record --json
```

关键字段：`copies` 为副本数组；每份含 `copyId`、`displayName`、`messageCount`、`revision`、`activeEditCount`、`edited`、`createdAt`、`updatedAt`。`edited:true` 表示还有未撤销的修改。

### `record show` — 查看内容和记录编号

显示副本当前内容，编辑前用它取得准确的 `recordId` 和当前 `revision`。

```text
.\wxcc.cmd record show --copy COPY [--limit 30] [--json]
```

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `--copy` | 是 | 无 | `import` / `list` 返回的 `c_` 副本编号 |
| `--limit` | 否 | `30` | 显示最近多少条，范围 1–10000 |

两例 `--copy` 均换成同一份副本的实际 `copyId`：

```powershell
.\wxcc.cmd record show --copy c_0123456789abcdef0123456789abcdef --json
.\wxcc.cmd record show --copy c_0123456789abcdef0123456789abcdef --limit 100 --json
```

关键字段：副本 `revision` 是当前版本；`messages[].recordId` 是编辑时推荐使用的唯一编号；`messages[].id` 保留来源消息 ID，可能重复；`messages[].edited` 表示该记录仍有有效修改。

`recordId` 在**同一副本内固定**，不因正文、时间或显示顺序变化而改变；重新导入会生成新副本和新记录编号。不要把来源 `id`、`recordId` 和 `changeId` 混用。

### `record edit` — 修改副本中的正文或时间

修改选中记录的正文或毫秒时间，保留原文和修改前后内容。

```text
.\wxcc.cmd record edit --copy COPY (--record-id RECORD | --message-id SOURCE_ID)
  [--text TEXT | --text-file FILE] [--timestamp MS] [--revision N] [--json]
```

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `--copy` | 是 | 无 | `import` / `list` 返回的副本编号 |
| `--record-id` | 与 `--message-id` 二选一 | 无 | **该副本** `show` 返回的 `m_` 编号，推荐使用 |
| `--message-id` | 与 `--record-id` 二选一 | 无 | 完整来源消息 ID，按字符串匹配；重复时拒绝 |
| `--text` | 至少一种修改 | 无 | 新正文，可为空；与 `--text-file` 互斥 |
| `--text-file` | 至少一种修改 | 无 | 从普通 UTF-8 文件读取新正文 |
| `--timestamp` | 至少一种修改 | 无 | 新毫秒时间戳，可与正文一起修改 |
| `--revision` | 否，建议填写 | 不检查预期版本 | 使用刚刚 `show` 返回的当前版本，避免覆盖期间发生的变化 |

先看内容和编号，再编辑：

```powershell
# copyId 来自 import/list；从结果中选定 recordId，并查看 revision
.\wxcc.cmd record show --copy c_0123456789abcdef0123456789abcdef --json

# 仅在实际 revision 为 0 时用 --revision 0；recordId 也换成上一步的值
.\wxcc.cmd record edit --copy c_0123456789abcdef0123456789abcdef --record-id m_0123456789abcdef --text "修改后的本地示例正文。" --revision 0 --json
```

下面两例是其他修改方式。每次操作前重新 `show` 核对内容、编号与版本；这里省略版本参数以展示语法：

```powershell
# replacement.txt 是自己准备的 UTF-8 正文文件
.\wxcc.cmd record edit --copy c_0123456789abcdef0123456789abcdef --record-id m_0123456789abcdef --text-file "D:\Private\replacement.txt" --json

# 1791321600000 是虚构毫秒时间，按自己的目标时间填写
.\wxcc.cmd record edit --copy c_0123456789abcdef0123456789abcdef --record-id m_0123456789abcdef --timestamp 1791321600000 --json
```

关键字段：`changeId` 是此次修改编号；`recordId` / `messageId` 标明哪条记录；`revision` 每次修改加 1。不能修改本人、聊天、发言人身份或来源 ID。

正文须为有效 Unicode、不含 NUL，最多 1 MiB UTF-8 字节；正文文件须有效 UTF-8。空正文可用空的 `--text-file`，或在支持保留空参数的终端用 `--text ""`。时间和版本都是 0–9007199254740991 的整数，`revision:0` 有效。

### `record changes` — 查看修改和撤销历史

显示副本的修改前后内容，也显示已经发生的撤销。

```text
.\wxcc.cmd record changes --copy COPY [--limit 30] [--json]
```

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `--copy` | 是 | 无 | `import` / `list` 返回的副本编号 |
| `--limit` | 否 | `30` | 最近多少个事件，范围 1–10000 |

编号均为要查看的同一份副本 `copyId`：

```powershell
.\wxcc.cmd record changes --copy c_0123456789abcdef0123456789abcdef --json
.\wxcc.cmd record changes --copy c_0123456789abcdef0123456789abcdef --limit 100 --json
```

关键字段：`changes[].changeId`、`kind`（`edit` / `undo`）、`recordId`、`before`、`after`、`revision`、`createdAt`。修改事件的 `undone` 表示是否已撤销，撤销事件的 `targetChangeId` 指向被撤销的修改。这里会包含原文和修改后正文。

### `record undo` — 撤销副本修改

恢复某次修改前的正文和时间，同时保留撤销历史。

```text
.\wxcc.cmd record undo --copy COPY [--change-id CHANGE] [--revision N] [--json]
```

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `--copy` | 是 | 无 | `import` / `list` 返回的副本编号 |
| `--change-id` | 否 | 最近尚未撤销的修改 | 该副本 `edit` / `changes` 返回的实际修改编号 |
| `--revision` | 否，建议填写 | 不检查预期版本 | 使用刚刚 `show` 返回的当前版本 |

两例为替代用法：第一例撤销最近修改，第二例指定 `changes` 中选定的修改。先 `show` 核对版本；`1` 仅表示示例副本当前恰好为版本 1：

```powershell
.\wxcc.cmd record undo --copy c_0123456789abcdef0123456789abcdef --revision 1 --json
.\wxcc.cmd record undo --copy c_0123456789abcdef0123456789abcdef --change-id e_0123456789abcdef0123456789abcdef --json
```

关键字段：`undoId` 为撤销事件编号，`changeId` 是被撤销修改，`recordId` 指向记录，`revision` 是更新后的版本。全部有效修改撤销后 `edited:false`，原文、版本和历史仍保留。

同一记录先改 A、再改 B，要先撤销 B 才能撤销 A；其他记录的修改不阻止这一顺序。已撤销、未知或不属于该副本的修改不能重复撤销。

单份副本（含原文、修改和审计）最多 **64 MiB、10000 次修改、20000 个总审计事件**（含撤销）。每次保存修改都会预留日后撤销的空间；达到修改次数或空间上限后，已保存修改仍可按顺序撤销。

### `record export` — 导出当前内容

将当前副本保存成一个新的 JSON 文件，保留本地副本及修改状态标记。

```text
.\wxcc.cmd record export --copy COPY --output NEW_FILE [--no-redact] [--json]
```

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `--copy` | 是 | 无 | `import` / `list` 返回的副本编号 |
| `--output` | 是 | 无 | 新的私有 JSON 路径，不能已存在 |
| `--no-redact` | 否 | 文件内 ID 脱敏 | 主动导出完整 ID；名称和正文不会自动隐藏 |

`copyId` 来自该副本 `import` / `list`；第二例使用不同的新文件名：

```powershell
.\wxcc.cmd record export --copy c_0123456789abcdef0123456789abcdef --output "D:\Private\edited-history.json" --json
.\wxcc.cmd record export --copy c_0123456789abcdef0123456789abcdef --output "D:\Private\edited-history-full-id.json" --no-redact --json
```

命令关键字段：`ok`、`copyId`、`revision`、`messageCount`、`edited`、`redacted`、`bytes`；标准输出不含私有导出路径。文件始终带 `source:"local-history-copy"`、`localOnly`、`edited`、`revision`、`exportedAt`、`redacted` 等标记。

输出最多 64 MiB，不能位于程序源码或微信数据目录，不能覆盖旧文件。副本、变更历史和导出 JSON 都含私人聊天内容，请使用程序目录以外的私有数据目录。

## 目标配置、发送与账本

发送需要另外准备。顺序是：**选定联系人 → configure-target → doctor 找主 PID → 另开终端启动发送后台程序 → inspect 与 ids 确认 → send**。下面是操作说明，初始化本身不会自动发测试消息。

### `configure-target` — 指定本机唯一发送目标

把明确选中的个人联系人保存为本机目标，不发送消息。

```text
.\wxcc.cmd configure-target --to USER [--json]
.\wxcc.cmd configure-target USER [--json]
```

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `--to` 或位置参数 `USER` | 是 | 无 | 当前 `ids` 返回的编号，或准确完整个人会话 ID |

先完成 `start`、`account`、`ids`；两例等价，编号换成选定联系人的实际 `alias`：

```powershell
.\wxcc.cmd configure-target --to u_0123456789abcdef --json
.\wxcc.cmd configure-target u_0123456789abcdef --json
```

关键字段：`configured:true` 表示已保存，`requiresFreshSendBinding:true` 表示还需准备发送绑定，`automaticMessagesSent:0` 表示没有发送。

目标保存在本机 `data/native-target.json`，与本人、联系人和客户端版本绑定。不能用昵称、群聊、公众号或服务会话；切换账号、目标或版本后重新配置。已运行的发送程序不会因重新配置而自动改绑其他人。

### 发送宿主初始化

先在当前终端检查主进程：

```powershell
.\wxcc.cmd doctor --backend reverse-native --json
```

从 `installation.processes` 找到 `role:"main"` / `main:true` 的实际 `pid`。**另开一个 PowerShell 终端**，进入同一程序目录，填入这个实际 PID：

```powershell
$mainPid = Read-Host "输入 doctor 中微信主进程的实际 pid"
.\wxcc-native-host.cmd --pid $mainPid --send
```

这是独立入口 `wxcc-native-host.cmd`，没有 `wxcc start --send` 用法。它准备发送并核验本机目标，不自动发消息；保持该终端及后台程序运行。`--read` 与 `--send` 不能一起使用。

回到原终端检查：

```powershell
.\wxcc.cmd inspect --backend reverse-native --json
.\wxcc.cmd ids --keyword "示例联系人" --json
```

同时确认 **`inspect` 的 `send.ready:true`**，以及**选定联系人 `canSend:true`**，才进行发送。缺少版本、目标绑定或当前运行状态验证时，入口保持关闭，不能仅凭顶层 `ready:true` 判断。高级重新核验和恢复规则见 [原生发送说明](native-send.md)。

### `send` — 提交一条文本消息

向当前已配置且就绪的个人目标提交文字；执行此命令才会尝试真正发送。

```text
.\wxcc.cmd send (--to USER | --session STATE | --pick) --text TEXT
                [--request-id UNIQUE] [--json]
.\wxcc.cmd send USER TEXT [--request-id UNIQUE] [--json]
```

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `--to` | 三选一 | 无 | 已配置目标的实际编号或完整 ID |
| `--session` | 三选一 | 无 | 当前绑定的完整会话标识；也可用该绑定目标编号 |
| `--pick` | 三选一 | 关闭 | 先显示联系人，再输入本次列表里 `canSend:true` 的编号 |
| `--text` | 是 | 无 | 非空、非全空白、完整 Unicode、不含 NUL，最多 1024 UTF-8 字节 |
| `--request-id` | 否，脚本建议填写 | 自动 UUID | 每条新消息使用新 ID，便于查询和防止重复提交 |

以下是三种**替代用法**，不是要求连续发三条。编号来自已配置且 `canSend:true` 的同一个实际目标；正文和请求 ID 为虚构示例：

```powershell
.\wxcc.cmd send --to u_0123456789abcdef --text "这是一条文字发送示例。" --request-id example-text-001 --json
.\wxcc.cmd send --session u_0123456789abcdef --text "这是一条文字发送示例。" --request-id example-text-002 --json
.\wxcc.cmd send --pick --text "这是一条文字发送示例。" --request-id example-text-003
```

`--pick` 等待输入时，只输入本次列出的完整 `u_` 编号，不加命令前缀；`cancel`、空输入或结束输入会取消。此流程含交互，不适合按单个 JSON 对象解析。

关键字段：`requestId` 是本次请求编号，`status` 是内部提交结果，`alias` / `displayName` 是目标，`deliveryConfirmed` 表示独立送达确认。**`accepted` 只表示客户端内部接受提交，不能保证对方收到或已读**；当前返回 `deliveryConfirmed:false`，没有独立服务端 ACK / 已读接口。

请求 ID 为 1–128 位 ASCII，首位是字母或数字，其余可含 `._:-`，规范成小写。本机账本在调用前保留请求，同一 ID 不会再次发送，也不能换目标或正文复用。超时或 `unknown` 时保留原 ID，先查账本并核对客户端，不换新 ID 盲目补发。当前只支持文字，没有图片、文件、语音、群聊或群发。

### `send-status` — 查询发送请求记录

离线读取本机发送账本，不发送也不重试。

```text
.\wxcc.cmd send-status --request-id UNIQUE [--json]
```

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `--request-id` | 是 | 无 | 原 `send` 使用或返回的请求 ID |

两例查询同一条虚构请求，实际使用自己的原请求 ID：

```powershell
.\wxcc.cmd send-status --request-id example-text-001
.\wxcc.cmd send-status --request-id example-text-001 --json
```

| 关键状态 | 含义 |
| --- | --- |
| `reserved` | 请求已保留，尚无最终本机记录 |
| `accepted` | 客户端内部接受提交，送达仍未确认 |
| `failed` | 内部调用报告失败，不自动重试 |
| `unknown` | 超时、连接或回执问题导致结果未知 |

结果含 `source:"local-send-journal"` 和账本记录。`E_SEND_REQUEST_UNKNOWN` 表示本机找不到，不能证明其他宿主或旧进程从未发过该消息。

## 数据库命令

最近聊天直接用 `history`。`db` 用于发现当前账号数据库，或把一个加密库导出成独立明文 SQLite 副本以便离线分析；不修改实时库，也不自动把副本接入 `history`。

### `db list` — 找到当前账号数据库

读取当前本人账号，再列出匹配目录中的数据库编号、类型和大小。

```text
.\wxcc.cmd db list [--data-root DIR] [--account-dir DIR] [--json]
```

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `--data-root` | 否 | 自动发现 | 明确指定 `xwechat_files` 数据根 |
| `--account-dir` | 否 | 根据当前账号发现 | 明确指定该账号目录，仍必须与当前本人匹配 |

先 `start`。以下路径只展示结构，替换成自己的实际路径：

```powershell
.\wxcc.cmd db list --json
.\wxcc.cmd db list --data-root "D:\WechatData\xwechat_files" --json
.\wxcc.cmd db list --data-root "D:\WechatData\xwechat_files" --account-dir "D:\WechatData\xwechat_files\wxid_example_self_demo" --json
```

| 关键返回字段 | 含义 |
| --- | --- |
| `accountAlias`、`accountDisplayName` | 当前本人编号和名称 |
| `databases[].alias` | 用于解密选择的 `d_` 编号 |
| `databases[].kind` | `message`、`session`、`contact` 等类型 |
| `bytes`、`encrypted`、`walBytes` | 主库大小、是否加密及旁边 WAL 文件大小 |
| `databaseCount`、`encryptedCount`、`totalBytes` | 数量和大小汇总 |
| `directoryMatchVerified` | 目录名已匹配账号，不代表密钥归属已认证 |
| `binding:"pending-page-auth"` | 仍待密钥和数据库页面认证 |

结果不输出原文件名、账号绝对路径或密钥。此处 `accountVerified:false` / `cryptographicAccountVerified:false` 指数据库归属未完成认证，不是否定前面的本人账号。多个目录需明确选择，不按“最近修改”猜测。默认最多发现 512 个 `.db`，最多深入 4 层，跳过符号链接。

### `db status` — 查看数据库发现摘要

返回与 `db list` 相同的发现结果和统计；省略子命令 `db` 也等同于此命令。

```text
.\wxcc.cmd db status [--data-root DIR] [--account-dir DIR] [--json]
.\wxcc.cmd db [--data-root DIR] [--account-dir DIR] [--json]
```

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `--data-root`、`--account-dir` | 否 | 自动发现 | 与 `db list` 相同 |

示例：

```powershell
.\wxcc.cmd db status --json
.\wxcc.cmd db --data-root "D:\WechatData\xwechat_files" --json
```

关键字段与 `db list` 相同，可先看 `databaseCount`、`encryptedCount`、`directoryMatchVerified` 和 `databases`。此命令不解密文件。

### `db decrypt` — 导出一个解密副本

选择当前账号的一个数据库，或提供离线加密文件，验证后写入新副本。

```text
.\wxcc.cmd db decrypt (--database DB | --input FILE) --output NEW_FILE
  [--key-file FILE] [--key-mode raw|passphrase|auto] [--timeout MS] [--json]
```

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `--database` | 与 `--input` 二选一 | 无 | 当前 `db list` 返回的 `d_` 编号 |
| `--input` | 与 `--database` 二选一 | 无 | 离线加密库，必须同时给 `--key-file` |
| `--output` | 是 | 无 | 新的私有副本路径，不能已存在 |
| `--key-file` | 离线必填 | 当前账号模式尝试自动寻找 | 自己已有的私有密钥文件，不把密钥写进命令 |
| `--key-mode` | 否，仅显式密钥文件可用 | `raw` | `raw` / `passphrase` / `auto`，格式见下面 |
| `--timeout` | 否，仅自动找密钥时有效 | `15000` | 寻找时限 100–30000 毫秒，不是整个解密操作的超时 |

三例分别是自动密钥、自己的密钥文件、离线文件。`d_0123456789abcdef` 换成**当前账号刚刚 `db list.databases[].alias` 返回的编号**，路径换成自己的私有文件：

```powershell
.\wxcc.cmd db decrypt --database d_0123456789abcdef --output "D:\Private\database-auto.sqlite" --json
.\wxcc.cmd db decrypt --database d_0123456789abcdef --key-file "D:\Private\db-key.txt" --output "D:\Private\database-keyfile.sqlite" --json
.\wxcc.cmd db decrypt --input "D:\Private\Encrypted\session.db" --key-file "D:\Private\db-key.txt" --key-mode raw --output "D:\Private\Offline\session.sqlite" --json
```

| 关键返回字段 | 含义 |
| --- | --- |
| `ok`、`quickCheck:"ok"` | 导出和 SQLite 检查通过 |
| `profile`、`keyMode` | 匹配到的加密参数和密钥处理方式 |
| `pages`、`bytes`、`authenticatedPages` | 输出大小及认证页面数 |
| `schemaObjects` | 检查到的结构对象数量 |
| `wal` | 已提交、未提交帧及旧尾部摘要 |
| `accountCryptographicBinding`、`binding` | 是否证明密钥来自当前验证的微信进程 |

#### `db decrypt`：当前账号自动密钥

不提供 `--key-file` 时，只读检查当前已验证主进程的有限内存候选，并要求通过数据库页面认证。不打印或保存候选密钥，不要求重新登录或重启微信。

**目前本机实测尚未找到自动密钥，返回 `E_DB_KEY_NOT_FOUND`，还没有真实数据库自动解密成功的验证记录。** 第一例不能理解成保证成功；有自己密钥文件时用第二种方式。现有解密、页面认证、WAL 和完整性检查已用合成 SQLite 库验证，不能替代真实客户端参数适配。

自动扫描默认 15 秒、最多读取 512 MiB 候选内存。只有当前进程候选认证并成功导出，才报告 `accountCryptographicBinding:true`、`binding:"current-process-page-auth"`。账号、PID 或本次后台运行标识变化会停止。

#### `db decrypt`：自己的密钥文件

密钥文件最大 256 字节，支持：

| 文件内容 | 说明 |
| --- | --- |
| 32 字节二进制 | 原始 32 字节密钥材料 |
| 64 位十六进制文本 | 表示 32 字节，去掉首尾空白 |
| SQLCipher `x'64hex'` / `x'96hex'` 形式 | 后者含 32 字节 key 和 16 字节 salt，salt 必须匹配该库 |

`64hex` / `96hex` 是格式说明，不是有效密钥。`raw` 直接使用这 32 字节；`passphrase` 按支持参数派生；`auto` 有限尝试这两种方式，不支持任意长度密码。

手动文件成功时为 `accountCryptographicBinding:false`、`binding:"directory-match-key-file-auth"`：证明文件可解密，不证明密钥来自当前微信进程。

#### 离线 `db decrypt --input`

必须有 `--key-file`，无需 `start`，不访问原生后台或扫描进程。返回 `source:"offline-database-copy"`、`accountCryptographicBinding:false`。

若原库使用 WAL，复制时也应取得一致的同名 `文件名-wal`。工具检查同目录侧文件，仅把合法已提交事务应用到独立副本，不导出未提交事务。

#### 输出限制、加密参数和结果

输出须为新文件，不能等于输入或侧文件，也不能位于实时 `db_storage`。父目录会创建；临时明文采用受限目录权限，验证通过才发布。**副本是完整明文数据库，CLI 的 ID 脱敏不会修改它的内容**，请放在程序分发目录以外的私有位置。

目前只支持以下有限参数，未知格式明确失败：

| profile | 页大小 | 保留区 | 页面认证 / 密钥派生 |
| --- | --- | --- | --- |
| `sqlcipher4-4096` | 4096 | 80 | SHA-512 / 256000 次 SHA-512 PBKDF2 |
| `sqlcipher3-4096` | 4096 | 48 | SHA-1 / 64000 次 SHA-1 PBKDF2 |
| `sqlcipher3-1024` | 1024 | 48 | SHA-1 / 64000 次 SHA-1 PBKDF2 |

主库和 WAL 双读确认稳定，默认最多尝试 3 次；单个主库或 WAL 默认最多 256 MiB，CLI 没有放大参数。活动回滚 journal、持续变化、页认证或 WAL 检查失败时不发布副本。导出校验全部主库页、已提交 WAL 页、事务及 SQLite schema / `PRAGMA quick_check`，不加载扩展。

`wal.committedFrames` 是处理的已提交帧，`uncommittedFrames` 不导出，`staleBytes` 仅表示识别出的旧 WAL 尾部。单库成功不保证多个库处于同一时刻，`quick_check` 也不能发现所有业务数据问题。

## 其他读取后端

这部分面向已部署 WeFlow，或需要读取 WXcc 监听缓存的使用者。普通原生联系人和最近聊天使用前面的 `ids` / `history`。

### `list` — 列出会话

通过选定读取后端获取会话列表。

```text
.\wxcc.cmd list [--keyword NAME] [--backend weflow-http|weflow-native|cache] [--json]
```

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `--keyword` | 否 | 不筛选 | 具体由后端支持；cache 不使用此筛选 |
| `--backend` | 否 | `weflow-http` | reverse-native 暂未实现会话列表 |
| `--self` | cache 必填 | 无 | 缓存所属账号的准确完整本人 ID |

第一例需已配置 WeFlow；第二例假 ID 换成保存缓存时使用的实际本人 ID：

```powershell
.\wxcc.cmd list --backend weflow-http --keyword "示例联系人" --json
.\wxcc.cmd list --backend cache --self wxid_example_self --json
```

关键字段：`chats` 为会话数组，`source` 为来源。cache 只使用 WXcc 曾保存的消息建立列表，不主动获取微信记录。

### `contacts` — 通过 WeFlow 查联系人

通过外部 WeFlow 获取联系人；本项目原生联系人查询用 `ids`。

```text
.\wxcc.cmd contacts [--keyword NAME] [--backend weflow-http|weflow-native] [--json]
```

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `--keyword` | 否 | 不筛选 | 名称等筛选，支持情况由后端决定 |
| `--backend` | 否 | `weflow-http` | cache 没有联系人；reverse-native 用 `ids` |

示例需已配置对应后端：

```powershell
.\wxcc.cmd contacts --backend weflow-http --keyword "示例联系人" --json
.\wxcc.cmd contacts --backend weflow-http --json
```

关键字段：`contacts` 为联系人数组，`source` 标记来源。数量和具体字段由后端决定。

### `watch` — 监听指定聊天的新消息

通过 WeFlow 轮询一个个人会话，逐条输出并保存到本机账号隔离缓存。

```text
.\wxcc.cmd watch --to CHAT --self SELF [--interval 1000]
                 [--backend weflow-http|weflow-native]
```

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `--to` | 是 | 无 | 对应后端的完整个人会话 ID，不自动解析原生 `u_` 编号 |
| `--self` | 是 | 无 | 准确完整本人 ID，用来识别方向并隔离缓存 |
| `--interval` | 否 | `1000` | 轮询毫秒数，1–2147483647 |
| `--backend` | 否 | `weflow-http` | reverse-native、cache 均未实现监听 |

假 ID 分别替换为该 WeFlow 账号的实际聊天 ID 和本人 ID；Token 文件来自自己的 WeFlow 配置：

```powershell
.\wxcc.cmd watch --backend weflow-http --to wxid_example_contact --self wxid_example_self --token-file "D:\Private\weflow-token.txt"
.\wxcc.cmd watch --backend weflow-http --to wxid_example_contact --self wxid_example_self --token-file "D:\Private\weflow-token.txt" --interval 2000
```

输出为 NDJSON，每行一条标准化消息，含 `chatId`、`id`、`text`、`timestamp`、`isSelf`、`source` 等。Ctrl+C 停止监听，交互模式中回到输入提示符。只保存选定会话。

### `probe` — 已停用的旧接收探针

该命令目前不可用，调用会返回 `E_PROCESS_HOOK_DISABLED`。

```text
.\wxcc.cmd probe [--to CHAT] [--seconds 30] [--json]
```

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `--to` | 否 | 无 | 旧目标语法仍能解析，但不恢复探针能力 |
| `--seconds` | 否 | `30` | 正整数秒数；命令已停用，不会真的启动探针 |

示例：

```powershell
.\wxcc.cmd help probe
.\wxcc.cmd probe --json
```

第一例查看帮助，第二例返回停用错误，不加载接收探针。需要监听时使用已配置的 WeFlow `watch`。

### WeFlow 连接配置

| 后端 | 需要准备 | 参数 |
| --- | --- | --- |
| `weflow-http` | 自己部署并连接账号的本机 API、API Token | `--url`、`--token-file`；默认 URL `http://127.0.0.1:5031` |
| `weflow-native` | 有效兼容的 WCDB 原生资源、账号目录、自己的密钥 | `--root`、`--account-dir`、`--key-file`、必要的 `--self` |

HTTP 的 `--token-file` 是 API Token 文本文件，与原生 JSON 连接描述不能互换。WeFlow native 的组件保护或授权检查失败会报错，不绕过；新 `db` 模块不依赖该第三方组件。

历史查询示例中的完整 ID 来自自己的 WeFlow 账号或其结果；路径也需替换：

```powershell
.\wxcc.cmd history --backend weflow-http --to wxid_example_contact --self wxid_example_self --token-file "D:\Private\weflow-token.txt" --limit 30 --json
.\wxcc.cmd history --backend weflow-native --root "D:\Tools\WeFlow" --account-dir "D:\WechatData\xwechat_files\wxid_example_self_demo" --key-file "D:\Private\db-key.txt" --self wxid_example_self --to wxid_example_contact --limit 30 --json
```

## 帮助和退出

### `help` — 查看命令用法

查看总览、某条命令或子命令的参数、示例和下一步，不连接微信。

```text
.\wxcc.cmd help [COMMAND [SUBCOMMAND]] [--json]
.\wxcc.cmd COMMAND [SUBCOMMAND] --help
```

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `COMMAND [SUBCOMMAND]` | 否 | 总览 | 例如 `history`、`record edit`、`db decrypt` |
| `--json` | 否 | 文字帮助 | 结构化帮助，适合工具读取 |
| `--help` / `-h` | 否 | 关闭 | 放在命令后也可查看专属帮助 |

示例：

```powershell
.\wxcc.cmd help history
.\wxcc.cmd record edit --help
.\wxcc.cmd help db decrypt --json
```

结构化总览含 `commands`、`workflow`、`documentation`；专属帮助含 `command`、`summary`、`usage` 及可用的 `examples`、`notes`、`next`。拼错命令或选项时可能提示唯一接近的写法，不会替你执行。

### `exit` / `quit` — 退出交互模式

结束 `wxcc>` 输入，不停止微信或后台读取、发送程序。

```text
exit
quit
```

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| 无 | — | — | 仅交互模式输入；单次执行会提示只用于 REPL |

示例一：在 PowerShell 运行 `.\wxcc.cmd` 后输入：

```text
account
exit
```

示例二：同样进入交互模式后输入：

```text
help
quit
```

没有业务结果字段，退出后回到 PowerShell。

## 全局选项与命令语法

```text
.\wxcc.cmd [全局选项] 命令 [命令参数] [全局选项]
```

选项可放命令前后，支持 `--key value` 或 `--key=value`。带空格的名称、正文和路径要加引号。未知参数、重复值参数、多余位置参数和未闭合引号都会报错；参数只能用于其支持的命令。

| 参数 | 必填 | 默认 | 使用范围与说明 |
| --- | --- | --- | --- |
| `--json` | 否 | 关闭 | 成功和错误用 JSON；watch 始终逐行输出 |
| `--redact true\|false` | 否 | `true` | ID 展示脱敏；名称和正文不会自动隐藏 |
| `--no-redact` | 否 | 不指定 | 等同主动设置 `--redact false`，凭据仍隐藏 |
| `--backend NAME` | 否 | 按命令 | 见下一节 |
| `--verbose` | 否 | 关闭 | doctor / status 详细安装诊断 |
| `--pid PID` | 否 | 自动发现 | start 和安装诊断，不改变已有后台程序 |
| `--install-path DIR` | 否 | 自动发现 | 微信安装位置 |
| `--profile FILE` | 否 | 本版 profile | start 高级版本校验文件 |
| `--timeout MS` | 否 | start `60000`；自动密钥 `15000` | 对应操作的时限，不是 history / send 超时或重试参数 |
| `--token-file FILE` | 否 | 按后端 | 原生连接描述或 WeFlow Token 文本，不能互换 |
| `--data-root DIR` | 否 | 自动发现 | db 微信数据根 |
| `--account-dir DIR` | 否 | db 自动发现；WeFlow native 需明确 | 当前账号目录 |
| `--key-file FILE` | 按操作 | 无 | db decrypt 或 WeFlow native 私有密钥文件 |
| `--root DIR` | 否 | WeFlow 原生资源默认目录 | weflow-native 资源目录，建议显式指定 |
| `--self SELF` | 按操作 | 原生读取自动取得 | 离线导入、watch、cache 需准确完整本人 ID |
| `--url URL` | 否 | 环境配置或本机默认 URL | WeFlow HTTP |
| `--interval MS` | 否 | `1000` | WeFlow watch 轮询间隔，1–2147483647 |

`--json`、`--verbose`、`--pick`、`--no-redact` 是开关，不接值。`--` 后的内容作为位置参数；正文推荐明确用 `--text`，以 `--` 开头的值可用 `--text=--开头的正文`。

REPL 支持单、双引号，Windows 路径的反斜杠保持原样；双引号内的双引号可用 `\"`。全局选项变化会重建客户端连接，后台程序仍继续运行。

## 默认后端和能力

“后端”就是命令从哪里读取或提交数据。未指定时按下表选择。

| 命令 | 默认 | 当前范围 |
| --- | --- | --- |
| `start`、`account`、`accounts`、`ids`、`history` | `reverse-native` | 当前账号、已加载联系人、最近个人会话历史 |
| `record import --to` | `reverse-native` | 使用对应历史后端读取并保存副本 |
| `record import --input`、`record list/show/edit/changes/undo/export` | 无需连接后端 | 本地副本操作 |
| `configure-target`、`send`、`send-status`、`db` | `reverse-native` | 本机单目标文字发送、账本及独立数据库模块 |
| `doctor`、`status`、`inspect` | `weflow-http` | 原生检查加 `--backend reverse-native` |
| `list`、`contacts`、`watch` | `weflow-http` | 另行配置的读取后端；原生暂不支持 |
| `help`、`exit`、`quit` | 无需后端 | 帮助或交互控制 |
| `probe` | 已停用 | 返回明确错误 |

`weflow-http` 访问自己部署的本机 API；`weflow-native` 使用兼容 WCDB 资源和自己的密钥；`cache` 只读取 WXcc 曾保存的消息，支持已有缓存的 `list` / `history`，要求 `--self`。这些历史目标不自动解析原生 `u_` 编号，需使用对应后端的完整会话 ID。

原生功能只支持已适配且 DLL 指纹匹配的版本。目前没有原生全量通讯录、会话列表、新消息监听、历史分页或媒体发送。实现和验证边界见 [native-read.md](native-read.md) 与 [native-send.md](native-send.md)。

## 编号怎么用

| 值 | 从哪里取 | 用到哪里 |
| --- | --- | --- |
| `u_` + 16 位十六进制 | `ids.users[].alias`；本人用 `account.alias` | 原生 history、record import、目标配置、绑定后的发送 |
| `c_` + 32 位十六进制 | `record import.copyId` / `record list.copies[].copyId` | 副本查看、编辑等命令的 `--copy` |
| `m_` + 16 位十六进制 | 该副本 `record show.messages[].recordId` | `record edit --record-id` |
| `e_` + 32 位十六进制 | 该副本 `record edit.changeId` / `record changes` | `record undo --change-id` |
| `d_` + 16 位十六进制 | 当前账号 `db list.databases[].alias` | `db decrypt --database` |
| 完整真实 ID | 对应账号或后端未脱敏结果 | 离线导入本人、非原生后端等明确需要的位置 |

编号不是列表行号。用户编号由真实 ID 的 SHA-256 前 16 位生成，改名或排序不改变；数据库编号由当前本人 ID 和库相对路径生成，路径变化可能改变；记录编号由副本和原始行号生成，同一副本内固定。碰撞时拒绝覆盖。

编号不是发送授权或匿名保证。同一真实用户在另一台机器可能算出同一编号，但那台机器仍须自行登录、取得联系人并验证，不能搬运别人的 `recipients.json` 代替这些步骤。部分隐藏的真实 ID 不能复制回命令当完整参数。

## JSON 输出与脚本调用

成功写 stdout，错误写 stderr。普通模式通常为缩进 JSON，`--json` 为紧凑 JSON。`watch` 为 NDJSON，每行一个对象；`send --pick` 先输出列表再等待输入，不能按单对象解析。不要将 stderr 合并进 stdout 再当作一个 JSON 文档。

退出码：`0` 成功、`1` 运行失败、`2` 命令参数无效。交互模式某条命令报错后继续等待下一条。

例如查看联系人字段（名称按自己的目标填写）：

```powershell
$result = .\wxcc.cmd ids --keyword "示例联系人" --json | ConvertFrom-Json
$result.users | Select-Object alias, displayName, canSend
```

这里的表格由 **PowerShell `Select-Object`** 生成，WXcc 本身输出 JSON。消息 ID 可能超过安全整数范围，处理时保留字符串。

下面是**虚构错误字段示例**，不是一次真实运行输出。已知错误可能附 `hint`，并非每个错误都有：

```json
{"error":{"code":"INVALID_ARGUMENT","message":"history 需要明确指定 --to <id>。"}}
```

`--json` 只改变格式，不改变隐私规则。默认完整显示名称和正文、部分隐藏 ID；即使 `--no-redact`，认证密钥和 Token 仍隐藏。

## 环境变量和配置

| 变量 | 用途 | 说明 |
| --- | --- | --- |
| `WXCC_WEIXIN_PATH` | 默认微信安装候选 | 可由 `--install-path` 覆盖 |
| `WXCC_CONFIG` | 安装发现 JSON 配置路径 | 支持 `installPath` / `weixinPath` |
| `WXCC_WEFLOW_URL` | WeFlow HTTP API 地址 | 原生读取无需它 |
| `WXCC_WEFLOW_TOKEN` | WeFlow HTTP Token | 指定 `--token-file` 后改读文件 |
| `WXCC_WECHAT_DB_KEY` | WeFlow native 密钥来源 | 兼容旧变量 `WXCC_DB_KEY`；新 db decrypt 不使用它 |

安装发现还读取 `%APPDATA%\WXcc\config.json`。这是**虚构配置示例**，路径换成自己的位置，不加密钥或联系人列表：

```json
{"installPath":"D:\\Apps\\Weixin"}
```

## 常见错误与下一步

先看 `code` / `message`，再用 `help <命令>` 查看用法；高级运行状态和恢复规则见原生说明。

| 错误或现象 | 怎么处理 |
| --- | --- |
| `INVALID_ARGUMENT` | 检查必填参数、引号、范围、互斥选项，用 help 看专属语法 |
| `WEIXIN_INSTALL_NOT_FOUND` | 用 `--install-path` 或 `WXCC_WEIXIN_PATH` 指定完整安装 |
| `WEIXIN_INSTALL_AMBIGUOUS` | 多个运行安装候选，明确安装位置或主 PID |
| `E_WEIXIN_NOT_RUNNING` | 正常打开并登录微信，再 start |
| `E_NATIVE_PID_REQUIRED` | doctor 原生检查中找 `role:main` 的实际 PID |
| `E_NATIVE_VERSION_UNSUPPORTED` / `E_NATIVE_HASH` | 核对支持版本和 DLL 指纹，不能只改 profile 放行 |
| `E_NATIVE_READ_CONFIG` / `E_NATIVE_HOST_OFFLINE` | 先 start，检查本机状态与日志，不分享 Token |
| `E_NATIVE_START_BUSY` / `E_NATIVE_START_TIMEOUT` | 先查状态，可能已有准备任务，不重复启动或删未知锁 |
| `E_NATIVE_READ_SOURCE` | 后台源码与当前程序不同，按 [读取恢复说明](native-read.md#脱敏驻留与恢复) 检查，不覆盖驻留脚本 |
| `E_NATIVE_READ_BUSY` | 等待原生任务或回调；持续阻塞按原生文档恢复 |
| `E_RECIPIENT_UNKNOWN` / `E_RECIPIENT_ALIAS` | 重新 ids，使用返回的实际完整编号 |
| `E_CHAT_SCOPE` | 核对当前个人联系人范围，不能用昵称、群聊或脱敏 ID |
| `E_NATIVE_TARGET` / `E_NATIVE_TARGET_SCOPE` | 依次核对 account、ids、configure-target |
| `E_NATIVE_TARGET_CHANGED` / `E_NATIVE_GENERATION` | 目标或运行状态已变，重新核验绑定，不复用旧会话 |
| `E_NATIVE_SEND_NOT_READY` | 检查 inspect.send 和目标 canSend，按发送准备顺序操作 |
| `E_SEND_REQUEST_UNKNOWN` | 核对原请求 ID，账本未找到不代表未发送 |
| `E_NATIVE_OUTCOME_UNKNOWN` / transport timeout | 可能已提交，保留原 ID、查账本并核对客户端，不盲目补发 |
| `E_RECORD_SELF` / `E_RECORD_ACCOUNT` / `E_RECORD_CHAT` | 离线 self 要完整，输入须为同一本人、唯一聊天且无脱敏身份 |
| `E_RECORD_INPUT` / `E_RECORD_TEXT` / `E_RECORD_TEXT_FILE` | 检查普通文件、UTF-8、JSON、大小、Unicode / NUL 及互斥参数 |
| `E_HISTORY_COPY_ARGUMENT` / `E_HISTORY_COPY_CHAT_MISMATCH` | 核对副本/记录编号、聊天范围、毫秒时间及版本整数 |
| `E_HISTORY_COPY_NOT_FOUND` / `E_HISTORY_COPY_MESSAGE_NOT_FOUND` | 用 list 和该副本 show 重新取编号 |
| `E_HISTORY_COPY_MESSAGE_AMBIGUOUS` | 来源 ID 重复，改用 show 返回的 recordId |
| `E_HISTORY_COPY_REVISION_CONFLICT` | 版本已变化，重新 show 核对后再操作 |
| `E_HISTORY_COPY_UNDO_NOT_FOUND` / `E_HISTORY_COPY_UNDO_ORDER` | changes 核对有效修改，先撤销同记录后续修改 |
| `E_HISTORY_COPY_BUSY` / `E_HISTORY_COPY_STORE` / `E_HISTORY_COPY_PATH` | 等待当前操作，查私有目录及权限，不盲目删锁或手改副本 |
| `E_HISTORY_COPY_CORRUPT` / `E_HISTORY_COPY_SIZE` / `E_HISTORY_COPY_COLLISION` | 保留原文件，核对损坏及 64 MiB / 10000 次修改 / 20000 审计上限；已保存修改仍可按序撤销 |
| `E_RECORD_OUTPUT` / `E_RECORD_OUTPUT_SCOPE` / `E_RECORD_OUTPUT_EXISTS` | 选程序和微信数据目录以外的新私有 JSON 路径 |
| `E_RECORD_OUTPUT_PERMISSIONS` / `E_RECORD_CLEANUP` | 检查私有目录权限、临时残留，不分发该目录 |
| `E_DB_NOT_FOUND` / `E_DB_ACCOUNT_BINDING` / `E_DB_AMBIGUOUS` | 明确当前本人 data-root / account-dir，不按相近目录猜测 |
| `E_DB_UNKNOWN` | 重新 db list，切账号后不能复用旧编号 |
| `E_DB_KEY_PROVIDER` / `E_DB_AUTO_KEY` / `E_DB_KEY_NOT_FOUND` | 自动密钥未取得，目前实测尚未成功；使用自己已有的私有 keyfile |
| `E_DB_KEY_INVALID` / `E_DB_CIPHER_PROFILE` | 检查密钥文件、模式及支持参数 |
| `E_DB_PAGE_AUTH` / `E_DB_WAL` | 验证未通过，重新取得一致源文件，不把失败副本当成功 |
| `E_DB_SNAPSHOT_BUSY` / `E_DB_JOURNAL` | 等客户端正常完成事务，不强删侧文件 |
| `E_DB_OUTPUT_EXISTS` / `E_DB_LIVE_OUTPUT` | 选择新私有路径，避开实时库 |
| `E_DB_OUTPUT_PERMISSIONS` / `E_DB_CLEANUP` | 检查明文目录权限和残留，不分享该目录 |
| `E_DB_INTEGRITY` | 副本未通过 SQLite 检查，不能当作成功导出 |
| `E_UNSUPPORTED` / `E_PROCESS_HOOK_DISABLED` | 当前未实现；原生联系人用 ids，监听用已配置的 WeFlow |

## 换电脑与分享程序

将源码、锁文件和文档复制到另一台满足要求的电脑，重新 `npm.cmd ci`，登录自己的微信，再执行 `start` → `account` → `ids`。要发送时，在新机器重新明确配置目标并准备发送。自动发现能减少手填路径，不保证未知版本或数据库参数可用。

分发时，以下本机数据应留在自己的私有位置：

- `data/`：真实 ID 映射、本人和目标配置、Token、发送绑定、账本、监听缓存、本地副本与日志。
- `artifacts/`：本机分析、截图、历史测试输出和研究材料。
- 数据库及侧文件、明文副本、密钥文件、个人配置、聊天导出 JSON，以及含真实姓名、正文或凭据的日志和截图。

ID 脱敏不会清除名称和正文，也不会清除明文数据库内容。公开展示请使用测试账号和虚构材料。

返回 [README](../README.md)。逐步操作见 [examples.md](examples.md)，原生实现和恢复边界见 [native-read.md](native-read.md) 与 [native-send.md](native-send.md)。
