# 原生文字发送

`reverse-native` 使用微信自己的任务队列创建协程，再调用匹配版本 DLL 的内部文字发送业务入口。命令指定精确用户编号或内部会话标识，不依赖当前聊天窗口、窗口输入或微信前台状态。

当前支持 Windows x64、Node.js 24+、微信 **4.1.15.13 x64**，并要求本版 DLL SHA-256 完全匹配 profile。已有验证仅支持对应二进制，不能据此声称未知版本或任意机器已验证。

## 每台机器配置自己的目标

源码不内置某个真实收件人。每台电脑先运行只读初始化与联系人获取，再明确配置一个个人目标：

```powershell
.\wxcc.cmd start --json
.\wxcc.cmd account --json
.\wxcc.cmd ids --keyword "测试联系人" --json
.\wxcc.cmd configure-target --to u_0123456789abcdef --json
```

示例编号为虚构值。`configure-target` 读取并校验一致的本人账号、PID、运行代次、版本和当前联系人快照；不按昵称选人，不接受群聊、公众号或服务会话。它只保存本机目标配置，不发送消息，也不自动开放发送入口。

配置文件 `data/native-target.json` 绑定当前本人 `self`、目标精确 ID、当时名称、版本与 DLL 指纹。配置时 PID 和 `sourceGeneration` 保存验证来源，不能作为永不变化的机器标识。同一账号正常重启后，可通过新核验建立新的发送绑定；切换本人账号或版本后必须重新配置。不得把此文件附在共享 ZIP 中。

重新配置已经驻留的发送目标不会自动替换当前 agent。同一发送代次已有其他目标时会拒绝，需在新的运行代次重新准备；工具不自动卸载或重启微信。

## 启动独立发送宿主

用 `doctor` 查看当前主进程，然后手动启动发送宿主：

```powershell
.\wxcc.cmd doctor --backend reverse-native --json
.\wxcc-native-host.cmd --pid 12345 --send
```

PID 为示例，替换为实际主进程。`start` 仅自动启动只读宿主；发送使用独立宿主，并明确选择 PID。`--read` 和 `--send` 不可用于同一次宿主启动。

发送描述默认位于 `data/research-host.json`，绑定位于 `data/native-send-binding.json`。初始化加载 `sendnative_live3`，按本机目标配置核验当前账号及联系人，再生成新的 PID / `generation` 绑定。这一步不发送消息。初始化保持发送闭锁，直到匹配二进制的原生发送验证、入口字节及运行状态均通过。

已有正常宿主可在另一终端执行 bootstrap：

```powershell
node .\src\native-runtime-bootstrap.mjs
```

它核验已加载 agent 状态，不自动替换或卸载失效脚本。启动时记录的既有原生验证只适用于精确 DLL；缺少可用证据时发送保持关闭。

## 检查状态后发送

```powershell
.\wxcc.cmd inspect --backend reverse-native --json
.\wxcc.cmd ids --keyword "测试联系人" --json
```

`inspect` 分别返回 `read` 与 `send`。顶层 `ready:true` 可以只表示读取已就绪，发送需关注 **`send.ready:true`** / `sendAvailable:true`。发送侧还核验 `sendValidated`、`prologuesVerified`、当前本人账号、准确目标、PID、`generation` 及未完成任务。`ids` 中只有同一客户端的就绪绑定目标为 `canSend:true`。

只在明确选中的目标已授权且状态就绪后执行：

```powershell
.\wxcc.cmd send --to u_0123456789abcdef --text "命令测试" --request-id demo-001 --json
```

也可让命令先获取编号再等待选择：

```powershell
.\wxcc.cmd send --pick --text "命令测试" --request-id demo-002
```

输入本次列表中的 `u_` 编号，只允许 `canSend:true`；输入 `cancel` 或空输入取消，不发送消息。获取编号或仅配置目标均不会自动发送。

需要直接使用内部会话标识时：

```powershell
.\wxcc.cmd send --session u_0123456789abcdef --text "命令测试" --request-id demo-003 --json
```

`--to`、`--session` 和 `--pick` 必须且只能选一种。`sessionId` 来自当前绑定，本实现对应内部会话标识，不编造数字数据库 ID。使用目标编号作为 `--session` 时，工具解析到已绑定会话；显示中部分隐藏的 `sessionId` 不能直接作为参数。

每次发送重新核验当前原生账号和联系人。非本机单目标、旧代次、其他账号、同名用户或未知会话均拒绝。目标配置属于使用者自己的明确选择，不等于允许对任何联系人自动广播。

## 正文和请求 ID

正文必须非空且包含非空白内容，Unicode 完整，不含 NUL，UTF-8 总长度不超过 **1024 字节**。中文和 emoji 的字节数不同，字符数量不能代替字节长度。当前只支持文字，没有图片、文件、语音、群发或富媒体发送。

`--request-id` 为 1 至 128 位 ASCII 标识：首位字母或数字，其余可包含字母、数字、`.`、`_`、`:`、`-`；规范化为小写。省略时自动生成 UUID。调用方应在发送前创建并保存自己的请求 ID，每条新的消息使用新的 ID。

请求在进入原生入口前写入 `data/send-requests/` 本机账本，包含目标编号与正文 SHA-256；同一 ID 已保留后，不会再次发送。该约束跨 CLI、宿主和微信重启存在。不要通过改正文、换目标或大小写复用 ID。

## 回执和送达边界

```powershell
.\wxcc.cmd send-status --request-id demo-001 --json
```

此命令离线查询本机账本，不发送、不重试。主要状态：

| 状态 | 意义 | 后续处理 |
| --- | --- | --- |
| `reserved` | 请求已持久化保留，尚无最终本机记录 | 结果不确定，不能直接当作未发送 |
| `accepted` | 客户端内部发送回调接受提交 | 对方客户端收到或已读仍需独立证据 |
| `failed` | 内部调用报告失败 | 工具不会重试；检查原因后再决定新的操作 |
| `unknown` | 超时、连接异常、回执结构异常或保存失败 | 保留原 ID，先核对客户端或对方状态，避免重复消息 |

`deliveryConfirmed:false` 是正常的谨慎回执：当前接口没有独立服务端 ACK 或已读接口。此前匹配版本的授权测试曾通过对方回复确认一条消息到达，这不等于每个 `accepted` 自动确认送达。账本中没有请求也不证明其他宿主从未发送。

超时可能发生在原生调用已提交之后。工具不自动重试，不提供“清账本后补发”恢复流程。自动化脚本必须保留原请求 ID 和未知状态，不通过生成新 ID 盲目重复执行。

## 隐私与宿主驻留

默认名称完整显示、真实 ID 部分隐藏；稳定编号用于路由。`--no-redact` 仅主动关闭 ID 脱敏，认证凭据仍隐藏。名称、正文、截图和账本关联信息仍可能敏感。公开演示使用测试联系人和示范正文，不分享 `data/`、`artifacts/`、Token、目标或绑定。

普通 CLI 退出不卸载 agent、不分离 Frida 会话，初始化和发送完成后宿主继续驻留。原生任务或回调未结束时拒绝继续调用；初始化不会清除阻塞标记。此前实验观察探针与清理路径曾影响微信进程，当前不自动加载该观察探针或执行卸载清理。持续阻塞应检查状态并保留现场，不要反复 attach 或覆写已加载脚本。

返回 [README](../README.md)。完整参数和常见错误见 [命令手册](commands.md)；一步一步示范见 [操作与开发示范](examples.md)。
