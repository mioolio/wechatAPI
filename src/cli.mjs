import { createInterface } from 'node:readline';
import { createPrivacyFormatter } from './privacy.mjs';
import { RecipientRegistry } from './recipient-registry.mjs';
import { renderHelp, helpData, suggestName, errorHint } from './help.mjs';

export class CliError extends Error {
  constructor(message, code = 'INVALID_ARGUMENT') {
    super(message);
    this.name = 'CliError';
    this.code = code;
  }
}

const commands = new Set(['start', 'configure-target', 'db', 'doctor', 'status', 'inspect', 'account', 'accounts', 'ids', 'list', 'contacts', 'history', 'watch', 'probe', 'send', 'send-status', 'help', 'exit', 'quit']);
const globalFlags = new Set(['json', 'verbose']);
const globalValues = new Set(['pid', 'profile', 'self', 'backend', 'url', 'token-file', 'root', 'account-dir', 'key-file', 'interval', 'redact', 'install-path', 'data-root', 'timeout']);
const localValues = new Set(['to', 'session', 'request-id', 'text', 'limit', 'seconds', 'keyword', 'database', 'input', 'output', 'key-mode']);

export const HELP = renderHelp();

function positiveInteger(value, name) {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
    throw new CliError(`${name} 必须是正整数。`);
  }
  return Number(value);
}

function nonempty(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new CliError(`${name} 不能为空。`);
  return value;
}

