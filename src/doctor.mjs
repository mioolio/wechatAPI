import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inspectPe } from './pe.mjs';

export const DEFAULT_INSTALL_PATH = String.raw`C:\Program Files\Tencent\Weixin`;
const executeFile = promisify(execFile);
const VERSION_PATTERN = /^\d+\.\d+\.\d+\.\d+$/;

const WINDOWS_PROCESSES = String.raw`
function Get-WeixinMetadata {
  try {
    $all = @(Get-CimInstance Win32_Process -Filter "Name='Weixin.exe'")
    $ids = @($all | ForEach-Object { [int]$_.ProcessId })
    return @($all | ForEach-Object {
      $entry = $_; $role = 'unknown'; $evidence = 'unknown'
      $parentId = [int]$entry.ParentProcessId
      if ($ids -contains $parentId) { $role = 'child'; $evidence = 'weixin-parent' }
      elseif ($entry.CommandLine -match '(?:^|\s)--(?:type|utility-sub-type)(?:=|\s)') { $role = 'child'; $evidence = 'child-command-flag' }
      else {
        $parent = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $parentId) -ErrorAction SilentlyContinue
        if ($parent -and $parent.Name -ne 'Weixin.exe' -and $parent.CreationDate -le $entry.CreationDate) { $role = 'main'; $evidence = 'verified-parent' }
        else {
          $window = Get-Process -Id $entry.ProcessId -ErrorAction SilentlyContinue
          if ($window -and $window.MainWindowHandle -ne [IntPtr]::Zero) { $role = 'main'; $evidence = 'main-window' }
        }
      }
      [PSCustomObject]@{pid=[int]$entry.ProcessId;parentPid=$parentId;path=$entry.ExecutablePath;role=$role;roleEvidence=$evidence}
    })
  } catch {
    return @(Get-Process -Name Weixin -ErrorAction SilentlyContinue | ForEach-Object {
      [PSCustomObject]@{pid=[int]$_.Id;parentPid=$null;path=$_.Path;role='unknown';roleEvidence='unknown'}
    })
  }
}
`;

function installationError(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = 'WEIXIN_INSTALL_NOT_FOUND';
  return error;
}

function compareVersions(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 4; index += 1) if (a[index] !== b[index]) return b[index] - a[index];
  return 0;
}

async function sha256(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

// Installation paths travel in the environment, never interpolated into script code.
const WINDOWS_QUERY = WINDOWS_PROCESSES + String.raw`
$ErrorActionPreference = 'Stop'
$target = [IO.Path]::GetFullPath($env:WXCC_DOCTOR_EXE)
$fileVersion = (Get-Item -LiteralPath $target).VersionInfo.FileVersion
$processes = @()
$processError = $null
if ($env:WXCC_DOCTOR_PROCESSES -eq '1') {
  try {
    $processes = @(Get-WeixinMetadata | Where-Object {
      $_.path -and [IO.Path]::GetFullPath($_.path) -eq $target
    })
  } catch {
    try {
      $processes = @(Get-Process -Name Weixin -ErrorAction SilentlyContinue | Where-Object {
        $_.Path -and [IO.Path]::GetFullPath($_.Path) -eq $target
      } | ForEach-Object { [PSCustomObject]@{pid=[int]$_.Id;parentPid=$null;path=$_.Path;role='unknown';roleEvidence='unknown'} })
    } catch { $processError = 'Process inspection unavailable: ' + $_.Exception.GetType().Name }
  }
}
[PSCustomObject]@{fileVersion=$fileVersion;processes=$processes;processError=$processError} | ConvertTo-Json -Depth 4 -Compress
`;

const WINDOWS_DISCOVERY = WINDOWS_PROCESSES + String.raw`
$ErrorActionPreference = 'Stop'
$processes = @(Get-WeixinMetadata)
$paths = @()
foreach ($key in @(
 'Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\App Paths\Weixin.exe',
 'Registry::HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\App Paths\Weixin.exe',
 'Registry::HKEY_LOCAL_MACHINE\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\Weixin.exe'
)) {
  $entry = Get-Item -LiteralPath $key -ErrorAction SilentlyContinue
  if ($entry) { foreach ($value in @($entry.GetValue(''), $entry.GetValue('Path'))) { if ($value) { $paths += [PSCustomObject]@{path=$value;source='registry-app-paths'} } } }
}
foreach ($key in @(
 'Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall',
 'Registry::HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\Uninstall',
 'Registry::HKEY_LOCAL_MACHINE\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
)) {
  foreach ($item in @(Get-ChildItem -LiteralPath $key -ErrorAction SilentlyContinue | Get-ItemProperty -ErrorAction SilentlyContinue)) {
    if ($item.DisplayName -match '微信|Weixin|WeChat') {
      foreach ($value in @($item.InstallLocation, $item.DisplayIcon)) { if ($value) { $paths += [PSCustomObject]@{path=$value;source='registry-uninstall'} } }
    }
  }
}
[PSCustomObject]@{processes=$processes;paths=$paths} | ConvertTo-Json -Depth 5 -Compress
`;

async function queryWindows(exePath, inspectProcesses) {
  const { stdout } = await executeFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_QUERY], {
    env: { ...process.env, WXCC_DOCTOR_EXE: exePath, WXCC_DOCTOR_PROCESSES: inspectProcesses ? '1' : '0' },
    encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
}

async function queryDiscovery() {
  const { stdout } = await executeFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_DISCOVERY], {
    encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
}

function candidateDirectory(value) {
  if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/.test(value)) return null;
  let location = value.trim();
  const quoted = /^"([^"]+)"(?:\s*,\s*-?\d+)?$/.exec(location);
  if (quoted) location = quoted[1];
  else location = location.replace(/,\s*-?\d+$/, '');
  const resolved = path.resolve(location);
  return path.basename(resolved).toLowerCase() === 'weixin.exe' ? path.dirname(resolved) : resolved;
}

