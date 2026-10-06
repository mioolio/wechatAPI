import { WxError } from './errors.mjs';

export const COMMAND_HELP = Object.freeze({
  start: { summary: '自动发现微信安装和主进程，启动或复用只读原生宿主。', usage: 'start [--pid PID] [--install-path DIR] [--profile FILE] [--timeout 20000]', examples: ['wxcc start', 'wxcc start --install-path "D:\\Apps\\Weixin" --json'], notes: ['先打开微信并登录。只接受已实现且 DLL SHA-256 匹配的 Windows x64 版本。', '当前原生 ABI 支持 4.1.15.13；不匹配、任务阻塞或源码改变时拒绝继续。', '启动不发送消息。常驻宿主保持运行，CLI 退出不会卸载脚本。'], next: ['wxcc account', 'wxcc ids'] },
  doctor: { summary: '检查安装、版本、进程与选定后端能力。', usage: 'doctor [--backend reverse-native] [--install-path DIR] [--verbose]', examples: ['wxcc doctor --backend reverse-native --json'], notes: ['检查不自动启动微信或发送消息。读取和发送分别报告能力；连接失败会附错误。'], next: ['wxcc start'] },
  status: { summary: 'doctor 的同义命令。', usage: 'status [--backend reverse-native]', examples: ['wxcc status --backend reverse-native'] },
  inspect: { summary: '查看当前原生宿主、代次、读取和发送状态。', usage: 'inspect --backend reverse-native [--token-file FILE]', examples: ['wxcc inspect --backend reverse-native --json'], notes: ['inspect 默认后端仍是 weflow-http，请显式选择 reverse-native。令牌始终隐藏。'] },
  account: { summary: '读取当前已验证的本人账户并登记稳定编号。', usage: 'account [--json] [--no-redact]', examples: ['wxcc account --json'], notes: ['默认 reverse-native。名称完整显示，真实账号 ID 默认部分隐藏。', '只返回当前登录账户；不枚举其他用户的数据。'], next: ['wxcc ids'] },
  accounts: { summary: '列出当前运行代次实际验证过的账户。', usage: 'accounts [--json]', examples: ['wxcc accounts --json'], notes: ['目前原生宿主只证明当前账户；complete:false 不是全盘多账号清单。'] },
  ids: { summary: '读取已加载联系人缓存，登记稳定 SHA-256 用户编号。', usage: 'ids [--keyword NAME] [--json] [--no-redact]', examples: ['wxcc ids --keyword "测试联系人"', 'wxcc ids --json'], notes: ['u_ 加真实 ID 的 SHA-256 前 16 位十六进制；新增用户不会重新编号。', '昵称只用于筛选。history/send 路由使用已登记编号或完整 ID。', 'complete:false 表示客户端已加载缓存，并非全部联系人。获取编号不授权发送。'], next: ['wxcc history --to u_0123456789abcdef --limit 30'] },
  history: { summary: '通过稳定用户编号读取指定个人会话记录。', usage: 'history --to USER [--limit 30] [--json]', examples: ['wxcc history --to u_0123456789abcdef --limit 30 --json', 'wxcc history u_0123456789abcdef --limit 10'], notes: ['默认 reverse-native；先 start，再 ids 登记目标。不需要手填本人 ID 或数据库密钥。', '目前原生读取限明确的个人会话；群聊不在已验证范围。', '返回正文可能包含隐私，ID 脱敏不会自动清除所有正文信息。'], next: ['wxcc help db'] },
  'configure-target': { summary: '将明确选中的个人联系人配置为本机发送目标。', usage: 'configure-target --to USER [--json]', examples: ['wxcc configure-target --to u_0123456789abcdef --json'], notes: ['配置需要当前账号与联系人快照一致；不发送消息。', '目标配置只在本机保存，绑定本人账号和客户端版本；切换账号须重新配置。', '配置完成后仍需要经过验证的发送宿主与新的发送绑定。'], next: ['wxcc help send'] },
  send: { summary: '向当前授权且已绑定的个人会话提交一条文本。', usage: 'send (--to USER | --session STATE | --pick) --text TEXT [--request-id UNIQUE]', examples: ['wxcc send --to u_0123456789abcdef --text "命令测试" --request-id demo-001', 'wxcc send --pick --text "命令测试"'], notes: ['默认 reverse-native。必须有目标配置、已验证的发送 agent 和发送宿主。', '--pick 获取编号后等待选择，仅允许 canSend:true 的目标。', 'accepted 是内部提交，不能单独证明对方收到。超时结果 unknown 不自动重发。', '同一 request-id 不得换目标或正文；先用 send-status 检查结果。'], next: ['wxcc send-status --request-id demo-001'] },
  'send-status': { summary: '查询本机持久化的发送请求状态。', usage: 'send-status --request-id UNIQUE [--json]', examples: ['wxcc send-status --request-id demo-001 --json'], notes: ['不发送、不重试；账本中 accepted 不等于对方送达。'] },
  db: { summary: '发现当前账号数据库，并认证解密数据库及已提交 WAL 为独立副本。', usage: 'db list | db status | db decrypt --database DB --output FILE [--key-file FILE]', examples: ['wxcc db list --json', 'wxcc db decrypt --database d_0123456789abcdef --output "D:\\Private\\copy.sqlite"', 'wxcc db decrypt --input "D:\\Private\\encrypted.db" --key-file "D:\\Private\\key.txt" --output "D:\\Private\\copy.sqlite"'], notes: ['list/status 自动获取当前本人账号，再发现目录；可用 --data-root / --account-dir 明确指定。', 'd_ 编号来自当前本人 ID 与数据库相对路径的 SHA-256；不输出账户目录、salt 或密钥。', 'decrypt 默认只读扫描当前已验证微信进程的有限内存候选，并用数据库首页面认证密钥。', '自动找不到密钥时使用 --key-file；不会借助授权过期的组件、重新登录或重启微信。', '输出必须显式指定且不能已存在。验证页 HMAC、WAL checksum/commit、SQLite quick_check。', '独立明文副本包含完整敏感内容，请存放在私有目录。单库快照，不保证跨库原子一致。', '离线 --input 必须搭配 --key-file，不访问原生宿主。'], next: ['wxcc help db decrypt'] },
  'db list': { summary: '列出当前账号数据库的稳定编号、类型和大小。', usage: 'db list [--data-root DIR] [--account-dir DIR] [--json]', examples: ['wxcc db list --json'], notes: ['仅显示数据库元数据，不显示正文或密钥。名称匹配和解密认证分别报告。'] },
  'db status': { summary: '报告数据库发现状态与加密/WAL数量。', usage: 'db status [--data-root DIR] [--json]', examples: ['wxcc db status --json'] },
  'db decrypt': { summary: '把一个数据库和其已提交 WAL 认证解密为新副本。', usage: 'db decrypt (--database DB | --input FILE) --output FILE [--key-file FILE] [--key-mode raw|passphrase|auto] [--timeout MS]', examples: ['wxcc db decrypt --database d_0123456789abcdef --output "D:\\Private\\copy.sqlite"', 'wxcc db decrypt --input "D:\\Private\\encrypted.db" --key-file "D:\\Private\\key.txt" --key-mode auto --output "D:\\Private\\copy.sqlite"'], notes: ['当前支持有限 SQLCipher3/4 参数：4096 字节页，以及 SQLCipher3 的 1024 字节页。', '密钥文件支持 32 原始字节、64 位十六进制或 SQLCipher x\'64/96hex\'。密钥不接受命令行明文。', '自动模式只读内存，读取前后及发布前确认账号与运行代次。候选不足、参数不匹配均明确失败。', '自动扫描默认 15000 毫秒、512 MiB；--timeout 100–30000 只调整取密钥时限。', '活跃回滚 journal、同代次撕裂 WAL、页面认证失败、快照持续变化或 SQLite 校验失败均不发布副本。'] },
  list: { summary: '通过选定读取后端列出会话。', usage: 'list [--keyword NAME] [--backend weflow-http|weflow-native|cache]', examples: ['wxcc list --backend weflow-http'], notes: ['reverse-native 尚未实现会话列表；原生联系人用 ids。'] },
  contacts: { summary: '通过 WeFlow 读取后端查询联系人。', usage: 'contacts --keyword NAME [--backend weflow-http|weflow-native]', examples: ['wxcc contacts --keyword "测试联系人" --backend weflow-http'], notes: ['reverse-native 使用 ids --keyword NAME。'] },
  watch: { summary: '通过读取后端轮询指定会话的新消息，输出 NDJSON。', usage: 'watch --to USER --self SELF [--interval 1000] [--backend weflow-http|weflow-native]', examples: ['wxcc watch --backend weflow-http --to wxid_demo_friend --self wxid_demo_self'], notes: ['reverse-native 尚未实现 watch；Ctrl+C 停止。默认路径保存本机私有消息缓存。'] },
  probe: { summary: '旧接收探针已停用。', usage: 'probe', notes: ['历史 Frida 清理曾使客户端退出，目前不支持加载接收探针。'] },
  help: { summary: '查看命令专属帮助、示例、下一步；--json 输出结构化命令目录。', usage: 'help [COMMAND [SUBCOMMAND]] [--json]', examples: ['wxcc help history', 'wxcc db decrypt --help', 'wxcc help --json'] },
  exit: { summary: '退出 REPL。', usage: 'exit' },
  quit: { summary: 'exit 的同义命令。', usage: 'quit' },
});

