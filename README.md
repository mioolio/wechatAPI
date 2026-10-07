# WXcc

Windows 微信本地 Node.js CLI / REPL。通过命令自动识别当前登录账号、获取稳定用户编号、读取指定个人会话历史；还支持可撤销的本地聊天副本编辑、本机单目标原生文字发送，以及独立的数据库发现和认证解密副本导出。

账号、目标、PID 和数据库目录在本机运行时识别。分享程序时不需要附带原使用者的账号配置。当前原生适配范围为 **Windows x64、Node.js 24+、微信 4.1.15.13 x64**，且 `Weixin.dll` SHA-256 必须完全匹配：

```text
10f8e995453e2da46d4f2b5080cd6da1f13cc5147746adc119ceae38cb039de5
```

自动发现用于减少换电脑、换账号后的配置步骤，不表示所有微信版本、所有机器和所有数据库参数均已验证。未知版本或二进制不匹配会明确拒绝调用原生入口。

目前自动启动、当前账号识别、原生历史读取和数据库发现已在支持版本上实测。自动取数据库密钥已实现有限只读扫描与认证，但本机测试尚未找到有效密钥，**不能视为自动解密已经实测成功**；可使用私有 `--key-file`。离线解密及 WAL 逻辑通过合成 SQLite 数据测试。详细验证范围见 [命令手册](docs/commands.md)。

## 快速开始

克隆仓库或解压程序，打开 PowerShell，进入程序目录；先正常打开微信并登录自己的账号：

```powershell
git clone https://github.com/mioolio/wechatAPI.git WXcc
cd WXcc
```

```powershell
npm.cmd ci
.\wxcc.cmd start
.\wxcc.cmd account --json
.\wxcc.cmd ids --keyword "测试联系人" --json
```

`start` 自动发现安装位置和唯一主进程，启动或复用常驻只读宿主；不发送消息。通常无需手填 PID、本人 ID、WeFlow 路径或数据库密钥。多个主进程或目录有歧义时，通过 `doctor` 检查后明确选择：

```powershell
.\wxcc.cmd doctor --backend reverse-native --json
.\wxcc.cmd start --pid 12345 --install-path "D:\Apps\Weixin"
```

PID `12345` 为虚构示例。用 `ids` 返回的实际 `u_` 编号读取会话：

```powershell
.\wxcc.cmd history --to u_0123456789abcdef --limit 30 --json
```

示例编号均为虚构，占位编号不能直接使用。用户编号为 `u_` 加真实 ID 的 SHA-256 前 16 位十六进制；新增联系人、排序和改昵称不会改变已有编号。原生读取会重新核验当前账号与目标，不按昵称猜测路由。`ids` 的 `complete:false` 表示已加载联系人缓存，当前不保证全量通讯录。

## 本地聊天副本编辑

取得指定聊天后，可修改 WXcc 保存的本地副本，并随时按修改历史撤销。先使用自己的实际用户编号导入，再复制返回的 `copyId` 和 `record show` 的 `recordId`：

```powershell
.\wxcc.cmd record import --to u_0123456789abcdef --limit 30 --json
.\wxcc.cmd record list --json
.\wxcc.cmd record show --copy c_0123456789abcdef0123456789abcdef --json
.\wxcc.cmd record edit --copy c_0123456789abcdef0123456789abcdef --record-id m_0123456789abcdef --text "本地修改示例" --revision 0 --json
.\wxcc.cmd record changes --copy c_0123456789abcdef0123456789abcdef --json
.\wxcc.cmd record undo --copy c_0123456789abcdef0123456789abcdef --revision 1 --json
.\wxcc.cmd record export --copy c_0123456789abcdef0123456789abcdef --output "D:\Private\history-copy.json" --json
```

上面的 `c_` / `m_` 编号也是虚构示例。编辑可通过 `--text-file` 提供 UTF-8 正文，或用 `--timestamp` 修改毫秒时间；可用 `--revision` 防止基于旧版本修改。来源消息 ID 可能重复，同一副本内固定的 `recordId` 用于精确选择，重新导入会生成新副本和新 `recordId`。`undo` 默认撤销最近未撤销的修改；同一记录按修改顺序从后往前撤销，原文和变更历史始终保留。

已有 `history --no-redact --json` 的私有 UTF-8 JSON 时，也可以完全离线导入：

```powershell
.\wxcc.cmd record import --input "D:\Private\private-history.json" --self wxid_demo_self --to wxid_demo_friend --json
.\wxcc.cmd help record edit
```

