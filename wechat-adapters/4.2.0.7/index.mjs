// Weixin 4.2.0.7 x64: separately verified native coroutine and image result ABI.
// AddMsg interception is unvalidated; no receive-hook agent is exposed.
export default Object.freeze({
  version: '4.2.0.7', architecture: 'x64',
  dllSha256: '9beb1051449e768417d770915646815a5bd1899cc2779f758069820794358ee0',
  profilePath: 'wechat-adapters/4.2.0.7/profile.json',
  readAgent: 'wechat-adapters/4.2.0.7/read-agent.js',
  sendAgent: 'wechat-adapters/4.2.0.7/send-agent.js',
  textEntryRva: '0x570db60', imageEntryRva: '0x2c7ddd0',
  contactEvidence: null, allowLegacyReadScripts: false,
});
