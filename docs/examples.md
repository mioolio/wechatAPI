# WXcc 操作与开发示范

本页给出可以逐步执行的操作流程。示例联系人“测试联系人”、`u_0123456789abcdef`、`d_0123456789abcdef`、`wxid_demo_self`、PID `12345` 与路径均为虚构占位值。先在自己的微信和当前机器获取实际编号，不直接运行占位发送命令。

新使用者先阅读 [命令手册](commands.md)。下面普通读取示范不发送消息；包含发送的步骤会明确写出发送命令。

## 示例一：从零开始读取指定聊天

在 PowerShell 进入解压后的程序目录，确保 Windows x64、Node.js 24+ 与支持的微信二进制。正常打开微信并登录自己的账号：

```powershell
Set-Location -LiteralPath "D:\Tools\WXcc"
node --version
npm.cmd ci
.\wxcc.cmd start --json
```

成功结果关注 `ready:true`、`accountVerified:true`、`historyAvailable:true` 和 `automaticMessagesSent:0`。`reused:true` 表示复用旧读取宿主，第一次成功启动通常为 false。宿主保持运行，CLI 返回终端不代表宿主退出。

获取本人编号及想读取的联系人：

```powershell
.\wxcc.cmd account --json
.\wxcc.cmd ids --keyword "测试联系人" --json
```

选择目标的完整 `alias`。下面 JSON 只是**字段示意**，不是实际获取结果，也不承诺展示 ID 的省略形式完全相同：

```json
{
  "scope": "loaded-contact-cache",
  "complete": false,
  "users": [
    {
      "alias": "u_0123456789abcdef",
      "displayName": "测试联系人",
      "chatId": "wxid_…",
      "canSend": false
    }
  ],
  "automaticMessagesSent": 0
}
```

`canSend:false` 只表示没有就绪发送绑定，不影响读取。`complete:false` 表示已加载缓存，不是全部好友。若返回同名多条，请根据自己的联系人身份明确选一个；不能自动取第一条。

用实际编号读取最近 30 条：

```powershell
.\wxcc.cmd history --to u_0123456789abcdef --limit 30 --json
```

此流程无需 WeFlow、数据库解密或手填本人 ID。只读结果 `schemaValidated:true` / `historyAvailable:true` 可帮助判断路径是否核验成功。正文仍可能包含隐私，勿直接把真实输出贴到公开平台。

## 示例二：路径、进程和帮助排错

首次自动启动失败时先看专属帮助与诊断：

```powershell
.\wxcc.cmd help start
.\wxcc.cmd doctor --backend reverse-native --json
```

需要明确选择安装和主进程时：

```powershell
.\wxcc.cmd start --install-path "D:\Apps\Weixin" --pid 12345 --timeout 60000 --json
```

PID 使用实际 `role:"main"` 的进程，不用子进程。未知微信版本、相同版本但 DLL 指纹不同，均不能通过修改 JSON 的 hash 或 RVA 强行适配。

查看命令目录与自动化可解析帮助：

```powershell
.\wxcc.cmd help history
.\wxcc.cmd history --help
.\wxcc.cmd help db decrypt
.\wxcc.cmd db decrypt --help
.\wxcc.cmd help --json
```

帮助不会接触微信或数据库。拼写提示只建议修正，不自动执行猜测。比如 `hstory` 被拒绝后按提示输入正确 `history`。

## 示例三：REPL 连续读取

```powershell
.\wxcc.cmd
```

提示符后的输入示范：

```text
wxcc> help
wxcc> start
wxcc> account
wxcc> ids --keyword "测试联系人"
wxcc> history --to u_0123456789abcdef --limit 10
wxcc> db list
wxcc> help db decrypt
wxcc> exit
```

这里不输入 `wxcc` 前缀。名称、正文和带空格的路径加引号。参数错误会报告并继续等待，不退出整个 REPL。用 `wxcc.cmd --json` 启动 REPL 可继承 JSON 输出。`exit` / `quit` 只退出客户端，宿主与微信继续运行。