export function classifyWeixinProcesses(entries = []) {
  const valid = entries.filter(row => row && Number.isSafeInteger(row.pid) && row.pid > 0 && typeof row.path === 'string');
  const pids = new Set(valid.map(row => row.pid));
  return valid.map(row => {
    const parentPid = Number.isSafeInteger(row.parentPid) && row.parentPid >= 0 ? row.parentPid : null;
    const explicit = ['main', 'child', 'unknown'].includes(row.role) ? row.role : 'unknown';
    const role = parentPid !== null && pids.has(parentPid) ? 'child' : explicit;
    return { pid: row.pid, parentPid, path: row.path, role, main: role === 'main', roleEvidence: typeof row.roleEvidence === 'string' ? row.roleEvidence : role === 'child' ? 'weixin-parent' : 'unknown' };
  });
}

/** Locate an installation with static probes; no executable is launched. */
export async function discoverInstallation(options = {}, dependencies = {}) {
  const environment = dependencies.env ?? process.env;
  const platform = dependencies.platform ?? process.platform;
  const check = dependencies.checkInstallationImpl ?? (async directory => { try { await access(path.join(directory, 'Weixin.exe')); return true; } catch { return false; } });
  const candidates = [], diagnostics = [], seen = new Set();
  function add(value, source) {
    const directory = candidateDirectory(value);
    if (!directory) return;
    const key = directory.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key); candidates.push({ path: directory, source });
  }
  if (options.installPath !== undefined) {
    add(options.installPath, 'explicit');
    if (!candidates.length || !await check(candidates[0].path)) throw installationError('Explicit Weixin installation directory is unavailable');
    return { installPath: candidates[0].path, source: 'explicit', candidates: [{ ...candidates[0], available: true }], diagnostics };
  }
  add(environment.WXCC_WEIXIN_PATH, 'environment');
  if (candidates.length && await check(candidates[0].path)) {
    return { installPath: candidates[0].path, source: 'environment', candidates: [{ ...candidates[0], available: true }], diagnostics };
  }
  let metadata = {};
  if (platform === 'win32') {
    try { metadata = await (dependencies.queryDiscoveryImpl ?? queryDiscovery)() ?? {}; }
    catch (cause) { diagnostics.push({ code: 'DISCOVERY_METADATA_UNAVAILABLE', message: `Windows discovery unavailable (${cause.code ?? cause.name})` }); }
  }
  const processes = classifyWeixinProcesses(Array.isArray(metadata.processes) ? metadata.processes : []);
  const running = options.pid === undefined ? processes : processes.filter(row => row.pid === options.pid);
  for (const row of running) add(row.path, 'running-process');
  for (const row of Array.isArray(metadata.paths) ? metadata.paths : []) { if (row) add(typeof row === 'string' ? row : row.path, row.source ?? 'registry'); }
  for (const root of [environment.ProgramFiles, environment['ProgramFiles(x86)']].filter(Boolean)) add(path.join(root, 'Tencent', 'Weixin'), 'program-files');
  add(DEFAULT_INSTALL_PATH, 'default');
  const configPath = options.configPath ?? environment.WXCC_CONFIG ?? (environment.APPDATA ? path.join(environment.APPDATA, 'WXcc', 'config.json') : undefined);
  if (configPath) {
    try {
      const config = await (dependencies.readConfigImpl ?? (async file => { if ((await stat(file)).size > 65536) throw new Error('oversized'); return JSON.parse(await readFile(file, 'utf8')); }))(configPath);
      add(config?.installPath ?? config?.weixinPath, 'user-config');
    } catch (cause) { if (cause.code !== 'ENOENT') diagnostics.push({ code: 'DISCOVERY_CONFIG_UNAVAILABLE', message: 'User installation configuration could not be read' }); }
  }
  const available = [];
  for (const candidate of candidates) { candidate.available = Boolean(await check(candidate.path)); if (candidate.available) available.push(candidate); }
  if (!available.length) throw installationError('Weixin installation was not discovered; set WXCC_WEIXIN_PATH or --install-path');
  if (options.pid === undefined && available[0].source !== 'environment' && available.filter(row => row.source === 'running-process').length > 1) {
    const ambiguity = installationError('Several running Weixin installations were discovered; specify --pid or --install-path');
    ambiguity.code = 'WEIXIN_INSTALL_AMBIGUOUS'; throw ambiguity;
  }
  return { installPath: available[0].path, source: available[0].source, candidates, processes, diagnostics };
}