function distance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) { const next = [i + 1]; for (let j = 0; j < b.length; j++) next.push(Math.min(next[j] + 1, row[j + 1] + 1, row[j] + (a[i] === b[j] ? 0 : 1))); row = next; }
  return row[b.length];
}
export function suggestName(value, candidates) {
  const sorted = [...candidates].map(name => ({ name, score: distance(value, name) })).sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  const best = sorted[0];
  return best && best.score <= Math.min(2, Math.max(1, Math.floor(value.length / 3))) && (sorted.length < 2 || sorted[1].score > best.score) ? best.name : null;
}
export function helpData(topic) {
  if (!topic) return { name: 'wxcc', workflow: ['start', 'account', 'ids', 'history', 'db list'], defaultRedaction: true, commands: COMMAND_HELP, documentation: ['docs/commands.md', 'docs/examples.md'] };
  if (!Object.hasOwn(COMMAND_HELP, topic)) { const suggestion = suggestName(topic, Object.keys(COMMAND_HELP)); throw new WxError('INVALID_ARGUMENT', `未知帮助主题：${topic}。${suggestion ? `可能是 ${suggestion}；运行 wxcc help ${suggestion}。` : '运行 wxcc help 查看命令。'}`); }
  return { command: topic, ...COMMAND_HELP[topic] };
}
export function renderHelp(topic) {
  const item = helpData(topic);
  if (topic) return [`wxcc ${topic} — ${item.summary}`, '', `用法：wxcc ${item.usage}`, ...(item.examples?.length ? ['', '示例：', ...item.examples.map(value => `  ${value}`)] : []), ...(item.notes?.length ? ['', ...item.notes] : []), ...(item.next?.length ? ['', '下一步：', ...item.next.map(value => `  ${value}`)] : []), '', '详细文档：docs/commands.md；演示：docs/examples.md', '默认 --redact true；--no-redact 仅主动关闭 ID 脱敏，认证密钥始终隐藏。', ''].join('\n');
  return ['wxcc — 微信本地命令 CLI', '', '快速开始：', '  wxcc start', '  wxcc account', '  wxcc ids --keyword "测试联系人"', '  wxcc history --to <u_16位十六进制编号> --limit 30', '  wxcc db list', '', '命令：', ...Object.entries(COMMAND_HELP).filter(([name]) => !name.includes(' ')).map(([name, value]) => `  ${name.padEnd(18)} ${value.summary}`), '', '帮助：wxcc help history；wxcc help db decrypt；wxcc <命令> --help；wxcc help --json', '选项可放在命令前后。--backend 选择后端；--json 输出 JSON；--redact true|false 默认 true。', '原生命令 start/account/accounts/ids/history/send/send-status/configure-target/db 默认 reverse-native。', 'doctor/status/inspect/list/contacts/watch 默认 weflow-http；原生检查加 --backend reverse-native。', '名称完整显示，ID 部分隐藏；--no-redact 主动关闭 ID 脱敏，认证密钥仍隐藏。', '环境：WXCC_WEIXIN_PATH、WXCC_CONFIG、WXCC_WEFLOW_URL、WXCC_WEFLOW_TOKEN、WXCC_WECHAT_DB_KEY。', '读取宿主 data/native-read-host.json；发送宿主 data/research-host.json；--token-file 明确指定。', '详细文档：docs/commands.md；演示：docs/examples.md。无参数进入 REPL，exit/quit 退出。', ''].join('\n');
}
export function errorHint(code) {
  if (/^E_(?:NATIVE_READ_CONFIG|NATIVE_HOST_OFFLINE|START_)/.test(code)) return '先运行 wxcc start；用 wxcc doctor --backend reverse-native 检查版本、主进程和宿主。';
  if (/^E_(?:RECIPIENT_UNKNOWN|RECIPIENT_NOT_LOADED)/.test(code)) return '运行 wxcc ids --keyword "联系人名称"，使用本次返回的 u_ 编号。';
  if (/^E_DB_(?:KEY|CIPHER|AUTO)/.test(code)) return '运行 wxcc help db decrypt；自动密钥失败时使用私有 --key-file，切勿把密钥贴到日志或命令行。';
  if (/^E_DB_(?:NOT_FOUND|ACCOUNT_BINDING|AMBIGUOUS)/.test(code)) return '运行 wxcc db list --data-root "数据库根目录"；必要时加 --account-dir，目录必须对应当前账号。';
  if (/^E_NATIVE_TARGET/.test(code)) return '先 wxcc ids 获取准确编号，再 wxcc configure-target --to <编号>；配置本身不发送。';
  return undefined;
}
