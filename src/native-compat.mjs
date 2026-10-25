// Explicit imports keep source selection closed: profiles cannot redirect agents
// or supply native entry addresses. Version-specific details live in adapters.
import legacy from '../wechat-adapters/4.1.15.13/index.mjs';
import modern from '../wechat-adapters/4.2.0.7/index.mjs';

const registry = Object.freeze(Object.fromEntries([legacy, modern].map(adapter => [adapter.version, adapter])));
export const SUPPORTED_NATIVE_VERSIONS = Object.freeze(Object.keys(registry));
export const NATIVE_AGENT_PATHS = Object.freeze(Object.values(registry).flatMap(adapter =>
  [adapter.readAgent, adapter.sendAgent, adapter.receiveAgent].filter(Boolean)));

/** Fixed version metadata; this does not authorize a target or prove a new send. */
export function nativeCompatibility(version) {
  return typeof version === 'string' && Object.hasOwn(registry, version) ? registry[version] : undefined;
}