## 示例四：cmd 中使用

在 Windows 命令提示符中：

```bat
chcp 65001
cd /d D:\Tools\WXcc
npm.cmd ci
wxcc.cmd start --json
wxcc.cmd account --json
wxcc.cmd ids --keyword "测试联系人" --json
wxcc.cmd history --to u_0123456789abcdef --limit 10 --json
```

cmd 中的引号和 PowerShell 不完全相同。简单文本用双引号，正文包含复杂引号、`&`、`%` 等 shell 字符时，开发脚本推荐使用下面 `execFile` 的参数数组，不拼接 shell 字符串。

## 示例五：PowerShell 解析 JSON

先检查退出码，再解析结果；不要把 stderr 混入 stdout：

```powershell
$rawAccount = .\wxcc.cmd account --json
if ($LASTEXITCODE -ne 0) { throw "account 读取失败" }
$account = $rawAccount | ConvertFrom-Json
Write-Host "当前账号名称：$($account.displayName)"
Write-Host "本人编号：$($account.alias)"

$rawUsers = .\wxcc.cmd ids --keyword "测试联系人" --json
if ($LASTEXITCODE -ne 0) { throw "ids 读取失败" }
$users = $rawUsers | ConvertFrom-Json
$users.users | Select-Object displayName, alias, canSend

$selectedAlias = Read-Host "请输入上面明确选择的完整 u_ 编号"
if ($selectedAlias -notmatch '^u_[a-f0-9]{16}$') { throw "编号格式错误" }
if (@($users.users | Where-Object { $_.alias -eq $selectedAlias }).Count -ne 1) {
    throw "编号不在本次筛选结果中"
}

$rawHistory = .\wxcc.cmd history --to $selectedAlias --limit 10 --json
if ($LASTEXITCODE -ne 0) { throw "history 读取失败" }
$history = $rawHistory | ConvertFrom-Json
Write-Host "本次记录数：$($history.messages.Count)"
```

该示范只显示数量，避免自动把所有正文写到终端或日志。想私下查看正文可使用 `$history.messages`，其内容仍是个人聊天数据。`serverId` 保持字符串，不转换为 `[double]` 或 JS Number。

不要通过把昵称结果的第一条直接发送来省掉选择。用户编号稳定，姓名仅用于识别。

## 示例六：Node.js 用 `execFile` 调用读取

将下方保存为自己开发目录的 `read-chat.mjs`。依次传入 WXcc 项目目录与已明确选择的实际用户编号：

```powershell
node .\read-chat.mjs "D:\Tools\WXcc" u_0123456789abcdef
```

```javascript
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, join } from 'node:path';

const executeFile = promisify(execFile);
const project = resolve(process.argv[2] ?? '.');
const targetAlias = process.argv[3];
if (!/^u_[a-f0-9]{16}$/.test(targetAlias ?? '')) {
  throw new Error('传入自己明确选择的完整 u_ 编号');
}

async function wxcc(args) {
  const { stdout } = await executeFile(
    process.execPath,
    [join(project, 'bin', 'wxcc.mjs'), ...args, '--json'],
    { cwd: project, windowsHide: true, timeout: 90000, maxBuffer: 8 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

await wxcc(['start']);
const account = await wxcc(['account']);
const contacts = await wxcc(['ids']);
if (!contacts.users.some(user => user.alias === targetAlias)) {
  throw new Error('所选编号不在当前已验证的联系人缓存中');
}
const history = await wxcc(['history', '--to', targetAlias, '--limit', '30']);

console.log(JSON.stringify({
  accountAlias: account.alias,
  targetAlias,
  messageCount: history.messages.length,
  schemaValidated: history.schemaValidated,
  automaticMessagesSent: history.automaticMessagesSent,
}, null, 2));
```

