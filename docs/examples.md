# WXcc 跟做示例

先选一个想做的事情，按其中的小步骤操作。第一次使用，先做第 1 个流程；只想看看本地编辑效果，可以直接做第 5 个离线演示。

| 想做什么 | 从这里开始 | 做完得到什么 |
| --- | --- | --- |
| 读取某位好友的历史 | [1. 第一次读取聊天](#read-first-chat) | 当前账号、目标编号和最近消息 |
| 修改一份聊天副本，再恢复 | [2. 本地修改与撤销](#edit-local-copy) | 可追溯的本地副本和导出 JSON |
| 准备发送一条测试消息 | [3. 准备发送](#prepare-send) | 明确目标、就绪检查和单次发送回执 |
| 找到并解密自己的数据库 | [4. 数据库副本](#database-copy) | 单个数据库的独立明文副本 |
| 不连接微信，练习编辑 | [5. 完全离线演示](#offline-demo) | 使用虚构消息完成一次本地编辑 |
| 从自己的程序调用 WXcc | [6. Node.js 集成](#node-integration) | 参数数组调用和 JSON 结果 |

主流程使用 **PowerShell**，终端停在 WXcc 程序目录。命令返回 JSON；示例中保存到 `$targetAlias`、`$copyId` 等变量的是你本机的真实结果。按步骤在**同一个 PowerShell 终端**执行，遇到报错先停下，不跳过检查。换了终端、微信账号或主进程后，重新获取所需结果，不猜编号或沿用旧状态。

完整参数查 [命令手册](commands.md)。本页末尾有 [cmd、交互模式和中断恢复](#other-terminals)。

<a id="read-first-chat"></a>
## 1. 第一次读取某位好友的聊天

### 第一步：进入程序目录，准备读取

先正常打开微信，登录自己的账号。当前原生适配是 Windows x64、Node.js 24+、微信 4.1.15.13 x64，并且 DLL 指纹必须匹配；安装条件见 [README](../README.md)。

打开 PowerShell，输入程序文件夹的真实路径：

```powershell
Set-Location -LiteralPath (Read-Host "输入 WXcc 程序文件夹的完整路径") -ErrorAction Stop
node --version
npm.cmd ci
if ($LASTEXITCODE -ne 0) { throw "依赖安装失败，先处理上面的错误" }
```

确认 Node 主版本至少为 24，且依赖安装成功，再启动读取：

```powershell
.\wxcc.cmd start --json
if ($LASTEXITCODE -ne 0) { throw "读取准备失败，先看错误提示" }
```

看到 `ready:true`，就可以继续读账号。命令返回提示符后，后台读取程序仍在运行；`reused:true` 表示复用了已有连接。

如果失败，先运行 `.\wxcc.cmd doctor --backend reverse-native --json` 查看诊断，再查 `.\wxcc.cmd help start`。版本或 DLL 指纹不匹配时，需要对应版本的适配，不能修改校验值后硬用。

### 第二步：确认当前账号，找到目标

```powershell
.\wxcc.cmd account --json
if ($LASTEXITCODE -ne 0) { throw "账号读取失败" }

$contactKeyword = Read-Host "输入好友的昵称或备注关键词"
.\wxcc.cmd ids --keyword $contactKeyword --json
if ($LASTEXITCODE -ne 0) { throw "联系人查找失败" }
```

先核对 `account` 的名称确实是本人，再在 `users` 中找目标。下面只是**虚构结果摘取的几个字段**，完整输出还会有其他字段：

```json
{
  "scope": "loaded-contact-cache",
  "complete": false,
  "users": [
    {
      "alias": "u_0123456789abcdef",
      "displayName": "虚构测试好友",
      "canSend": false
    }
  ]
}
```

复制你自己结果中目标的完整 `alias`，通常是 `u_` 加 16 位十六进制字符。存在同名时先辨认清楚，不能直接取第一条。`complete:false` 表示这里是已加载的联系人缓存；`canSend:false` 不影响读取。

```powershell
$targetAlias = Read-Host "粘贴你明确选择的完整 u_ 编号"
```

### 第三步：读取最近 30 条

```powershell
.\wxcc.cmd history --to $targetAlias --limit 30 --json
if ($LASTEXITCODE -ne 0) { throw "历史读取失败" }
```

在 `messages` 中看每条消息：`text` 是正文，`timestamp` 是毫秒时间；`isSelf:true` 表示自己发的，`false` 表示对方，`null` 表示暂时不知道发言人。没有消息时，先确认目标聊天确有历史，再按错误提示或重新选目标处理。

到这里已经完成读取，不需要先解密数据库。想修改一份本地副本，继续下一个流程；`$targetAlias` 继续使用刚才选定的真实编号。

<a id="edit-local-copy"></a>
## 2. 修改一份本地聊天副本，再撤销

先完成流程 1，保留同一个 PowerShell 终端和 `$targetAlias`。这里会把最近消息另存到 WXcc 的私有目录，再改那份副本。修改、撤销和导出不会改变微信本机数据库、服务端或对方聊天，也不发送消息。

### 第一步：导入，记住这份副本

```powershell
$copyId = $null
$rawCopy = .\wxcc.cmd record import --to $targetAlias --limit 30 --json
if ($LASTEXITCODE -ne 0) { throw "副本导入失败" }
$copy = $rawCopy | ConvertFrom-Json
$copyId = $copy.copyId
$rawCopy
```

看 `copyId`、`messageCount`、`revision` 和 `localOnly:true`。`copyId` 就是这份副本的编号；以后查看或编辑都用它。每次 `record import` 都新建副本，重新导入不会刷新刚才那份。

### 第二步：查看副本，选择一条消息

```powershell
$rawCopyView = .\wxcc.cmd record show --copy $copyId --limit 30 --json
if ($LASTEXITCODE -ne 0) { throw "副本查看失败" }
$rawCopyView
$copyView = $rawCopyView | ConvertFrom-Json

$recordId = Read-Host "从 messages 中复制要改那条消息的完整 recordId"
```

这次选的是 `m_` 开头的 **recordId**，不是联系人编号。它能区分同一副本中的消息，即使原始消息 `id` 重复也能准确选择。没有消息时先换一个确有历史的聊天，不能编造 `recordId`。

### 第三步：改正文，核对修改前后

```powershell
$rawEdit = .\wxcc.cmd record edit --copy $copyId --record-id $recordId --text "这是一条只存在于本地副本的演示改写" --revision $copyView.revision --json
if ($LASTEXITCODE -ne 0) { throw "修改失败；版本冲突时先重新 show，核对后再决定" }
$edit = $rawEdit | ConvertFrom-Json
$rawEdit

$rawChanges = .\wxcc.cmd record changes --copy $copyId --limit 30 --json
if ($LASTEXITCODE -ne 0) { throw "修改历史读取失败" }
$changesView = $rawChanges | ConvertFrom-Json
$rawChanges
```

`changes` 的 `before` 是修改前，`after` 是修改后；`changeId` 是这次修改的编号。`revision` 是当前副本版本，示例直接使用实际返回值，不手写版本号。

正文包含复杂引号或换行时，用 `--text-file` 读取自己的 UTF-8 文件；只改时间用 `--timestamp`，单位是毫秒。具体写法可运行 `.\wxcc.cmd help record edit`。编辑只允许改正文和时间。

### 第四步：撤销刚才这次修改

```powershell
$rawUndo = .\wxcc.cmd record undo --copy $copyId --change-id $edit.changeId --revision $changesView.revision --json
if ($LASTEXITCODE -ne 0) { throw "撤销失败，请重新 changes 核对顺序与版本" }
$rawUndo
.\wxcc.cmd record show --copy $copyId --limit 30 --json
if ($LASTEXITCODE -ne 0) { throw "撤销后查看失败" }
```

核对该消息已经恢复原文。撤销也会留下历史并增加 `revision`，不会删除修改记录。同一消息如果后来又改过，要先撤销后面的修改。省略 `--change-id` 时，撤销最近尚未撤销的一次修改。

### 第五步：导出当前内容

输入一个**尚不存在的新 JSON 文件完整路径**，放在程序目录和微信数据目录之外的私有位置，例如你专门保存个人副本的文件夹。

```powershell
$exportPath = Read-Host "输入新的私有 JSON 完整路径（程序和微信数据目录之外）"
if (-not [IO.Path]::IsPathRooted($exportPath)) { throw "请使用完整路径" }
if (Test-Path -LiteralPath $exportPath) { throw "文件已存在，请换新文件名" }
.\wxcc.cmd record export --copy $copyId --output $exportPath --json
if ($LASTEXITCODE -ne 0) { throw "导出失败，请按错误提示检查路径" }
```

看 `ok:true`、`localOnly:true`、`revision`、`redacted:true`。这个流程先撤销再导出，因此文件里是恢复后的内容；只有这一笔修改时，`edited` 会回到 `false`。如果想保留改写，应在撤销之前另选新文件名导出。

默认隐藏部分身份 ID，**名称和正文仍然真实**；导出始终保留 `localOnly`、`edited`、`revision` 标记。修改副本不会自动更新已经导出的文件。`data/history-copies/` 保存原文及修改历史，也属于个人数据。

<a id="prepare-send"></a>
## 3. 准备向明确授权的测试联系人发送

先完成流程 1，确认 `$targetAlias` 对应你愿意发送测试消息的那个个人联系人。这个流程分为准备、检查、发送三段；前两段不会自动发消息。**最后的发送命令单独执行。**

### 第一步：在终端 A 配置目标，确认主进程

```powershell
if ($targetAlias -notmatch '^u_[a-f0-9]{16}$') { throw "请先完成流程 1，选择真实目标" }
.\wxcc.cmd configure-target --to $targetAlias --json
if ($LASTEXITCODE -ne 0) { throw "目标配置失败" }

$rawDiagnosis = .\wxcc.cmd doctor --backend reverse-native --json
if ($LASTEXITCODE -ne 0) { throw "诊断失败" }
$rawDiagnosis
$diagnosis = $rawDiagnosis | ConvertFrom-Json
$mainProcessIdText = Read-Host "从 installation.processes 中输入 role 为 main 的实际 pid"
if ($mainProcessIdText -notmatch '^[1-9][0-9]*$') { throw "PID 应为正整数" }
$mainProcessId = [int]$mainProcessIdText
if (@($diagnosis.installation.processes | Where-Object { $_.pid -eq $mainProcessId -and $_.role -eq 'main' }).Count -ne 1) {
    throw "无法从本次诊断证明这是微信主进程，请先处理诊断结果"
}
```

看配置结果的目标名称和 `configured:true`，以及诊断中的主 PID。多个主进程时明确选自己的那个，不选 `role:"child"`。

### 第二步：另开终端 B，启动发送宿主

终端 B 不会继承终端 A 的变量，所以要重新输入程序路径和刚才核对的主 PID：

```powershell
Set-Location -LiteralPath (Read-Host "输入同一个 WXcc 程序文件夹的完整路径") -ErrorAction Stop
$mainProcessId = Read-Host "输入终端 A 刚才核对的微信主 PID"
if ($mainProcessId -notmatch '^[1-9][0-9]*$') { throw "PID 应为正整数" }
.\wxcc-native-host.cmd --pid $mainProcessId --send
```

这个终端会持续运行。等初始化输出后回到终端 A 检查；看到初始化成功也还没有发送消息。读取和发送需要两个独立宿主，不把 `--read` 与 `--send` 放在同一次启动中。

### 第三步：回到终端 A，确认发送确实就绪

```powershell
$rawRuntime = .\wxcc.cmd inspect --backend reverse-native --json
if ($LASTEXITCODE -ne 0) { throw "发送状态读取失败" }
$rawRuntime
$runtime = $rawRuntime | ConvertFrom-Json
if ($runtime.send.ready -ne $true) { throw "发送尚未就绪，请先处理 send 中的原因" }

$rawSendUsers = .\wxcc.cmd ids --keyword $contactKeyword --json
if ($LASTEXITCODE -ne 0) { throw "目标状态读取失败" }
$rawSendUsers
$sendUsers = $rawSendUsers | ConvertFrom-Json
if (@($sendUsers.users | Where-Object { $_.alias -eq $targetAlias -and $_.canSend -eq $true }).Count -ne 1) {
    throw "已选目标没有 canSend:true，不能继续发送"
}
```

必须同时看到 **`send.ready:true`** 和所选目标的 **`canSend:true`**。顶层 `ready:true` 也可能仅表示读取可用，不能当作发送许可。检查不通过就停在这里，不能换个联系人试发。

### 第四步：决定现在发送时，才执行这一块

**下面会实际提交一条消息。** 先再次核对上一段输出中的目标名称。每条新消息使用新的请求 ID；这段不要当作初始化脚本反复运行。

```powershell
$requestId = "manual-" + [guid]::NewGuid().ToString("D")
Write-Host "请保留本次请求 ID：$requestId"
.\wxcc.cmd send --to $targetAlias --text "命令测试" --request-id $requestId --json
```

不论正常返回还是超时，后续都用**同一个**请求 ID 查状态：

```powershell
.\wxcc.cmd send-status --request-id $requestId --json
```

`accepted` 表示内部提交，不能证明对方收到或已读。超时、`unknown`、`reserved` 或查不到账本时，先核对本机账本、后台发送程序和客户端实际状态，不重新生成 ID 重发，也不把同一个 ID 换目标或正文复用。交互选择 `--pick` 和会话形式 `--session` 的规则见 `.\wxcc.cmd help send`。

<a id="database-copy"></a>
## 4. 从当前账号找到数据库，导出明文副本

先完成流程 1 的读取准备。这个流程解密整个数据库副本，不是只导出刚才选中的好友。

### 第一步：列出数据库，选择实际编号

```powershell
$databaseList = .\wxcc.cmd db list --json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw "数据库发现失败" }
$databaseList.databases | Select-Object alias, role, bytes, walBytes | Format-Table -AutoSize
$databaseAlias = Read-Host "复制要导出的完整 d_ 编号，聊天正文优先选 message-history"
if (@($databaseList.databases | Where-Object { $_.alias -eq $databaseAlias }).Count -ne 1) {
    throw "请使用刚才列表中的完整数据库编号"
}
```

想导出聊天正文，优先选 `role` 为 `message-history` 的主消息库。`session` 是会话列表，`contact` 是联系人；`search-index` 是搜索索引，不等同于主消息库。`binding:"pending-page-auth"` 只说明目录关系匹配，还没有用当前进程的密钥证明归属。

如果找不到自己的数据，先运行 `.\wxcc.cmd help db list`，按实际位置加 `--data-root`；多个同账号目录时加 `--account-dir`。重新执行列表和选择步骤，并在后续 `db decrypt` 使用同样的路径选项，不按“最近修改”猜目录。

### 第二步：自动取密钥并导出

已在 **Windows 微信 4.1.15.13 x64** 真机通过这条路径导出会话库、主消息库和联系人库。不用准备密钥文件，也不用重新登录或重启微信。

```powershell
$databaseOutput = Read-Host "输入新的私有 SQLite 完整路径（程序和微信数据目录之外）"
if (-not [IO.Path]::IsPathRooted($databaseOutput)) { throw "请使用完整路径" }
if (Test-Path -LiteralPath $databaseOutput) { throw "输出已存在，请换新文件名" }
.\wxcc.cmd db decrypt --database $databaseAlias --output $databaseOutput --json
if ($LASTEXITCODE -ne 0) { throw "自动解密失败，先按错误信息排查" }
```

成功看 `ok:true`、`quickCheck:"ok"` 和 `profile`。只有从当前已验证进程取得候选并完成页面认证，才会报告 `accountCryptographicBinding:true`。找不到密钥、数据库尚未加载或参数不支持时会失败，按实际错误处理。

部分搜索索引库会提示 `E_DB_SQLITE_TOKENIZER`：页面认证已通过，但当前 SQLite 缺少微信专用分词器 `MMFtsTokenizer`，无法完成该库的验证，因此不会发布副本。这不说明密钥错误或库已损坏。先选择 `message-history` 主消息库导出聊天正文。其他未识别的 SQLite 检查失败仍返回 `E_DB_INTEGRITY`，同样不发布副本。

### 第三步：有自己的密钥文件时手动导出

先准备好自己的私有文件，再输入路径，不把密钥正文放到终端命令或聊天里。支持的文件格式见 `.\wxcc.cmd help db decrypt`：32 原始字节、64 位十六进制文本或 SQLCipher `x'64/96hex'`；不是任意长度密码。

```powershell
$privateKeyFile = Read-Host "输入自己的私有密钥文件完整路径"
$manualDatabaseOutput = Read-Host "输入另一个尚不存在的私有 SQLite 完整路径"
if (-not [IO.Path]::IsPathRooted($manualDatabaseOutput)) { throw "请使用完整输出路径" }
if (Test-Path -LiteralPath $manualDatabaseOutput) { throw "输出已存在，请换新文件名" }
.\wxcc.cmd db decrypt --database $databaseAlias --key-file $privateKeyFile --output $manualDatabaseOutput --json
if ($LASTEXITCODE -ne 0) { throw "手动解密失败，先处理错误，不替换其他账号密钥试用" }
```

手动模式成功时 `accountCryptographicBinding:false` 是正常的：它证明密钥和库页面匹配，不证明密钥来自当前登录进程。

已有自己的**加密离线副本**时，可用 `db decrypt --input` 代替 `--database`，必须搭配 `--key-file`，不需要连接微信。若副本有 WAL，要保留同目录同名的 `数据库文件名-wal` 并取得一致快照。参数和限制见 [命令手册](commands.md)。

解密输出包含完整真实数据，默认 ID 脱敏不会清洗 SQLite 文件。输出不覆盖已有文件；单库及单 WAL 默认各限 256 MiB，CLI 没有提高上限的选项。持续变化或校验失败时不发布副本，不删除实时库或 WAL 来“修复”。

<a id="offline-demo"></a>
## 5. 完全离线：用两条虚构消息练习编辑

这个流程不需要打开微信。先安装 Node.js 24+、在 WXcc 目录完成 `npm.cmd ci`，再逐步执行。所有身份、名称和正文均为虚构；它们是离线演示数据，可以原样使用。

### 第一步：生成一份演示 JSON

```powershell
$demoInput = Join-Path ([IO.Path]::GetTempPath()) ("wxcc-demo-" + [guid]::NewGuid().ToString("N") + ".json")
$demoJson = @'
{
  "self": "wxid_demo_self",
  "chatId": "wxid_demo_friend",
  "messages": [
    {
      "id": "18446744073709551615",
      "chatId": "wxid_demo_friend",
      "senderId": "wxid_demo_self",
      "senderName": "虚构本人",
      "isSelf": true,
      "type": "1",
      "text": "这是一条虚构原文。",
      "timestamp": 1700000000000
    },
    {
      "id": "demo-message-2",
      "chatId": "wxid_demo_friend",
      "senderId": null,
      "isSelf": null,
      "type": "1",
      "text": "这条演示消息不知道发言人。",
      "timestamp": 1700000001000
    }
  ]
}
'@
[IO.File]::WriteAllText($demoInput, $demoJson, [Text.UTF8Encoding]::new($false))
```

这里 `self`、`chatId`、`senderId` 和消息 `id` 都是精确字符串。大整数 ID 也保留引号；`isSelf` 可为 `true`、`false` 或未知时的 `null`，不能把未知方向猜成本人。真实文件同样只能包含一个明确聊天。

### 第二步：离线导入并查看

```powershell
$rawDemoCopy = .\wxcc.cmd record import --input $demoInput --self wxid_demo_self --to wxid_demo_friend --json
if ($LASTEXITCODE -ne 0) { throw "演示导入失败" }
$demoCopy = $rawDemoCopy | ConvertFrom-Json
$demoCopyId = $demoCopy.copyId
if ($demoCopyId -notmatch '^c_[a-f0-9]{32}$') { throw "没有取得演示 copyId" }

$rawDemoView = .\wxcc.cmd record show --copy $demoCopyId --json
if ($LASTEXITCODE -ne 0) { throw "演示查看失败" }
$rawDemoView
$demoView = $rawDemoView | ConvertFrom-Json
```

看 `messageCount:2` 和 `localOnly:true`。离线文件来源标记为 `file-history-unverified`，不会因为导入就变成微信已验证记录。

### 第三步：准确找到演示原文并修改

这里只按 JSON 中我们明确写入的虚构消息 ID 选择，`recordId` 仍从刚刚生成的副本读取：

```powershell
$demoMatches = @($demoView.messages | Where-Object { $_.id -eq "18446744073709551615" })
if ($demoMatches.Count -ne 1) { throw "演示消息没有唯一匹配，请重新核对 show" }
$demoRecordId = $demoMatches[0].recordId

$rawDemoEdit = .\wxcc.cmd record edit --copy $demoCopyId --record-id $demoRecordId --text "演示：原文已在本地副本中改写。" --revision $demoView.revision --json
if ($LASTEXITCODE -ne 0) { throw "演示修改失败" }
.\wxcc.cmd record show --copy $demoCopyId --json
if ($LASTEXITCODE -ne 0) { throw "修改后查看失败" }
```

核对正文已改变，且 `edited:true`。练习完成；需要撤销或导出时，按流程 2 的对应步骤操作这份 `$demoCopyId`，重新读取当前 `revision`。不要把流程 2 中另一份副本的变量混进来。

真实离线导入需要完整本人 ID 和原始历史 JSON；默认脱敏的 `history` 输出不能拿来导入。保存后的 `list/show/edit/changes/undo/export` 都离线，不访问微信。

<a id="node-integration"></a>
## 6. 开发者：用 Node.js 读取并解析 JSON

把下面保存为自己开发目录中的 `read-chat.mjs`。它启动读取、确认所选编号在当前联系人缓存中，再读取历史；最终只打印摘要，不打印全部正文。

```javascript
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, join } from 'node:path';

const executeFile = promisify(execFile);
const projectArgument = process.argv[2];
const targetAlias = process.argv[3];
if (!projectArgument || !/^u_[a-f0-9]{16}$/.test(targetAlias ?? '')) {
  throw new Error('请传入 WXcc 目录和自己明确选择的完整 u_ 编号');
}
const project = resolve(projectArgument);

async function wxcc(args) {
  const { stdout } = await executeFile(
    process.execPath,
    [join(project, 'bin', 'wxcc.mjs'), ...args, '--json'],
    { cwd: project, windowsHide: true, timeout: 90000, maxBuffer: 8 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

try {
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
} catch (error) {
  console.error(error.stderr?.trim() || error.message);
  process.exitCode = 1;
}
```

在保存脚本的开发目录打开 PowerShell，使用流程 1 选定的实际编号：

```powershell
node .\read-chat.mjs (Read-Host "输入 WXcc 程序文件夹的完整路径") (Read-Host "输入明确选择的实际 u_ 编号")
```

这里调用的是 Node 可执行文件和参数数组，没有启用 shell；路径或正文不会被拼成 shell 代码。先检查进程是否成功退出，再解析 stdout；不要把 stderr 合并进 JSON。`execFile` 的失败会进入 `catch`，CLI 自己的 stderr 默认脱敏。

消息 `serverId` 等 64 位 ID 保留字符串，不转为 Number 或 `[double]`；`"0"` 可能重复，不能直接当唯一键。`isSelf:null` 表示未知，不应按“不是 true 就是对方”来判断。原生历史返回的 `schemaValidated:true`、`historyAvailable:true` 表示读取结构和能力已通过检查。

调用超时不代表底层任务已取消，尤其不能把读取脚本的重试思路套到发送上。需要发送集成时，先在私有状态文件持久保存 request ID，失败后用原 ID 查 `send-status`，不自动重发。

<a id="other-terminals"></a>
## 其他终端、失败恢复与分享

### cmd 和交互模式

cmd 也能运行 WXcc；下面的 `D:\Tools\WXcc` 是示意路径，先改成自己的程序目录。`set /p` 会等待输入刚才结果中的真实编号：

```bat
chcp 65001
cd /d "D:\Tools\WXcc"
wxcc.cmd ids --keyword "自己的联系人关键词" --json
set /p wxccTargetAlias=输入明确选择的完整u_编号：
wxcc.cmd history --to %wxccTargetAlias% --limit 10 --json
```

先按流程 1 安装依赖并启动读取；某条命令报错就先停下。cmd 使用 `%变量名%`，不能原样使用 PowerShell 的 `$targetAlias`。

在程序目录运行 `.\wxcc.cmd` 会进入交互模式，看到 `wxcc>` 后输入命令，不再加 `wxcc.cmd` 前缀：

```text
wxcc> help history
wxcc> account
wxcc> ids --keyword "自己的联系人关键词"
wxcc> exit
```

找到实际编号后，可按帮助输入 `history --to 编号 --limit 10`，把“编号”换成完整 `u_` 值。**交互模式不执行 PowerShell 代码**，不支持 `$targetAlias`、`Read-Host`、管道和本页的变量赋值，不能把前面的 PowerShell 整段粘进去。`exit` / `quit` 只退出客户端，宿主和微信继续运行。发送宿主的 Ctrl+C 会保留宿主，清理方式见 [命令手册](commands.md)。

### 卡住后从哪里继续

| 遇到什么 | 下一步 |
| --- | --- |
| 命令或参数不清楚 | `.\wxcc.cmd help 命令名`；多级命令如 `help record edit` |
| `start` 失败 | `doctor --backend reverse-native --json`，核对安装、版本、DLL 指纹和主 PID |
| 关键词没有结果 | 改关键词重新 `ids`；缓存不是全量好友，不编编号、不直接取同名第一条 |
| 忘了 `$copyId` | `record list --json`，按账号、聊天和创建时间明确选择，再 `record show` 核对；不用重新导入猜哪份是原副本 |
| 修改或撤销报版本冲突 | 重新 `record show` / `record changes`，读当前 `revision` 并核对内容后再决定，不去掉版本检查硬重试 |
| 导出路径被拒绝 | 选程序和微信数据目录之外的新文件，已有导出不能覆盖 |
| 自动解密找不到密钥 | 核对当前账号、支持的微信版本和刚列出的数据库编号；有自己的私有密钥文件时，可使用 `--key-file` |
| 解密报 `E_DB_SQLITE_TOKENIZER` | 已确认缺少微信专用分词器，暂时不能验证并导出该索引库；聊天正文优先选 `message-history` |
| 解密报 `E_DB_INTEGRITY` | 其他 SQLite 完整性检查失败，不会发布副本；先保留错误信息和源文件 |
| 发送超时或状态未知 | 保留原请求 ID 查 `send-status` 并核对客户端，不重复提交 |

### 哪些内容不能直接分享

默认脱敏只处理身份 ID 和认证秘密，不会把整份聊天变成公开素材。名称、正文、修改前后内容及完整 SQLite 副本仍含隐私；`u_` 编号也能关联同一用户。公开演示优先使用流程 5 的虚构 JSON，真实消息输出先在本机检查。

分享程序时不要附带 `data/`、`artifacts/`、日志、缓存、密钥、数据库、个人配置和手工导出；压缩包不会因为有 `.gitignore` 就自动排除它们。换电脑后重新安装依赖、识别账号和选择目标，PID、宿主描述、Token 与发送配置不直接迁移。

已有 WeFlow 的 HTTP / 本地读取与监听属于进阶用法，见 [命令手册](commands.md)。原生 `watch` 尚未实现，不能把本页的原生历史读取当作实时监听。

返回 [README](../README.md)。
