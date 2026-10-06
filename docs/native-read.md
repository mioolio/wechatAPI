# 原生账号、联系人与历史读取

`reverse-native` 通过微信自己的协程任务队列读取当前账号、已加载联系人缓存和指定个人会话的最近历史。通常不需要 WeFlow、数据库密钥或手动填写本人 ID，不要求切换聊天窗口或保持微信在前台。

## 版本和自动启动

当前要求 Windows x64、Node.js 24+、微信 **4.1.15.13 x64**，DLL SHA-256 为：

```text
10f8e995453e2da46d4f2b5080cd6da1f13cc5147746adc119ceae38cb039de5
```

版本、架构、安装路径、运行模块及指纹均须通过验证。微信升级后要重新适配，不能把其他版本的 RVA 当作兼容接口。

先正常登录微信，在程序目录执行：

```powershell
npm.cmd ci
.\wxcc.cmd start --json
```

安装发现按明确路径、环境配置、运行进程、注册表及常见安装位置等候选进行检查。多个主进程无法唯一确定时，显式选择 `doctor` 返回的主进程：

```powershell
.\wxcc.cmd doctor --backend reverse-native --json
.\wxcc.cmd start --pid 12345 --install-path "D:\Apps\Weixin" --timeout 60000 --json
```

PID 为示例值。`start` 启动隐藏的常驻读取宿主，或复用相同进程、版本和源码的就绪宿主；它不会启动、结束或重启微信。初始化加载 `readnative_live3`，核验当前账号，并用本人会话的单条历史验证读取能力。这些步骤不发送消息。

默认读取描述文件为 `data/native-read-host.json`，启动日志为 `data/native-read-host.log`；描述含本机访问 Token，不得共享。默认启动期限为 60000 毫秒，允许 `--timeout` 1000 至 180000。启动锁避免多个 CLI 同时连接。仅明确证明宿主进程已不存在且端口拒绝连接时，旧描述才可归档；忙碌、未知状态、其他进程或源码不一致均不覆盖。

高级手动启动方式仍保留：

```powershell
.\wxcc-native-host.cmd --pid 12345 --read
```

已有正常宿主可执行读取 bootstrap 重新核验：

```powershell
node .\src\native-read-bootstrap.mjs
```

普通读取命令复用已经准备好的宿主，不自行加载或卸载脚本，不自动重试未知结果。

## 当前账号和稳定编号

```powershell
.\wxcc.cmd account --json
.\wxcc.cmd accounts --json
```

`account` 返回当前本人名称、`self`、稳定 `alias` 与验证信息。名称完整显示，`self` 默认部分隐藏。`accounts` 返回目前运行代次验证过的当前账号，`scope:"current-account"`、`complete:false`；这不是全盘账号列表。

本人身份来自当前客户端业务上下文，未在源码中绑定某个使用者。PID、宿主 `generation`、本人账号或 DLL 变化后，读取缓存失效并要求重新验证。换机器或换账号后重新运行 `start`、`account`、`ids`，无需搬运旧 Token 或旧映射。

`u_` 编号为真实 ID 的 SHA-256 前 16 位十六进制，不随联系人排序、增加或改名变化；碰撞拒绝覆盖。映射保存在本机 `data/recipients.json`。同一真实 ID 在另一机器可计算同一编号，但那台机器仍须获取自己的有效联系人快照，不能只凭公开编号猜测真实目标。

## 获取当前联系人

```powershell
.\wxcc.cmd ids --json
.\wxcc.cmd ids --keyword "测试联系人" --json
```

`ids` 校验整个已加载缓存快照后登记编号。缓存链表、对象身份、数量或记录异常时拒绝部分结果。`complete:false` 表示缓存范围，不等于查询失败，也不保证全部好友。关键字匹配显示名称、稳定编号或内部 ID，仅用于筛选。

`displayName` 优先完整备注，其次完整昵称。用于路由的是精确 `chatId` 或登记的 `u_` 编号，名称和部分隐藏的 ID 不能作为 `--to`。相同昵称会显示为多条不同编号，用户需明确选择。

读取本身不授予发送权限。只有独立发送宿主核验了同一本人账号、主进程与本机目标绑定后，该目标的 `canSend` 才为 `true`；其余记录为 `false`。

## 按编号读取指定会话

```powershell
.\wxcc.cmd history --to u_0123456789abcdef --limit 30 --json
.\wxcc.cmd history u_0123456789abcdef --limit 10
```

编号为虚构示例，使用实际 `ids` 返回值。本人会话可用 `account` 返回的编号；其他目标须存在于当前已验证的联系人快照。旧登记、同名联系人或邻近内存不能代替验证。

`--limit` 为 1 至 200，默认 30。当前返回最近的有限条历史，没有游标分页、全量导出、原生会话列表或原生新消息监听。单次读取不自动持久化正文。空 `messages` 表示本次业务查询没有返回记录，不应推断数据库所有时间范围均无消息。

结果检查账号、目标、PID、`generation` 和消息 DTO。`historyAvailable:true` 与 `schemaValidated:true` 表明当前调用路径和结果结构通过校验，`automaticMessagesSent:0` 表明该操作未发送消息。

## 消息字段

| 字段 | 含义与使用方式 |
| --- | --- |
| `serverId`、`id` | 业务消息标识，保留十进制字符串，可能为 `"0"`；不是数据库 `localId` |
| `createTime` | 原生秒级时间，十进制字符串 |
| `timestamp` | 在可精确表示范围内转换的毫秒数 |
| `type`、`subType` | 原生业务类型，十进制字符串；不把未知类型猜成文本 |
| `content`、`text` | 返回正文；媒体或系统消息可能为业务文本，不能据此声称附件已下载 |
| `chatId` | 已验证会话 ID，展示默认脱敏 |
| `senderUsername`、`senderId` | 实际返回的发言人 ID；缺失时保留未知 |
| `isSelf` | 发言人明确时为布尔值；缺失时为 `null` |
| `direction` | 发言人未知时为 `"unknown"` |

64 位标识不可转换成 JavaScript `Number`；后续匹配用字符串，数值运算确有需要时用 `BigInt`。`serverId:"0"` 不会被编造为新的数据库本地 ID。

内部历史业务入口为本版 `list_messages` `0x5476170`，在合法原生任务上下文调用；不能从任意 RPC 线程直接调用该 RVA。运行中保持原生对象与回调的所有权约束。未完成原生任务或回调会阻止继续排队。

## 数据库与历史的关系

按用户编号读取历史是当前客户端的业务查询；`db list` / `db decrypt` 是独立的本机文件发现和解密导出。导出得到一个完整明文 SQLite 副本，当前不会自动把它转换为统一聊天查询接口，也没有实现 `history --database`。常见最近记录用 `history`；离线数据库分析见 [命令手册](commands.md#数据库命令)。

## 脱敏、驻留与恢复

默认 `--redact true` 完整显示名称、部分隐藏真实 ID；主动 `--no-redact` 才关闭 ID 脱敏，Token 和密钥始终隐藏。正文及名称仍可能包含个人信息。`--json` 改变格式，不改变默认隐私策略。

CLI 退出只关闭客户端，不卸载 agent 或分离 Frida 会话。宿主需继续驻留，尤其原生任务仍在执行时。此前实验清理和观察探针曾影响客户端进程；接收探针已停用，当前不自动执行这些清理。遇到持续阻塞或版本变化，按错误提示检查现场，不反复 attach、删除未知锁或自动重启微信。

返回 [README](../README.md)。命令与完整流程见 [命令手册](commands.md) 和 [演示文档](examples.md)；独立发送范围见 [原生发送说明](native-send.md)。