/** Parse only; no client is created and no messages are sent. */
export function parseArgs(argv) {
  const options = {};
  const values = {};
  const positionals = [];
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (token === '--help' || token === '-h') {
      help = true;
      continue;
    }
    if (!token.startsWith('-')) {
      positionals.push(token);
      continue;
    }
    if (!token.startsWith('--')) throw new CliError(`未知选项：${token}`);
    const equal = token.indexOf('=');
    const key = token.slice(2, equal === -1 ? undefined : equal);
    if (key === 'no-redact' || key === 'pick') {
      if (equal !== -1) throw new CliError(`--${key} 不接受值。`);
      const target = key === 'pick' ? values : options;
      const property = key === 'pick' ? 'pick' : 'redact';
      if (Object.hasOwn(target, property)) throw new CliError(`--${key} 重复指定。`);
      target[property] = key === 'pick';
      continue;
    }
    if (globalFlags.has(key)) {
      if (equal !== -1) throw new CliError(`--${key} 不接受值。`);
      options[key] = true;
      continue;
    }
    if (!globalValues.has(key) && !localValues.has(key)) {
      const suggestion = suggestName(key, [...globalValues, ...localValues, ...globalFlags, 'no-redact', 'pick', 'help']);
      throw new CliError(`未知选项：--${key}${suggestion ? `；可能是 --${suggestion}。` : '。运行 wxcc help 查看选项。'}`);
    }
    let value;
    if (equal !== -1) value = token.slice(equal + 1);
    else {
      value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new CliError(`--${key} 缺少值。`);
      index += 1;
    }
    const target = globalValues.has(key) ? options : values;
    if (Object.hasOwn(target, key)) throw new CliError(`--${key} 重复指定。`);
    if (key === 'redact') {
      if (!['true', 'false'].includes(value)) throw new CliError('--redact 必须是 true 或 false。');
      target[key] = value === 'true';
    } else target[key] = ['pid', 'limit', 'seconds', 'interval', 'timeout'].includes(key) ? positiveInteger(value, `--${key}`) : nonempty(value, `--${key}`);
  }

  const requestedCommand = positionals.shift() ?? null;
  const command = help ? 'help' : requestedCommand;
  if (command !== null && !commands.has(command)) {
    const suggestion = suggestName(command, commands);
    throw new CliError(`未知命令：${command}${suggestion ? `；可能是 ${suggestion}。运行 wxcc help ${suggestion}。` : '。运行 wxcc help 查看命令。'}`);
  }
  if (command === 'help') {
    const topic = (help && requestedCommand !== 'help' && requestedCommand ? [requestedCommand, ...(requestedCommand === 'db' ? positionals.slice(0, 1) : [])] : positionals).join(' ');
    helpData(topic || undefined);
    return { command, options, args: topic ? { topic } : {} };
  }
  if (command === null) {
    if (Object.keys(values).length) throw new CliError('请先指定命令。');
    return { command, options, args: {} };
  }
  const allowed = ['list', 'contacts', 'ids'].includes(command) ? ['keyword'] : command === 'history' ? ['to', 'limit'] : command === 'watch' ? ['to'] : command === 'probe' ? ['to', 'seconds'] : command === 'send' ? ['to', 'session', 'request-id', 'text', 'pick'] : command === 'send-status' ? ['request-id'] : command === 'configure-target' ? ['to'] : command === 'db' ? ['database', 'input', 'output', 'key-mode'] : [];
  for (const key of Object.keys(values)) {
    if (!allowed.includes(key)) throw new CliError(`${command} 不支持 --${key}。`);
  }
  const args = { ...values };
  if (command === 'db') {
    args.action = positionals.shift() ?? 'status';
    if (!['list', 'status', 'decrypt'].includes(args.action)) {
      const suggestion = suggestName(args.action, ['list', 'status', 'decrypt']);
      throw new CliError(`未知 db 子命令：${args.action}。${suggestion ? `可能是 ${suggestion}。` : ''}运行 wxcc help db。`);
    }
    if (args.action === 'decrypt') {
      if ([args.database !== undefined, args.input !== undefined].filter(Boolean).length !== 1) throw new CliError('db decrypt 必须且只能指定 --database <编号> 或 --input <文件>。');
      if (!args.output) throw new CliError('db decrypt 需要 --output <新的私有副本路径>。');
      if (args.input && !options['key-file']) throw new CliError('离线 db decrypt --input 需要 --key-file <私有密钥文件>。');
      if (args['key-mode'] && !['raw', 'passphrase', 'auto'].includes(args['key-mode'])) throw new CliError('--key-mode 必须是 raw、passphrase 或 auto。');
      if (args['key-mode'] && !options['key-file']) throw new CliError('--key-mode 只用于显式 --key-file。');
      if (!options['key-file'] && options.timeout !== undefined && (options.timeout < 100 || options.timeout > 30000)) throw new CliError('自动数据库密钥扫描 --timeout 范围为 100–30000 毫秒。');
      if (args.database && !/^d_[a-f0-9]{16}$/.test(args.database)) throw new CliError('--database 必须是 db list 返回的 d_ 编号。');
      if (args['key-mode']) { args.keyMode = args['key-mode']; delete args['key-mode']; }
    } else if (Object.keys(values).length) throw new CliError(`db ${args.action} 不接受解密参数。`);
  }
  if (command === 'configure-target') {
    if (args.to === undefined && positionals.length) args.to = nonempty(positionals.shift(), '用户编号');
    if (args.to === undefined) throw new CliError('configure-target 需要 --to <已登记用户编号或精确 ID>。');
  }
  if (command === 'send-status') {
    if (!args['request-id']) throw new CliError('send-status 需要 --request-id <请求 ID>。');
    args.requestId = args['request-id'];
    delete args['request-id'];
  }
  if (['history', 'watch', 'probe', 'send'].includes(command)) {
    if (args.to === undefined && !args.pick && (command !== 'send' || args.session === undefined) && positionals.length) args.to = nonempty(positionals.shift(), '会话 ID');
    if (command === 'send' && args.text === undefined && positionals.length) args.text = nonempty(positionals.shift(), '正文');
    if (command === 'history' && args.to === undefined) throw new CliError('history 需要明确指定 --to <id>。');
    if (command === 'send' && [args.to !== undefined, args.session !== undefined, args.pick === true].filter(Boolean).length !== 1) throw new CliError('send 必须且只能指定 --to、--session 或 --pick 之一。');
    if (command === 'send' && args.text === undefined) throw new CliError('send 需要明确指定 --text <正文>。');
    if (command === 'history') args.limit ??= 30;
    if (command === 'probe') args.seconds ??= 30;
    if (command === 'send' && args['request-id'] !== undefined) { args.requestId = args['request-id']; delete args['request-id']; }
  }
  if (positionals.length) throw new CliError(`多余参数：${positionals.join(' ')}。含空格的正文请加引号。`);
  return { command, options, args };
}

/** A small REPL lexer; Windows path separators stay literal. */
export function tokenize(line) {
  const tokens = [];
  let token = '';
  let quote = null;
  let started = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (quote) {
      if (char === quote) quote = null;
      else if (quote === '"' && char === '\\' && (next === '"' || next === '\\')) {
        token += next;
        index += 1;
      } else token += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) tokens.push(token);
      token = '';
      started = false;
    } else if (char === '\\' && next !== undefined && /[\s'"\\]/.test(next)) {
      token += next;
      index += 1;
      started = true;
    } else {
      token += char;
      started = true;
    }
  }
  if (quote) throw new CliError('引号未闭合。');
  if (started) tokens.push(token);
  return tokens;
}