function summarize(filePath, pe) {
  return { path: filePath, architecture: pe.architecture, machine: pe.machine, bitness: pe.bitness, imports: pe.imports, exportCount: pe.exports.length };
}

/** Static installation diagnostics. Does not execute Weixin or load its DLLs. */
export async function doctor({
  installPath,
  pid,
  configPath,
  includeHashes = true,
  includeExports = true,
  inspectProcesses = true,
} = {}, dependencies = {}) {
  if (installPath !== undefined && (typeof installPath !== 'string' || !installPath.trim())) throw installationError('Weixin installation path must be a nonempty string');
  const explicit = installPath === undefined ? null : candidateDirectory(installPath);
  const discovery = explicit ? { installPath: explicit, source: 'explicit', candidates: [{ path: explicit, source: 'explicit' }], diagnostics: [] } : await discoverInstallation({ pid, configPath }, dependencies);
  const resolvedPath = discovery.installPath;
  let entries;
  try { entries = await readdir(resolvedPath, { withFileTypes: true }); }
  catch (cause) { throw installationError(`Weixin installation directory is unavailable: ${resolvedPath}`, cause); }
  const exePath = path.join(resolvedPath, 'Weixin.exe');
  try { await access(exePath); }
  catch (cause) { throw installationError(`Weixin.exe was not found: ${exePath}`, cause); }
  const diagnostics = [...discovery.diagnostics];
  let windowsMetadata = null;
  const platform = dependencies.platform ?? process.platform;
  if (platform === 'win32') {
    try { windowsMetadata = await (dependencies.queryWindowsImpl ?? queryWindows)(exePath, inspectProcesses); }
    catch (error) { diagnostics.push({ code: 'WINDOWS_METADATA_UNAVAILABLE', message: `Windows metadata inspection failed (${error.code ?? error.name})` }); }
  } else if (inspectProcesses) {
    diagnostics.push({ code: 'PROCESS_INSPECTION_UNAVAILABLE', message: 'Weixin process inspection requires Windows' });
  }
  const versions = entries.filter((entry) => entry.isDirectory() && VERSION_PATTERN.test(entry.name)).map((entry) => entry.name).sort(compareVersions);
  const exeVersion = typeof windowsMetadata?.fileVersion === 'string' ? windowsMetadata.fileVersion.trim() : null;
  const preferred = exeVersion && VERSION_PATTERN.test(exeVersion) ? [exeVersion, ...versions.filter((version) => version !== exeVersion)] : versions;
  let version = null;
  let dllPath = null;
  const directVersion = exeVersion && VERSION_PATTERN.test(exeVersion) ? exeVersion : VERSION_PATTERN.test(path.basename(resolvedPath)) ? path.basename(resolvedPath) : null;
  if (directVersion) { try { await access(path.join(resolvedPath, 'Weixin.dll')); version = directVersion; dllPath = path.join(resolvedPath, 'Weixin.dll'); } catch { /* Versioned subdirectories remain supported. */ } }
  for (const candidate of preferred) {
    if (dllPath) break;
    const candidatePath = path.join(resolvedPath, candidate, 'Weixin.dll');
    try { await access(candidatePath); version = candidate; dllPath = candidatePath; break; } catch { /* Try the next installed version. */ }
  }
  if (!dllPath) throw installationError(`No version directory containing Weixin.dll was found: ${resolvedPath}`);
  if (exeVersion && exeVersion !== version) diagnostics.push({ code: 'VERSION_MISMATCH', message: `Executable version ${exeVersion} differs from selected DLL directory ${version}` });
  const [exePe, dllPe] = await Promise.all([inspectPe(exePath), inspectPe(dllPath)]);
  if (exePe.architecture !== dllPe.architecture) diagnostics.push({ code: 'ARCHITECTURE_MISMATCH', message: 'Weixin.exe and Weixin.dll use different architectures' });
  const processes = classifyWeixinProcesses(Array.isArray(windowsMetadata?.processes) ? windowsMetadata.processes : []);
  if (windowsMetadata?.processError) diagnostics.push({ code: 'PROCESS_INSPECTION_UNAVAILABLE', message: windowsMetadata.processError });
  const result = {
    installPath: resolvedPath, version, architecture: dllPe.architecture,
    exe: summarize(exePath, exePe), dll: summarize(dllPath, dllPe),
    nodeVersion: process.versions.node, processes, running: processes.length > 0,
    processInspectionAvailable: inspectProcesses && platform === 'win32' && !!windowsMetadata && !windowsMetadata.processError,
    discovery: { source: discovery.source, candidateCount: discovery.candidates.length },
    diagnostics,
  };
  if (includeExports) result.exports = dllPe.exports;
  if (includeHashes) {
    const [exeHash, dllHash] = await Promise.all([sha256(exePath), sha256(dllPath)]);
    result.hashes = { exe: exeHash, dll: dllHash };
  }
  return result;
}
