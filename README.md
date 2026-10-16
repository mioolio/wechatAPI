# WXcc

**用命令找到联系人、读取聊天记录，也能保存一份可修改、可撤销的本地副本。**

想发文字消息或导出数据库，也有对应命令。先按下面的步骤读到一段聊天，再按需要查看[命令手册](docs/commands.md)。

## 第一次使用：读到一个人的聊天记录

准备好 **Windows x64、Node.js 24 或以上版本，以及已登录的微信 4.1.15.13 x64**。程序还会检查微信 DLL 是否匹配；其他版本目前需要另行适配。[详细版本要求](docs/native-read.md#版本和自动启动)

下面的代码都在 **PowerShell** 中执行。

### 1. 安装并连接微信

还没有源码，先下载：

```powershell
git clone https://github.com/mioolio/wechatAPI.git WXcc
cd WXcc
```

已经解压源码的，直接在那个文件夹打开 PowerShell，从这里开始：

```powershell
npm.cmd ci
.\wxcc.cmd start
```

`start` 负责准备读取连接。看到 `"ready": true` 后继续；它不负责打开微信，所以要先自行打开微信并登录。

### 2. 看看当前是谁的账号

```powershell
.\wxcc.cmd account
```

检查 `displayName` 是你要使用的账号名称。

### 3. 找到你要读取的人

把 `小明` 换成好友的备注或昵称：

```powershell
.\wxcc.cmd ids --keyword "小明"
```

结果里每个人都有 `displayName` 和 `alias`。下面只是摘取字段的虚构示意，实际输出以你自己的结果为准：

```json
{
  "users": [
    {
      "displayName": "小明",
      "alias": "u_0123456789abcdef"
    }
  ]
}
```

**下一步要用的是 `alias`，也就是 `u_` 开头的用户编号。** 同名的人可能不止一个，请先确认对象，再复制对应的编号。示例编号不能代替实际结果。

### 4. 读取最近 10 条消息

在同一个 PowerShell 窗口执行，按提示粘贴刚才的 `alias`：

```powershell
$targetAlias = Read-Host "粘贴目标的 alias（u_ 开头）"
.\wxcc.cmd history --to $targetAlias --limit 10
```

在返回的 `messages` 里看 `text`，那就是消息正文。`--limit 10` 表示最多读取最近 10 条；默认 30 条，当前原生读取最多 200 条。

到这里，最常用的流程就跑通了：**连接微信 → 找到人 → 复制编号 → 读取消息。**

## 接下来想做什么？

| 我想做的事 | 从哪里开始 |
| --- | --- |
| 查某条命令怎么用、参数填什么 | [命令手册](docs/commands.md) |
| 按步骤修改聊天副本，再撤销或导出 | [完整操作示范](docs/examples.md#edit-local-copy) |
| 给选定的人发一条文字消息 | [发送配置与步骤](docs/native-send.md)；需要先配置目标及发送连接 |
| 查看数据库、导出解密副本 | [命令手册的数据库部分](docs/commands.md#数据库命令) |
| 在自己的 Node.js 程序中调用 | [脚本调用示范](docs/examples.md#node-integration) |
| 查询错误或换电脑使用 | [命令手册](docs/commands.md) |

终端里也能随时查帮助：

```powershell
.\wxcc.cmd help history
.\wxcc.cmd help record edit
.\wxcc.cmd help send
```

不带参数运行 `.\wxcc.cmd` 会进入 `wxcc>` 交互模式。在那里直接输入 `account`、`history ...` 等命令；上面的 PowerShell 变量和 `Read-Host` 仍应在 PowerShell 中使用。[两种运行方式](docs/commands.md)

## 目前能做什么？

| 功能 | 当前情况 |
| --- | --- |
| 获取当前账号、查找已加载的联系人 | 支持；联系人结果不保证是全部好友 |
| 读取指定个人聊天的最近记录 | 支持；暂不支持原生历史分页或实时监听 |
| 修改聊天副本 | 支持修改正文、时间，保留原文并可撤销；修改的是 WXcc 本地副本 |
| 发送消息 | 支持向本机配置的一个个人目标发送文字；图片、文件、群发尚未接入 |
| 发现数据库、解密导出 | 已在 Windows 微信 4.1.15.13 x64 真机跑通自动取钥，成功导出会话库、主消息库和联系人库；需要微信专用分词器的部分搜索索引库暂不导出，提示 `E_DB_SQLITE_TOKENIZER` |

## 分享前记住这几件事

默认隐藏一部分真实 ID，名称和消息正文仍会显示。稳定用户编号可以直接用于命令；只有主动加 `--no-redact` 才关闭 ID 脱敏。

分享程序时只分享源码。`data/`、`artifacts/`、聊天导出文件、数据库和密钥文件留在自己电脑上。数据库解密副本包含完整明文内容，终端的脱敏设置不会替它隐藏信息。

实现原理、版本指纹与排查细节放在[原生读取说明](docs/native-read.md)和[原生发送说明](docs/native-send.md)。