离线输入必须含完整 ID、明确本人和唯一聊天；`--self` 必填，默认脱敏历史不能用于导入。副本存放在 `data/history-copies/`。保存后所有查看、修改、撤销及导出操作均离线，不访问微信、不发送消息；微信本机数据库、服务端记录和对方聊天保持原状。导出始终标记 `localOnly`、`edited`、`revision`，默认 ID 脱敏，但名称和正文不会自动隐藏。原文、修改正文及导出文件均应留在私有位置，勿随源码分发。完整参数、限制与撤销规则见 [命令手册](docs/commands.md#本地聊天副本修改撤销与导出)，实际操作见 [示例十五](docs/examples.md#示例十五本地聊天副本修改与撤销)。

## 数据库发现与自动解密

```powershell
.\wxcc.cmd db list --json
.\wxcc.cmd db status --json
.\wxcc.cmd db decrypt --database d_0123456789abcdef --output "D:\Private\session-copy.sqlite" --json
```

`d_` 编号由当前本人 ID 与数据库相对路径计算，来自本次 `db list`。目录发现仅显示元数据，默认不输出账户目录、salt、密钥或消息正文。目录名称匹配先报告 `pending-page-auth`；自动模式只读扫描当前已验证微信进程的有限密钥候选，再通过数据库页面认证。只有这条当前进程路径认证成功，结果才报告 `accountCryptographicBinding:true`。

自动获取密钥可能因客户端内存布局、尚未加载的数据库或加密参数而失败。可显式使用自己的私有密钥文件，命令不接受明文密钥参数：

```powershell
.\wxcc.cmd db decrypt --database d_0123456789abcdef --key-file "D:\Private\db-key.txt" --output "D:\Private\session-copy-2.sqlite" --json
.\wxcc.cmd db decrypt --input "D:\Private\Encrypted\session.db" --key-file "D:\Private\db-key.txt" --output "D:\Private\Offline\session-copy.sqlite" --json
```

离线 `--input` 不需要连接微信，必须提供 `--key-file`。手动密钥证明文件可解密，不证明它属于当前登录进程。支持有限 SQLCipher 3/4 参数；数据库与已提交 WAL 经一致性、页认证和 SQLite `quick_check` 后才发布新副本。原加密库保持只读，不覆盖输出，不保证多个数据库之间的原子快照。

**明文副本包含完整数据库内容，CLI 的 ID 脱敏不会修改副本。** 输出请放在程序和实时数据库目录之外的私有位置，不要随源码或 ZIP 分享。参数、字段和失败恢复见 [完整命令手册](docs/commands.md#数据库命令)。

## 选择发送目标

发送需单独配置本机目标，并启动经过验证的发送宿主。以下步骤本身不发送消息：

```powershell
.\wxcc.cmd configure-target --to u_0123456789abcdef --json
.\wxcc.cmd doctor --backend reverse-native --json
.\wxcc-native-host.cmd --pid 12345 --send
```

目标必须是当前账号快照中的精确个人联系人。配置绑定本人账号与支持的二进制；同一账号重启后可重新建立发送绑定，切换账号须重新配置。每台电脑自行配置，不携带别人机器的目标或宿主描述。

在另一个终端核对 `send.ready:true` 后，才执行明确的发送命令：

```powershell
.\wxcc.cmd inspect --backend reverse-native --json
.\wxcc.cmd send --to u_0123456789abcdef --text "命令测试" --request-id demo-001 --json
.\wxcc.cmd send-status --request-id demo-001 --json
```

`--pick` 可先显示当前编号，再等待选择。只有 `canSend:true` 的本机绑定目标可发送。`accepted` 表示内部提交，不能单独证明对方收到或已读。结果未知时不自动重发；保留原请求 ID 查账本。完整初始化、文本限制和回执说明见 [原生发送说明](docs/native-send.md)。

## 帮助、示范和隐私

```powershell
.\wxcc.cmd help
.\wxcc.cmd help history
.\wxcc.cmd help record edit
.\wxcc.cmd db decrypt --help
.\wxcc.cmd help --json
.\wxcc.cmd
```

无参数进入 REPL，`exit` / `quit` 退出。命令专属帮助包含示例、边界和下一步；拼写错误会提示可能的命令或参数，不自动执行猜测。

- [完整命令手册](docs/commands.md)：逐命令参数、结果字段、后端差异、错误恢复和移植说明。
- [操作与开发示范](docs/examples.md)：PowerShell、cmd、REPL、Node.js `execFile`、数据库与公开演示流程。
- [原生读取说明](docs/native-read.md)：账号、联系人、历史能力与内部结果边界。
- [原生发送说明](docs/native-send.md)：本机目标授权、绑定、账本与回执。

默认 `--redact true`：名称完整显示，真实 ID 部分隐藏，稳定编号可直接用于命令。主动使用 `--no-redact` 或 `--redact false` 才关闭 ID 脱敏，认证凭据仍隐藏。姓名、消息正文、截图及明文数据库仍可能泄露个人信息；稳定编号也可关联同一用户，公开演示建议使用测试账号与虚构材料。

`data/` 中的编号映射、目标配置、宿主 Token、日志、发送账本、消息缓存及 `history-copies/` 中含原文和修改历史的副本都是本机私有运行数据。`artifacts/`、手动导出的数据库和聊天 JSON 也不得进入分发包。换电脑分享源码与锁文件，在接收者机器运行 `npm.cmd ci` 和 `start` 重新初始化。

其他读取后端 `weflow-http`、`weflow-native`、`cache` 继续可用，配置与边界见命令手册。原生监听、原生会话列表、历史分页、媒体发送以及任意微信版本适配尚未实现。

```powershell
npm.cmd test
```

单元测试使用模拟接口或合成数据，不向真实联系人发送消息。常驻宿主保存 Frida 会话，普通 CLI 退出不会卸载脚本或分离；不要把退出 CLI 当作关闭宿主。详细驻留与清理限制见原生说明。
