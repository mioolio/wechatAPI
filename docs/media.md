# 图片、表情包与本地查看

`history` 将微信类型 3 识别为图片、47 识别为表情包，解析原始 XML 中的引用。类型识别不包含自动描述画面或 OCR。

先打开微信并登录，再读取文件助手的媒体：

```powershell
.\wxcc.cmd start
.\wxcc.cmd ids --keyword "文件传输助手" --json
.\wxcc.cmd media --to filehelper --limit 30 --output ".\data\filehelper-media" --json
```

`filehelper` 是文件传输助手的精确内部 ID，仍须存在于当前账号的联系人快照。其他人使用 `ids` 返回的实际编号。

`media` 只输出保存摘要；`history` 同时返回聊天记录及保存摘要。未指定 `--output` 时，发现媒体的历史查询保存到 `data/media/<账号与会话摘要>/`。

| 字段 | 用法 |
| --- | --- |
| `messages[].media[].kind` | `image` 图片，`sticker` 表情包 |
| `media.directory` | 归档目录 |
| `media.indexPath`、`media.indexUrl` | 用浏览器打开本地画廊，点击图片查看文件 |
| `media.manifestPath` | 媒体元数据与状态清单 |
| `media.saved`、`media.unavailable` | 已取得可查看文件、尚不可用项目的数量 |
| `media.items[].reason` | 下载、引用、缓存格式等失败原因 |

画廊和清单名为 `wxcc-media-index.html`、`wxcc-media-manifest.json`。重复读取相同消息会去重，保留已归档内容。图片文件名包含内容 SHA-256；已有不同内容文件不会被覆盖。链接只在本机可用，不会发布到公网。

程序仅查找当前账号目录，也可指定缓存来源：

```powershell
.\wxcc.cmd media --to filehelper --media-root "D:\Private\xwechat_files\当前账号目录" --output "D:\Private\SavedImages"
```

支持普通 PNG、JPEG、GIF、WebP、BMP、单字节 XOR `.dat`、微信 V1/V2 AES+XOR 缓存。原生读取会认证当前账号的硬链接数据库，按消息 MD5 精确找到实际缓存；V2 图片密钥在有大小与时间限制的只读扫描中校验，仅在本次操作内存中使用，随后清除。无需手工提供图片密钥。

有有效链接时可下载微信 CDN 图片。未下载、引用失效或不支持的格式会标为 `unavailable` 并保存原因；不会将 XML 或占位文字当作图片。CLI 隐藏 XML 内媒体密钥，归档清单不保存这些密钥。

## 发送本机图片

完成[单目标与发送宿主配置](native-send.md)后：

```powershell
.\wxcc.cmd configure-target --to filehelper
# 将 12345 换为 doctor 返回的当前主进程 PID
.\wxcc-native-host.cmd --pid 12345 --send
# 在另一个 PowerShell 执行
.\wxcc.cmd send --to filehelper --image "D:\Private\test.png" --request-id my-image-001 --json
.\wxcc.cmd send-status --request-id my-image-001 --json
```

`--image` 与 `--text` 必须且只能选一种。图片须为本机普通文件，最大 25 MiB，校验真实文件头；网址和网络共享路径不接受。发送前保留私有暂存副本，供微信异步处理。

原生图片接口与文字接口分别核验匹配版本、入口字节、当前账号及唯一目标。首次图片接口验证仅对明确绑定的文件助手开放；普通联系人须有匹配版本的真实图片调用验证。

`accepted` 表示客户端内部接收提交；检查文件助手的实际图片记录可进一步核实。未知结果不会自动重发，同一请求 ID 不能复用。

## 验证结果与范围

2026-10-18 在匹配 profile 的 Windows 微信 4.1.15.13 x64 上完成文件助手实测：发送一张 PNG，回读到新增类型 3 消息，XML 中的 MD5 与发送源文件一致；随后通过硬链接映射和 V2 解码保存两张真实图片，保存文件的 MD5 均与消息一致，结果为 `saved:2`、`unavailable:0`。

当时文件助手最近 200 条记录没有类型 47 表情包。表情包识别、GIF 字节保留与保存由自动测试覆盖，尚不能作为真实接收表情包的现场验证。此处验证的是媒体类型与文件处理，不包含画面理解或 OCR。

本次完整回归共 486 项：485 通过、1 跳过、0 失败。以后修改源码可运行 `npm.cmd test` 重新验证。测试图片、聊天、数据库副本、密钥和本机绑定保留在被 Git 忽略的目录中，不随源码提交。