这里传入 Node 可执行文件及参数数组，没有启用 shell，路径、昵称与正文不作为 shell 代码解释。Node CLI 失败会拒绝 Promise，调用方应捕获并报告 redacted stderr；不能把超时自动重试模板复用于发送。此脚本只显示结果摘要，不保存正文。

JSON 输出不保证所有消息字段都有值；缺失发言人时 `isSelf` 可能为 null，serverId 可能为 `"0"`。消息去重方案应结合实际业务来源，不能把 `Number(serverId)` 当唯一键。

## 示例七：发现当前本人数据库

先启动只读能力，列出元数据：

```powershell
.\wxcc.cmd start --json
.\wxcc.cmd db list --json
.\wxcc.cmd db status --json
```

关注数据库条目的 `alias`、`kind`、`bytes`、`walBytes`。`binding:"pending-page-auth"` 表示目录关系匹配，尚未通过当前进程密钥证明文件归属。这时不要声称已经完成自动解密。

如果微信数据不在默认 Documents：

```powershell
.\wxcc.cmd db list --data-root "D:\WechatData\xwechat_files" --json
```

多个同账号目录或备份产生歧义时明确目录：

```powershell
.\wxcc.cmd db list --data-root "D:\WechatData\xwechat_files" --account-dir "D:\WechatData\xwechat_files\wxid_demo_self_demo" --json
```

不要按“最近修改”自动挑选其他账号，也不要在公开截图中展开真实路径。示例目录名须替换为当前本人实际目录。

## 示例八：自动获取密钥并导出副本

选用刚才 `db list` 的实际编号，把输出放在程序和实时库目录之外：

```powershell
.\wxcc.cmd db decrypt --database d_0123456789abcdef --output "D:\Private\session-copy.sqlite" --json
```

成功应包括 `ok:true`、`quickCheck:"ok"`、支持的 `profile`、页数与 WAL 摘要。只有从当前已验证微信进程读到候选并完成认证时，才有 `accountCryptographicBinding:true`、`binding:"current-process-page-auth"`。

自动模式只读内存、有限扫描，不会打印 key 或保存 keyfile。候选未发现、DB 未加载、加密参数不受支持、权限不足或账号变化均可能失败；失败不代表可以用其他账号 key 或修改校验强行继续。

输出包含完整真实数据，`--redact true` 不会清洗 SQLite 副本。不要把该目录设为项目分发目录，也不要把副本录屏或上传。

## 示例九：私有密钥文件与离线导出

如果有自己的私有 keyfile：

```powershell
.\wxcc.cmd db decrypt --database d_0123456789abcdef --key-file "D:\Private\db-key.txt" --output "D:\Private\session-copy-manual.sqlite" --json
```