const stringify = (value, pretty = false) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? String(item) : item, pretty ? 2 : undefined);

function reportError(error, stream, json, privacy = createPrivacyFormatter()) {
  const code = typeof error?.code === 'string' ? error.code : 'ERROR';
  const message = error instanceof Error ? error.message : String(error);
  const hint = errorHint(code);
  stream.write(json ? `${privacy.format({ error: { code, message, ...(hint ? { hint } : {}) } })}\n` : `错误 [${code}]：${privacy.redactText(message)}\n${hint ? `建议：${hint}\n` : ''}`);
}

async function defaultCreateService(options) {
  const { createService } = await import('./service.mjs');
  return createService(options);
}

/** Injectable streams and service factory allow tests without touching Weixin. */
export async function runCli(argv = [], dependencies = {}) {
  const input = dependencies.input ?? process.stdin;
  const output = dependencies.output ?? process.stdout;
  const errorOutput = dependencies.error ?? process.stderr;
  const factory = dependencies.createService ?? defaultCreateService;
  const interruptSource = dependencies.interruptSource ?? process;
  const terminal = dependencies.terminal ?? Boolean(input.isTTY && errorOutput.isTTY);
  let initial;
  try {
    initial = parseArgs(argv);
  } catch (error) {
    reportError(error, errorOutput, argv.includes('--json'));
    return 2;
  }
  if (initial.command === 'help') {
    output.write(initial.options.json ? `${stringify(helpData(initial.args.topic), true)}\n` : renderHelp(initial.args.topic));
    return 0;
  }

  let service;
  let serviceKey;
  let activeWatch;
  let repl;
  let replLines;
  let picker;
  let currentPrivacy = createPrivacyFormatter({ enabled: !argv.includes('--no-redact') && !argv.includes('--redact=false') });
  let exitCode = 0;
  const baseOptions = initial.options;
  const registry = dependencies.registry ?? new RecipientRegistry();
  const interrupt = () => {
    if (activeWatch) activeWatch.abort();
    else if (picker) picker.close();
    else if (repl) repl.close();
  };
  interruptSource.on('SIGINT', interrupt);
  const externalAbort = () => {
    activeWatch?.abort(dependencies.signal?.reason);
    repl?.close();
  };
  dependencies.signal?.addEventListener('abort', externalAbort);

  async function getService(options) {
    const key = stringify(options);
    if (service && key !== serviceKey) {
      await service.close();
      service = undefined;
    }
    if (!service) {
      service = await factory(options);
      serviceKey = key;
    }
    return service;
  }

  async function execute(parsed) {
    const options = { ...baseOptions, ...parsed.options };
    if (['start', 'configure-target', 'db', 'account', 'accounts', 'history', 'send', 'ids', 'send-status'].includes(parsed.command) && options.backend === undefined) options.backend = 'reverse-native';
    if (parsed.command === 'help') {
      output.write(options.json ? `${stringify(helpData(parsed.args.topic), true)}\n` : renderHelp(parsed.args.topic));
      return;
    }
    await registry.read();
    currentPrivacy = createPrivacyFormatter({ enabled: options.redact !== false, registry, identifiers: [options.self, parsed.args.to, parsed.args.session].filter(Boolean) });
    if (parsed.command === 'exit' || parsed.command === 'quit') {
      if (!repl) throw new CliError('exit 和 quit 仅用于 REPL。');
      repl.close();
      return;
    }
    const client = await getService(options);
    const method = parsed.command === 'status' ? 'doctor' : parsed.command === 'send-status' ? 'sendStatus' : parsed.command === 'configure-target' ? 'configureTarget' : parsed.command;
    if (typeof client?.[method] !== 'function') {
      throw new CliError(`${parsed.command} 能力未实现。`, 'UNSUPPORTED');
    }
    let result;
    switch (parsed.command) {
      case 'start': result = await client.start(parsed.args); break;
      case 'configure-target': result = await client.configureTarget(parsed.args); break;
      case 'db': result = await client.db(parsed.args); break;
      case 'doctor':
      case 'status': result = await client.doctor(); break;
      case 'inspect': result = await client.inspect(); break;
      case 'account': result = await client.account(parsed.args); break;
      case 'accounts': result = await client.accounts(parsed.args); break;
      case 'ids': result = await client.ids(parsed.args); break;
      case 'send-status': result = await client.sendStatus(parsed.args); break;
      case 'list': result = await client.list(parsed.args); break;
      case 'contacts': result = await client.contacts(parsed.args); break;
      case 'history': result = await client.history(parsed.args); break;
      case 'send': {
        let args = parsed.args;
        if (args.pick) {
          const found = await client.ids({});
          output.write(`${currentPrivacy.format(found, { pretty: !options.json })}\n`);
          const users = found?.users;
          if (!Array.isArray(users) || !users.length) throw new CliError('当前没有可选择的用户。', 'E_RECIPIENT_EMPTY');
          errorOutput.write('请输入用户编号，或输入 cancel 取消：');
          const selection = repl ? undefined : createInterface({ input, terminal: false });
          picker = selection;
          let next;
          try { next = await (replLines ?? selection[Symbol.asyncIterator]()).next(); }
          finally { selection?.close(); picker = undefined; }
          const alias = String(next.value ?? '').trim();
          if (next.done || !alias || alias.toLowerCase() === 'cancel') {
            result = { status: 'cancelled', nativeSendCount: 0 };
            break;
          }
          const chosen = users.find(user => user.alias === alias);
          if (!chosen) throw new CliError('编号不在本次获取的列表中；没有发送消息。', 'E_RECIPIENT_ALIAS');
          if (chosen.canSend !== true) throw new CliError('所选用户不在当前已验证的发送授权范围。', 'E_CHAT_SCOPE');
          args = { ...args, to: chosen.alias };
          delete args.pick;
        }
        result = await client.send(args);
        break;
      }
      case 'watch':
      case 'probe': {
        const controller = new AbortController();
        activeWatch = controller;
        const relayAbort = () => controller.abort(dependencies.signal?.reason);
        dependencies.signal?.addEventListener('abort', relayAbort);
        if (dependencies.signal?.aborted) relayAbort();
        try {
          await client[parsed.command]({
            ...parsed.args,
            signal: controller.signal,
            onEvent: event => {
              if (!controller.signal.aborted) output.write(`${currentPrivacy.format(event)}\n`);
            },
          });
        } catch (error) {
          if (!(controller.signal.aborted && (error?.name === 'AbortError' || ['ABORT_ERR', 'E_ABORTED'].includes(error?.code)))) throw error;
        } finally {
          dependencies.signal?.removeEventListener('abort', relayAbort);
          activeWatch = undefined;
        }
        return;
      }
      default: throw new CliError(`未知命令：${parsed.command}`);
    }
    await registry.read();
    currentPrivacy = createPrivacyFormatter({ enabled: options.redact !== false, registry, identifiers: [options.self, parsed.args.to, parsed.args.session].filter(Boolean) });
    if (result !== undefined) output.write(`${typeof result === 'string' && !options.json ? currentPrivacy.redactText(result) : currentPrivacy.format(result, { pretty: !options.json })}\n`);
  }

  try {
    if (initial.command !== null) await execute(initial);
    else {
      repl = createInterface({ input, output: errorOutput, terminal, prompt: 'wxcc> ' });
      repl.on('SIGINT', interrupt);
      if (terminal) {
        errorOutput.write('wxcc REPL：help 查看命令，exit 退出。\n');
        repl.prompt();
      }
      replLines = repl[Symbol.asyncIterator]();
      for (let next = await replLines.next(); !next.done; next = await replLines.next()) {
        const line = next.value;
        try {
          const tokens = tokenize(line);
          if (tokens.length) {
            const parsed = parseArgs(tokens);
            if (parsed.command === null) throw new CliError('请指定命令。');
            await execute(parsed);
            if (parsed.command === 'exit' || parsed.command === 'quit') break;
          }
        } catch (error) {
          reportError(error, errorOutput, baseOptions.json || /(?:^|\s)--json(?:\s|$)/.test(line), currentPrivacy);
        }
        if (terminal && !repl.closed) repl.prompt();
      }
    }
  } catch (error) {
    reportError(error, errorOutput, initial.options.json, currentPrivacy);
    exitCode = error?.code === 'INVALID_ARGUMENT' ? 2 : 1;
  } finally {
    dependencies.signal?.removeEventListener('abort', externalAbort);
    interruptSource.off('SIGINT', interrupt);
    repl?.close();
    if (service) {
      try { await service.close(); }
      catch (error) {
        reportError(error, errorOutput, initial.options.json, currentPrivacy);
        exitCode = 1;
      }
    }
  }
  return exitCode;
}
