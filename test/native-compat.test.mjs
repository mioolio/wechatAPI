import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { nativeCompatibility, SUPPORTED_NATIVE_VERSIONS, NATIVE_AGENT_PATHS } from '../src/native-compat.mjs';

test('native compatibility selects only fixed version-specific paths and entry RVAs', () => {
  assert.deepEqual(SUPPORTED_NATIVE_VERSIONS, ['4.1.15.13', '4.2.0.7']);
  const old = nativeCompatibility('4.1.15.13');
  const modern = nativeCompatibility('4.2.0.7');
  assert.equal(old.readAgent, 'wechat-adapters/4.1.15.13/read-agent.js');
  assert.equal(old.sendAgent, 'wechat-adapters/4.1.15.13/send-agent.js');
  assert.equal(old.textEntryRva, '0x54b02f0');
  assert.equal(old.imageEntryRva, '0x2ba7a20');
  assert.equal(modern.readAgent, 'wechat-adapters/4.2.0.7/read-agent.js');
  assert.equal(modern.sendAgent, 'wechat-adapters/4.2.0.7/send-agent.js');
  assert.equal(modern.textEntryRva, '0x570db60');
  assert.equal(modern.imageEntryRva, '0x2c7ddd0');
  assert.equal(modern.contactEvidence, null);
  assert.equal(modern.allowLegacyReadScripts, false);
  assert.equal(Object.hasOwn(modern, 'nativeSendValidation'), false);
  assert.equal(Object.hasOwn(modern, 'nativeImageSendValidation'), false);
  for (const value of [undefined, null, 42, {}, '4.2.0.8', '__proto__', 'constructor']) assert.equal(nativeCompatibility(value), undefined);
  assert.throws(() => { modern.readAgent = '../outside.js'; }, TypeError);
  assert.throws(() => { old.contactEvidence.registryGetterRva = '0x1'; }, TypeError);
});

test('each registered version owns its profile, source paths, fingerprints and validation evidence', async () => {
  for (const version of SUPPORTED_NATIVE_VERSIONS) {
    const adapter = nativeCompatibility(version);
    const directory = `wechat-adapters/${version}/`;
    assert.equal(adapter.profilePath, `${directory}profile.json`);
    assert.equal(adapter.readAgent, `${directory}read-agent.js`);
    assert.equal(adapter.sendAgent, `${directory}send-agent.js`);
    const profile = JSON.parse(await readFile(new URL(`../${adapter.profilePath}`, import.meta.url), 'utf8'));
    assert.equal(profile.version, version);
    assert.equal(profile.architecture, adapter.architecture);
    assert.equal(profile.dllSha256, adapter.dllSha256);
    assert.equal(profile.nativeSendValidation.entryRva, adapter.textEntryRva);
    assert.equal(profile.nativeImageSendValidation.entryRva, adapter.imageEntryRva);
    for (const file of [adapter.readAgent, adapter.sendAgent, adapter.receiveAgent].filter(Boolean)) {
      assert.equal(NATIVE_AGENT_PATHS.includes(file), true);
      assert.equal(file.startsWith(directory), true);
      await access(new URL(`../${file}`, import.meta.url));
    }
    for (const file of [adapter.readAgent, adapter.sendAgent]) {
      const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
      assert.equal(source.includes(adapter.dllSha256), true);
      assert.equal(source.includes(`/${version}/Weixin.dll`), true);
    }
  }
  const modern = nativeCompatibility('4.2.0.7');
  const modernProfile = JSON.parse(await readFile(new URL(`../${modern.profilePath}`, import.meta.url), 'utf8'));
  assert.equal(modern.receiveAgent, undefined);
  assert.equal(modernProfile.receiveValidated, false, 'history reads do not validate the AddMsg hook');
  assert.throws(() => NATIVE_AGENT_PATHS.push('wechat-adapters/unknown/agent.js'), TypeError);
});

test('common registry carries no native addresses and old scattered adapter files are absent', async () => {
  const registrySource = await readFile(new URL('../src/native-compat.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(registrySource, /0x[a-f0-9]{5,}/i);
  for (const oldPath of ['agents/read-native.js', 'agents/send-native.js', 'agents/read-native-4.2.js', 'agents/send-native-4.2.js', 'agents/receive.js', 'profiles/4.1.15.13.json', 'profiles/4.2.0.7.json']) {
    await assert.rejects(access(new URL(`../${oldPath}`, import.meta.url)), { code: 'ENOENT' });
  }
});
