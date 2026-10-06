import { recipientAlias } from './recipient-registry.mjs';

const REDACTED = '[REDACTED]';
const IDENTITY_FIELDS = new Set(['alias', 'username', 'wxid', 'chatid', 'sessionid', 'userid', 'accountid', 'recipientid', 'senderid', 'ownerid', 'senderusername', 'recipientusername', 'talker', 'talkerid', 'chat', 'recipient', 'sender', 'self', 'to', 'from']);
const NAME_FIELDS = new Set(['name', 'displayname', 'nickname', 'remark', 'remarkname', 'contactname', 'chatname', 'sendername', 'recipientname']);
const SECRET_FIELDS = new Set(['authorization', 'proxyauthorization', 'cookie', 'setcookie', 'headers', 'requestheaders', 'responseheaders', 'credentials', 'credential', 'key', 'salt', 'apikey', 'dbkey', 'wechatdbkey', 'privatekey', 'keymaterial', 'password', 'passwd', 'secret', 'token']);
const keyName = key => String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
function secretField(key) {
  const normalized = keyName(key);
  return SECRET_FIELDS.has(normalized) || /(?:token|secret|password|apikey|dbkey|privatekey)$/.test(normalized);
}
/** Human-readable partial identifier, distinct from the resolvable stable alias. */
export function maskIdentifier(id) {
  if (typeof id !== 'string' || !id) return '[ID]';
  const prefix = id.startsWith('wxid_') ? 'wxid_' : '';
  const body = Array.from(id.slice(prefix.length));
  return body.length > 6 ? `${prefix}${body.slice(0, 3).join('')}…${body.slice(-3).join('')}` : `${prefix}…`;
}
function configuredStrings(values) {
  return [...new Set((values ?? []).filter(value => typeof value === 'string' && value.length > 0))].sort((a, b) => b.length - a.length);
}
function idAlias(id) {
  try { return recipientAlias(id); }
  catch { return '[ID]'; }
}
/**
 * Sanitizes display data only; it never changes the actual RPC input or grants send permission.
 * enabled:false exposes IDs intentionally. Credentials remain hidden in either mode.
 */
export function createPrivacyFormatter({ enabled = true, registry, secrets = [], identifiers = [], knownIdentifiers = [] } = {}) {
  const secretValues = configuredStrings(secrets);
  function identityValues() {
    const registered = typeof registry?.list === 'function' ? registry.list({ includeIds: true }).map(record => record.id) : [];
    const supplied = [...identifiers, ...knownIdentifiers].map(record => typeof record === 'string' ? record : record?.id);
    return configuredStrings([...registered, ...supplied]).filter(id => !/^[ud]_[a-f0-9]{16}$/.test(id));
  }
  function hideSecrets(value) {
    let output = value;
    for (const secret of secretValues) output = output.replaceAll(secret, REDACTED);
    output = output.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, (_match, scheme) => `${scheme} ${REDACTED}`);
    output = output.replace(/((?<![\w-])["']?(?:authorization|proxy-authorization|x-wxcc-token|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|cookie|set-cookie)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi, (_match, prefix) => `${prefix}${REDACTED}`);
    return output;
  }
  function textWithIds(value, ids) {
    let output = hideSecrets(value);
    if (enabled === false) return output;
    output = output.replace(/(\b[A-Za-z]:[\\/]Users[\\/])[^\\/\r\n"'<>|]+/gi, (_match, prefix) => `${prefix}[USER]`);
    for (const id of ids) {
      if (/^\d+$/.test(id)) output = output.replace(new RegExp(`(?<![A-Za-z0-9_])${id}(?![A-Za-z0-9_])`, 'g'), idAlias(id));
      else output = output.replaceAll(id, idAlias(id));
    }
    // A deliberate partial display such as wxid_abc…xyz must not become an alias for a truncated ID.
    return output.replace(/(?<![A-Za-z0-9_])wxid_[A-Za-z0-9_-]+(?![A-Za-z0-9_*…])/g, idAlias)
      .replace(/\b\d{5,}@chatroom\b/g, idAlias);
  }
  function redactText(value) { return textWithIds(String(value), identityValues()); }
  function redact(value) {
    const ids = identityValues(), active = new WeakSet();
    function visit(item, field = '') {
      if (secretField(field)) return item === undefined ? undefined : REDACTED;
      const normalized = keyName(field);
      if (typeof item === 'string') {
        const secretSafe = hideSecrets(item);
        if (NAME_FIELDS.has(normalized)) return secretSafe;
        if (secretSafe !== item) return textWithIds(secretSafe, ids);
        if (/^\d+$/.test(item) && ['id', 'messageid', 'msgid', 'serverid', 'serveridraw', 'localid', 'clientmsgid', 'requestid'].includes(normalized)) return hideSecrets(item);
        if (normalized === 'maskedid') return hideSecrets(/^(?:wxid_)?(?:.{3}….{3}|…)$/u.test(item) ? item : maskIdentifier(item));
        if (enabled !== false && IDENTITY_FIELDS.has(normalized) && item && !/^[ud]_[a-f0-9]{16}$/.test(item)) return maskIdentifier(item);
        return textWithIds(item, ids);
      }
      if (typeof item === 'bigint') return enabled !== false && IDENTITY_FIELDS.has(normalized) ? maskIdentifier(String(item)) : String(item);
      if (typeof item === 'number') return enabled !== false && IDENTITY_FIELDS.has(normalized) ? maskIdentifier(String(item)) : item;
      if (item === null || typeof item !== 'object') return item;
      if (active.has(item)) return '[Circular]';
      if (item instanceof Date) return Number.isFinite(item.getTime()) ? item.toISOString() : null;
      if (ArrayBuffer.isView(item) || item instanceof ArrayBuffer) return `[Binary ${item.byteLength} bytes]`;
      active.add(item);
      try {
        if (Array.isArray(item)) return item.map(value => visit(value, field));
        if (item instanceof Map) return [...item.entries()].map(([key, value]) => [visit(key), visit(value)]);
        if (item instanceof Set) return [...item.values()].map(value => visit(value));
        const result = {};
        const descriptors = Object.getOwnPropertyDescriptors(item);
        if (item instanceof Error) {
          result.name = visit(item.name, 'name');
          result.message = visit(item.message, 'message');
        }
        for (const [key, descriptor] of Object.entries(descriptors)) {
          if (!descriptor.enumerable && !(item instanceof Error && ['message', 'stack', 'cause'].includes(key))) continue;
          const safeKey = ids.includes(key) || key.includes('wxid_') ? textWithIds(key, ids) : hideSecrets(key);
          // Defining the property directly prevents untrusted __proto__ keys from changing the output prototype.
          Object.defineProperty(result, safeKey, { value: 'value' in descriptor ? visit(descriptor.value, key) : '[Unavailable]', enumerable: true, configurable: true, writable: true });
        }
        return result;
      } finally { active.delete(item); }
    }
    return visit(value);
  }
  function format(value, { pretty = false } = {}) { return JSON.stringify(redact(value), null, pretty ? 2 : undefined); }
  return { redact, redactText, format };
}
export function redact(value, options = {}) { return createPrivacyFormatter(options).redact(value); }
export function redactText(value, options = {}) { return createPrivacyFormatter(options).redactText(value); }
export function format(value, { pretty = false, ...options } = {}) { return createPrivacyFormatter(options).format(value, { pretty }); }
