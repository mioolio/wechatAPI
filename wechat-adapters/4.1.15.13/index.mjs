// Weixin 4.1.15.13 x64: version-specific entry addresses and source paths.
export default Object.freeze({
  version: '4.1.15.13', architecture: 'x64',
  dllSha256: '10f8e995453e2da46d4f2b5080cd6da1f13cc5147746adc119ceae38cb039de5',
  profilePath: 'wechat-adapters/4.1.15.13/profile.json',
  readAgent: 'wechat-adapters/4.1.15.13/read-agent.js',
  sendAgent: 'wechat-adapters/4.1.15.13/send-agent.js',
  receiveAgent: 'wechat-adapters/4.1.15.13/receive-agent.js',
  textEntryRva: '0x54b02f0', imageEntryRva: '0x2ba7a20',
  contactEvidence: Object.freeze({
    registryGetterRva: '0x36c7b0', storeGetterRva: '0x6dcf80',
    accountVtableRva: '0x8dfe2f8', cacheCenterVtableRva: '0x8f9bf98',
  }),
  allowLegacyReadScripts: true,
});
