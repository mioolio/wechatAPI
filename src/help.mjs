import { WxError } from './errors.mjs';

export const COMMAND_HELP = Object.freeze({
  start: { summary: '连接已经登录的微信，准备读取聊天。', usage: 'start [--pid PID] [--install-path DIR] [--profile FILE] [--timeout MS]', examples: ['wxcc start', 'wxcc start --install-path "D:\\Apps\\Weixin" --json'], notes: ['先打开微信并登录。当前支持微信 4.1.15.13 x64，程序会检查安装文件是否匹配。', '默认等待 60 秒；--timeout 使用毫秒，例如 60000。看到 ready:true 后继续查看账号和联系人。', '后台读取程序会继续运行；本次 CLI 命令结束后，读取连接仍然保留。'], next: ['wxcc account', 'wxcc ids --keyword "小明"'] },
  doctor: { summary: '检查安装、版本、进程与选定后端能力。', usage: 'doctor [--backend reverse-native] [--install-path DIR] [--verbose]', examples: ['wxcc doctor --backend reverse-native --json'], notes: ['检查不自动启动微信或发送消息。读取和发送分别报告能力；连接失败会附错误。'], next: ['wxcc start'] },
  status: { summary: 'doctor 的同义命令。', usage: 'status [--backend reverse-native]', examples: ['wxcc status --backend reverse-native'] },
  inspect: { summary: '查看当前原生宿主、代次、读取和发送状态。', usage: 'inspect --backend reverse-native [--token-file FILE]', examples: ['wxcc inspect --backend reverse-native --json'], notes: ['inspect 默认后端仍是 weflow-http，请显式选择 reverse-native。令牌始终隐藏。'] },
  account: { summary: '查看当前微信登录的是哪个账号。', usage: 'account [--json] [--no-redact]', examples: ['wxcc account --json'], notes: ['看 displayName 核对账号名称；alias 是该账号的用户编号。', '名称完整显示，真实账号 ID 默认部分隐藏。目前只返回当前登录账号。'], next: ['wxcc ids --keyword "小明"'] },
  accounts: { summary: '列出当前运行代次实际验证过的账户。', usage: 'accounts [--json]', examples: ['wxcc accounts --json'], notes: ['目前原生宿主只证明当前账户；complete:false 不是全盘多账号清单。'] },
  ids: { summary: '按备注或昵称找人，取得用于命令的用户编号。', usage: 'ids [--keyword NAME] [--json] [--no-redact]', examples: ['wxcc ids --keyword "小明"', 'wxcc ids --json'], notes: ['在 users 里核对 displayName，复制对应 alias（u_ 开头）；下一步把它填到 history --to 后。', '同名联系人可能有多条，请明确选择；部分隐藏的 chatId 不能用于命令。', 'complete:false 表示当前已加载的联系人，不保证包含全部好友。canSend:false 不影响读取历史。'], next: ['wxcc help history'] },
  history: { summary: '读取指定好友最近的聊天记录。', usage: 'history --to USER [--limit 30] [--json]', examples: ['wxcc history --to u_0123456789abcdef --limit 10', 'wxcc history --to u_0123456789abcdef --limit 30 --json'], notes: ['--to 填 ids 返回的实际 alias。这里的编号是虚构示例，请替换。', '在 messages 中看 text（正文）、timestamp（时间）和 isSelf（是否自己发的）。', '默认最近 30 条，--limit 为 1 至 200；当前原生读取限个人聊天。', '想修改副本，下一步用 record import；姓名和正文仍会完整显示。'], next: ['wxcc help record import'] },
  record: {
    summary: '将指定聊天记录保存为本地副本，离线修改、撤销并导出。',
    usage: 'record import | list | show | edit | changes | undo | export',
    examples: ['wxcc record import --to u_0123456789abcdef --limit 30 --json', 'wxcc help record edit', 'wxcc record list --json'],
    notes: ['仅编辑 WXcc 私有 data/history-copies 中的副本，微信本机数据库、服务端及对方聊天均不改变。', 'import --to 默认 reverse-native 并读取指定聊天；import --input 及后续子命令全部离线，不访问微信或发送消息。', '原文与修改正文均保留，可用 changes 查看、undo 撤销。副本及导出文件包含私人聊天数据，勿发布。', 'c_32位十六进制 copyId、m_16位十六进制 recordId 和 e_32位十六进制 changeId 均使用实际返回值。'],
    next: ['wxcc help record import', 'wxcc help record edit', 'wxcc help record undo'],
  },
  'record import': {
    summary: '读取指定聊天或导入已有未脱敏 history JSON，建立新的本地副本。',
    usage: 'record import (--to USER [--limit 30] | --input FILE --self SELF [--to USER]) [--json]',
    examples: ['wxcc record import --to u_0123456789abcdef --limit 30 --json', 'wxcc record import --input "D:\\Private\\private-history.json" --self wxid_demo_self --to wxid_demo_friend --json'],
    notes: ['直接读取默认 reverse-native；先 start、account、ids，使用已登记编号或精确完整聊天 ID。原生 limit 为 1–200，默认 30。', '文件导入完全离线；输入为 history --no-redact --json 的对象 {self?,chatId?,messages}，不能导入脱敏 ID 或多个聊天混合记录。', '输入须为普通、有效 UTF-8 JSON 文件，最多 64 MiB、10000 条记录；每次导入都建立新副本，不合并或刷新旧副本。', '文件导入要求 --self 明确的精确本人 ID；与文件 self 若都存在须一致，目标必须唯一并与每条消息验证一致。', '文件 --to 可用精确聊天 ID 或已登记 u_ 编号；省略时须能从文件 chatId 或所有消息证明唯一聊天。', '成功返回 copyId、source:"local-history-copy"、localOnly:true、revision:0；原始来源消息 ID 保留为完整字符串。'],
    next: ['wxcc record list --json', 'wxcc help record show'],
  },
  'record list': {
    summary: '离线列出已保存的本地聊天副本。',
    usage: 'record list [--json]',
    examples: ['wxcc record list --json'],
    notes: ['不需要指定微信账号、宿主或后端；使用返回的实际 copyId 操作副本。', '本地列表及名称也可能包含隐私。'],
    next: ['wxcc help record show'],
  },
  'record show': {
    summary: '离线查看一个副本的当前记录及稳定 recordId。',
    usage: 'record show --copy COPY [--limit 30] [--json]',
    examples: ['wxcc record show --copy c_0123456789abcdef0123456789abcdef --limit 30 --json'],
    notes: ['copyId 为 c_ 加 32 位十六进制；这里的编号是虚构示例。limit 为 1–10000，默认 30。', '每条记录的 m_16位十六进制 recordId 在同一副本内固定，由 copyId 和原始行号生成；重新导入会生成新副本和新 recordId。来源 id 保持字符串，可重复，包括 "0"。', '修改时优先使用 recordId；当前 revision 可用作修改与撤销的版本保护。'],
    next: ['wxcc help record edit'],
  },
  'record edit': {
    summary: '离线修改副本中一条记录的正文或毫秒时间，保留原文与变更历史。',
    usage: 'record edit --copy COPY (--record-id RECORD | --message-id SOURCE_ID) [--text TEXT | --text-file FILE] [--timestamp MS] [--revision N] [--json]',
    examples: ['wxcc record edit --copy c_0123456789abcdef0123456789abcdef --record-id m_0123456789abcdef --text "本地修改示例" --revision 0 --json', 'wxcc record edit --copy c_0123456789abcdef0123456789abcdef --record-id m_0123456789abcdef --text-file "D:\\Private\\replacement.txt" --json', 'wxcc record edit --copy c_0123456789abcdef0123456789abcdef --record-id m_0123456789abcdef --timestamp 1791321600000 --json'],
    notes: ['必须指定一条记录，并至少提供正文或 timestamp；--record-id 与 --message-id 互斥，--text 与 --text-file 互斥。', '空字符串正文合法；正文不含 NUL，直接正文及有效 UTF-8 正文文件均最多 1 MiB。timestamp 使用毫秒。', 'timestamp / revision 必须为 0–9007199254740991 的整数，revision:0 合法。', '--message-id 精确匹配完整来源消息 ID；若重复则拒绝，改用 record show 返回的 recordId。', '只允许修改正文及时间，不允许改变本人、聊天、发言人身份或来源消息 ID。', '--revision 要求当前副本版本一致；每次修改 revision 加 1，返回 changeId e_32位十六进制及副本摘要字段。'],
    next: ['wxcc help record changes', 'wxcc help record undo'],
  },
  'record changes': {
    summary: '离线查看副本的修改与撤销记录，包括 before / after。',
    usage: 'record changes --copy COPY [--limit 30] [--json]',
    examples: ['wxcc record changes --copy c_0123456789abcdef0123456789abcdef --limit 30 --json'],
    notes: ['limit 为 1–10000，默认 30。变更记录包含修改前后正文及时间，也包含撤销事件；原文与修改正文都属于私有数据。'],
    next: ['wxcc help record undo'],
  },
  'record undo': {
    summary: '离线撤销一条有效修改，恢复该次修改前的副本内容。',
    usage: 'record undo --copy COPY [--change-id CHANGE] [--revision N] [--json]',
    examples: ['wxcc record undo --copy c_0123456789abcdef0123456789abcdef --revision 1 --json', 'wxcc record undo --copy c_0123456789abcdef0123456789abcdef --change-id e_0123456789abcdef0123456789abcdef --json'],
    notes: ['省略 change-id 时撤销最近尚未撤销的修改。', '指定目标必须是该条 record 当前最新的有效修改；不能跨越同一记录的后续修改。先撤销后续修改再撤销早期修改。', '--revision 可防止基于旧版本撤销；撤销保留历史，并更新副本版本。'],
    next: ['wxcc help record show', 'wxcc help record export'],
  },
  'record export': {
    summary: '将副本当前内容导出为带本地修改标记的新 JSON 文件。',
    usage: 'record export --copy COPY --output NEW_FILE [--no-redact] [--json]',
    examples: ['wxcc record export --copy c_0123456789abcdef0123456789abcdef --output "D:\\Private\\edited-history.json" --json'],
    notes: ['输出文件不能已存在，也不能位于微信数据库目录或程序源码位置；选择新的私有文件名。', '导出 JSON 始终包含 localOnly、edited、revision 等元数据；这些标记会随导出保留。', '默认对导出 JSON 的 ID 脱敏；--no-redact 主动关闭 ID 脱敏。名称与正文不会自动隐藏，导出文件仍含隐私。'],
  },
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
  if (!topic) return { name: 'wxcc', workflow: ['start', 'account', 'ids', 'history', 'record import', 'db list'], defaultRedaction: true, commands: COMMAND_HELP, documentation: ['docs/commands.md', 'docs/examples.md'] };
  if (!Object.hasOwn(COMMAND_HELP, topic)) { const suggestion = suggestName(topic, Object.keys(COMMAND_HELP)); throw new WxError('INVALID_ARGUMENT', `未知帮助主题：${topic}。${suggestion ? `可能是 ${suggestion}；运行 wxcc help ${suggestion}。` : '运行 wxcc help 查看命令。'}`); }
  return { command: topic, ...COMMAND_HELP[topic] };
}
export function renderHelp(topic) {
  const item = helpData(topic);
  if (topic) return [`wxcc ${topic} — ${item.summary}`, '', `用法：wxcc ${item.usage}`, ...(item.examples?.length ? ['', '示例：', ...item.examples.map(value => `  ${value}`)] : []), ...(item.notes?.length ? ['', ...item.notes] : []), ...(item.next?.length ? ['', '下一步：', ...item.next.map(value => `  ${value}`)] : []), '', '详细文档：docs/commands.md；演示：docs/examples.md', '默认 --redact true；--no-redact 仅主动关闭 ID 脱敏，认证密钥始终隐藏。', ''].join('\n');
  return [
    'wxcc — 用命令读取微信聊天、编辑本地副本', '',
    '第一次使用：先打开微信并登录，再依次执行。',
    '  wxcc start                         连接微信',
    '  wxcc account                       核对当前账号',
    '  wxcc ids --keyword "小明"           找人，复制返回的 alias',
    '  wxcc history --to <实际alias> --limit 10',
    '                                     在 messages[].text 中看正文', '',
    '在 PowerShell 中，用 .\\wxcc.cmd 代替上面的 wxcc；<实际alias> 要换成查询结果。',
    '进入 wxcc> 交互模式后，直接输入 start、account 等命令，不加 wxcc 前缀。', '',
    '命令一览：',
    ...Object.entries(COMMAND_HELP).filter(([name]) => !name.includes(' ')).map(([name, value]) => `  ${name.padEnd(18)} ${value.summary}`), '',
    '按任务继续：',
    '  wxcc help record       保存聊天副本，修改、撤销或导出',
    '  wxcc help send         给配置好的目标发送文字',
    '  wxcc help db           查看数据库与解密副本', '',
    '不知道参数怎么填：wxcc help history；wxcc record edit --help。',
    '--json 方便程序读取结果；默认隐藏部分真实 ID，名称和正文仍会显示。',
    '完整命令与参数：docs/commands.md；一步一步跟做：docs/examples.md。',
    '无参数进入 wxcc>；输入 exit 退出。', '',
  ].join('\n');
}
export function errorHint(code) {
  if (/^E_HISTORY_COPY_/.test(code)) return '运行 wxcc help record；用 record list / show 核对副本、记录编号与当前 revision，离线输入须含精确 ID 和唯一聊天。';
  if (/^E_RECORD_/.test(code)) return '运行 wxcc help record edit；记录 ID 重复时使用 recordId，版本冲突先 record show，导出选择新的私有路径。';
  if (/^E_(?:NATIVE_READ_CONFIG|NATIVE_HOST_OFFLINE|START_)/.test(code)) return '先运行 wxcc start；用 wxcc doctor --backend reverse-native 检查版本、主进程和宿主。';
  if (/^E_(?:RECIPIENT_UNKNOWN|RECIPIENT_NOT_LOADED)/.test(code)) return '运行 wxcc ids --keyword "联系人名称"，使用本次返回的 u_ 编号。';
  if (/^E_DB_(?:KEY|CIPHER|AUTO)/.test(code)) return '运行 wxcc help db decrypt；自动密钥失败时使用私有 --key-file，切勿把密钥贴到日志或命令行。';
  if (/^E_DB_(?:NOT_FOUND|ACCOUNT_BINDING|AMBIGUOUS)/.test(code)) return '运行 wxcc db list --data-root "数据库根目录"；必要时加 --account-dir，目录必须对应当前账号。';
  if (/^E_NATIVE_TARGET/.test(code)) return '先 wxcc ids 获取准确编号，再 wxcc configure-target --to <编号>；配置本身不发送。';
  return undefined;
}