文件内容格式见 [密钥文件说明](commands.md#db-decrypt自己的密钥文件)。不要执行把真实 key 放进命令行或聊天窗口的命令。本工具支持 32 字节 key、64 位十六进制文本和 SQLCipher x'64/96hex'，不是任意长度密码导入。

有自己的加密离线副本时无需启动宿主：

```powershell
.\wxcc.cmd db decrypt --input "D:\Private\Encrypted\session.db" --key-file "D:\Private\db-key.txt" --key-mode raw --output "D:\Private\Offline\session-copy.sqlite" --json
```

手动模式只证明 key 与库页面匹配，`accountCryptographicBinding:false` 不代表解密失败。需要尝试 PBKDF2 模式时显式 `--key-mode passphrase` 或 `auto`；它仍要求 32 字节材料。

如果原加密副本有 WAL，需要保留同目录同名 `session.db-wal` 并取得一致快照。不要丢掉 WAL 后把缺失的最近消息误判为不存在。模块只导出已提交事务，校验失败拒绝发布。

输出不能覆盖，第二次导出选新文件名。当前单个主库或 WAL 默认 256 MiB 上限，CLI 没有提高上限选项。持续变化时待客户端事务完成后重试，不删除实时侧文件。

## 示例十：只读查看解密副本结构

将下方保存为私有开发目录的 `inspect-copy.mjs`。它只显示表数量、表名和 SQLite quick_check，不打印消息正文：

```powershell
node .\inspect-copy.mjs "D:\Private\session-copy.sqlite"
```

```javascript
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';

if (!process.argv[2]) throw new Error('传入自己的明文副本路径');
const db = new DatabaseSync(resolve(process.argv[2]), {
  readOnly: true,
  enableExtensionLoading: false,
});
try {
  db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;');
  const tables = db.prepare(
    "SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name",
  ).all();
  const check = db.prepare('PRAGMA quick_check').all();
  console.log(JSON.stringify({ tables, check }, null, 2));
} finally {
  db.close();
}
```

使用自己已完成认证的明文副本，不指向实时加密库。不同客户端版本的表与列可变化，当前没有统一 SQL 聊天导出接口；不要猜测某列就是精确的业务用户 ID。表名也可能含个人标识，分享前检查。

## 示例十一：配置并向自己授权的测试联系人发送

此流程包含实际发送。先明确自己授权的一个个人目标，在本机完成配置；如果当前只需要读取，停在其他示例即可。

```powershell
.\wxcc.cmd start --json
.\wxcc.cmd account --json
.\wxcc.cmd ids --keyword "测试联系人" --json
.\wxcc.cmd configure-target --to u_0123456789abcdef --json
.\wxcc.cmd doctor --backend reverse-native --json
```

把主 PID 替换为当前实际值，在一个终端启动独立发送宿主：

```powershell
.\wxcc-native-host.cmd --pid 12345 --send
```

初始化不发消息。在另一终端检查 `send.ready:true`，而非只看顶层 ready：

```powershell
.\wxcc.cmd inspect --backend reverse-native --json
.\wxcc.cmd ids --keyword "测试联系人" --json
```

仅明确配置的目标应为 `canSend:true`。如果 false，查看错误，不自动换目标或去掉验证。发送一条新的示范消息：

```powershell
.\wxcc.cmd send --to u_0123456789abcdef --text "命令测试" --request-id demo-001 --json
.\wxcc.cmd send-status --request-id demo-001 --json
```

`demo-001` 是示范，实际每条新消息使用新的请求 ID。即使看到 accepted，也要对方回复或其他独立证据才能确认抵达，不能把内部提交回执当作已读。

### 交互选择或取消

```powershell
.\wxcc.cmd send --pick --text "命令测试" --request-id demo-002
```

命令显示列表后输入实际 `u_`；选择不在本次列表中或 `canSend:false` 会拒绝。输入 `cancel` 可验证取消路径，不发送。

### 按绑定内部会话状态发送

```powershell
.\wxcc.cmd send --session u_0123456789abcdef --text "命令测试" --request-id demo-003 --json
```

三种目标形式互斥，不能同时加 --to 和 --session。用户编号解析为当前绑定内部会话，不使用假的数字状态 ID。

## 示例十二：Node.js 发送一次并保留请求状态

下面是开发集成示意。保存为 `send-once.mjs`，仅在本机已配置的授权测试联系人及发送宿主就绪后使用。它通过私有状态文件区分首次请求与复查；已有状态时只查账本，不重复发送。

```powershell
node .\send-once.mjs "D:\Tools\WXcc" u_0123456789abcdef "D:\Private\send-demo-state.json"
```

```javascript
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, join, dirname } from 'node:path';
import { readFile, mkdir, open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const executeFile = promisify(execFile);
const project = resolve(process.argv[2] ?? '.');
const alias = process.argv[3];
const stateArgument = process.argv[4];
if (!/^u_[a-f0-9]{16}$/.test(alias ?? '') || !stateArgument) {
  throw new Error('传入已授权编号和私有状态文件路径');
}
const stateFile = resolve(stateArgument);

async function wxcc(args) {
  const { stdout } = await executeFile(
    process.execPath,
    [join(project, 'bin', 'wxcc.mjs'), ...args, '--json'],
    { cwd: project, windowsHide: true, timeout: 90000, maxBuffer: 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

let previous;
try { previous = JSON.parse(await readFile(stateFile, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (previous) {
  if (previous.alias !== alias || !previous.requestId) {
    throw new Error('私有状态与本次目标不一致，不能复用');
  }
  console.log(JSON.stringify(await wxcc([
    'send-status', '--request-id', previous.requestId,
  ]), null, 2));
} else {
  const runtime = await wxcc(['inspect', '--backend', 'reverse-native']);
  const users = await wxcc(['ids']);
  if (runtime.send?.ready !== true ||
      !users.users.some(user => user.alias === alias && user.canSend === true)) {
    throw new Error('本机授权目标或发送宿主未就绪');
  }
  const requestId = `demo-${randomUUID()}`;
  await mkdir(dirname(stateFile), { recursive: true });
  const file = await open(stateFile, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify({ requestId, alias, status: 'pending' }));
    await file.sync();
  } finally { await file.close(); }

  try {
    const receipt = await wxcc([
      'send', '--to', alias, '--text', '命令测试', '--request-id', requestId,
    ]);
    console.log(JSON.stringify(receipt, null, 2));
  } catch {
    // 超时可能已提交；保留状态文件，下次仅查相同请求，不自动重发。
    console.error(`发送结果需核对，保留请求 ID：${requestId}`);
    process.exitCode = 1;
  }
}
```

调用方超时也不能保证 WXcc / 原生任务已取消。私有状态文件、CLI 发送账本和客户端实际状态需一起核对。不存在账本或 pending 不是重发许可；不要删除状态文件再运行来“自动恢复”。Windows 的 `0o600` 不能替代目录 ACL，状态目录仍需使用自己的私有位置。

## 示例十三：已有 WeFlow 后端监听

仅在自己的 WeFlow 本机 API 配置完成时：

```powershell
.\wxcc.cmd watch --backend weflow-http --to wxid_demo_friend --self wxid_demo_self --token-file "D:\Private\weflow-token.txt" --interval 1000
```

使用准确完整会话 ID 和本人 ID，HTTP 后端不会自动解析 `u_`。Token 文件是 API Token 文本，不是原生宿主描述。输出为 NDJSON，Ctrl+C 停止监听；监听会写入本机账号隔离消息缓存。reverse-native watch 尚未实现，不要在公开演示中称已支持原生实时接收。

## 示例十四：公开演示与交给另一台电脑

公开演示推荐使用专门测试账号、明确授权的测试联系人和没有个人内容的示范消息：

```powershell
.\wxcc.cmd help history
.\wxcc.cmd help db decrypt
.\wxcc.cmd start --json
.\wxcc.cmd account --json
.\wxcc.cmd ids --keyword "测试联系人" --json
.\wxcc.cmd history --to u_0123456789abcdef --limit 3 --json
```

默认脱敏保持开启。完整名称仍显示，正文仍可能敏感，u_ 编号也会关联同一用户；只有测试素材适合直接录屏。演示数据库时可以展示 help 或合成结果，不打开真实明文库、keyfile 或 Token 描述。

分发源码与锁文件及文档，排除 `data/`、`artifacts/`、日志、缓存、密钥、数据库、个人配置和手工导出。不要仅凭 `.gitignore` 假设 ZIP 自动排除这些内容。

接收者在另一台支持的机器执行：

```powershell
npm.cmd ci
.\wxcc.cmd start
.\wxcc.cmd account
.\wxcc.cmd ids --keyword "自己的测试联系人"
.\wxcc.cmd db list
```

发送按接收者自己的账号和目标重新配置。原有 PID、generation、Token 和授权文件不适合迁移。若二进制不匹配或自动 key 不可用，工具应明确失败并按自己的环境继续适配，不能声称已验证所有机器。

返回 [README](../README.md)。逐参数说明、错误表及支持边界见 [命令手册](commands.md)。
