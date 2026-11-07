#!/usr/bin/env node
/**
 * setup.mjs - install the wb-proxy plugin into a DSH profile.
 *
 * What it does, in order (each step is skippable):
 *   1. deploy a runtime directory (default %USERPROFILE%\.dsh\wb-proxy):
 *      copies src/ bin/ config/, writes config.json, creates logs/
 *   2. write the DSH provider patch (llm-deepseek block -> local proxy)
 *   3. register DEEPSEEK_PROXY_KEY in ~/.dsh/.credentials.yaml refs
 *   4. register the logon + 1-minute watchdog scheduled task WbDeepseekProxy
 *
 * Usage:
 *   node setup.mjs                 install / repair with defaults
 *   node setup.mjs --dry-run       print what would be written, touch nothing
 *   node setup.mjs --port 8787 --mode wbipc
 *   node setup.mjs --no-autostart --no-patch
 *
 * Every file it rewrites is first copied to <file>.bak-wbplugin-<timestamp>.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes('--' + name);
const value = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const PROFILE = value('profile', 'desktop');
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const PROFILE_DIR = join(DSH_HOME, 'profiles', PROFILE);
const PATCH_FILE = join(PROFILE_DIR, 'cordis.patch.yml');
const CRED_FILE = join(DSH_HOME, '.credentials.yaml');
const RUNTIME_DIR = resolve(value('runtime', join(DSH_HOME, 'wb-proxy')));
const PORT = Number(value('port', '8787'));
const HOST = value('host', '127.0.0.1');
const MODE = value('mode', 'wbipc');
const CLIENT_TOKEN = value('token', 'local-proxy');
const DRY = flag('dry-run');
const stamp = new Date().toISOString().replace(/[-:T.]/gu, '').slice(0, 14);
let done = 0;
let total = 0;

function step(name, detail) {
  total += 1;
  done += 1;
  console.log('  OK   ' + name + '  ' + detail);
}
function skip(name, why) {
  total += 1;
  console.log('  --   ' + name + '  ' + why);
}

function backup(file) {
  if (!existsSync(file)) return null;
  const target = file + '.bak-wbplugin-' + stamp;
  copyFileSync(file, target);
  return target;
}

function writeText(file, content) {
  if (DRY) {
    console.log('\n----- ' + file + ' -----\n' + content + '\n----- end -----');
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
}

console.log('wb-proxy plugin setup  (dry-run=' + DRY + ')');
console.log('  dsh home    ' + DSH_HOME);
console.log('  runtime     ' + RUNTIME_DIR);
console.log('  endpoint    http://' + HOST + ':' + PORT + '\n');

// ---- 1) runtime directory ------------------------------------------------
if (DRY) {
  skip('runtime', '(would deploy to ' + RUNTIME_DIR + ')');
} else {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  for (const dir of ['src', 'bin', 'config']) {
    cpSync(join(HERE, dir), join(RUNTIME_DIR, dir), { recursive: true, force: true });
  }
  mkdirSync(join(RUNTIME_DIR, 'logs'), { recursive: true });
  cpSync(join(HERE, 'config', 'config.credits.json'), join(RUNTIME_DIR, 'config.json'), { force: true });
  if (!existsSync(join(RUNTIME_DIR, 'package.json'))) {
    cpSync(join(HERE, 'package.json'), join(RUNTIME_DIR, 'package.json'));
  }
  step('runtime', RUNTIME_DIR);
}

// ---- 2) config.json: host / port / token / mode ---------------------------
const configPath = join(RUNTIME_DIR, 'config.json');
if (!DRY && existsSync(configPath)) {
  const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
  cfg.listen = { host: HOST, port: PORT };
  cfg.clientToken = CLIENT_TOKEN;
  cfg.upstream.mode = MODE;
  cfg.log = Object.assign({ dir: './logs', enabled: true }, cfg.log || {});
  writeText(configPath, JSON.stringify(cfg, null, 2) + '\n');
  step('config.json', 'mode=' + MODE + ' port=' + PORT);
}

// ---- 3) cordis.patch.yml --------------------------------------------------
if (flag('no-patch')) {
  skip('cordis.patch.yml', 'skipped (--no-patch)');
} else {
  const block = [
    '- id: llm-deepseek',
    '  name: "@deepseek-ai/dsh-llm-deepseek-api-key"',
    '  config:',
    '    baseURL: http://' + HOST + ':' + PORT,
    '    apiKeyEnv: DEEPSEEK_PROXY_KEY',
    '    reasoningEffort: high',
    '    models:',
    '      - id: deepseek-flash',
    '        name: DeepSeek-V4.1-Flash (WB proxy)',
    '        contextWindow: 1048576',
    '        inputModalities: [ text, image ]',
    '        systemPromptUpdate: in-history',
    '        toolUpdate: addition-only',
    '      - id: deepseek-v4-pro',
    '        name: DeepSeek-V4-Pro (WB proxy)',
    '        contextWindow: 1048576',
    '        inputModalities: [ text ]',
    ''
  ].join('\n');

  if (!existsSync(PATCH_FILE)) {
    writeText(PATCH_FILE, block);
    step('cordis.patch.yml', 'created');
  } else {
    const current = readFileSync(PATCH_FILE, 'utf8');
    if (/^\s*-?\s*id:\s*llm-deepseek\s*$/mu.test(current)) {
      skip('cordis.patch.yml', 'llm-deepseek block already present, left untouched');
    } else {
      backup(PATCH_FILE);
      writeText(PATCH_FILE, current.trimEnd() + '\n\n' + block);
      step('cordis.patch.yml', 'appended llm-deepseek block');
    }
  }
}

// ---- 4) credentials refs --------------------------------------------------
if (flag('no-patch')) {
  skip('.credentials.yaml', 'skipped (--no-patch)');
} else {
  const line = '  DEEPSEEK_PROXY_KEY: ' + CLIENT_TOKEN;
  if (!existsSync(CRED_FILE)) {
    writeText(CRED_FILE, 'version: 1\nrefs:\n' + line + '\nrecords: {}\n');
    step('.credentials.yaml', 'created');
  } else {
    const current = readFileSync(CRED_FILE, 'utf8');
    if (/DEEPSEEK_PROXY_KEY:/u.test(current)) {
      const next = current.replace(/^(\s*)DEEPSEEK_PROXY_KEY:.*$/mu, line);
      if (next === current) {
        skip('.credentials.yaml', 'ref already present');
      } else {
        backup(CRED_FILE);
        writeText(CRED_FILE, next);
        step('.credentials.yaml', 'ref updated');
      }
    } else if (/^refs:\s*$/mu.test(current)) {
      backup(CRED_FILE);
      writeText(CRED_FILE, current.replace(/^refs:\s*$/mu, 'refs:\n' + line));
      step('.credentials.yaml', 'ref inserted');
    } else {
      backup(CRED_FILE);
      writeText(CRED_FILE, current.trimEnd() + '\nrefs:\n' + line + '\n');
      step('.credentials.yaml', 'refs section appended');
    }
  }
}

// ---- 5) scheduled task ----------------------------------------------------
if (flag('no-autostart') || process.platform !== 'win32') {
  skip('autostart', flag('no-autostart') ? 'skipped (--no-autostart)' : 'not win32');
} else {
  const startScript = join(RUNTIME_DIR, 'bin', 'start.ps1');
  // The script path is handed over as $env:WB_START_SCRIPT instead of being spliced into
  // PowerShell source, so a quote or ';' in the install path cannot become a command.
  const ps = [
    "$ErrorActionPreference='Stop'",
    '$path = $env:WB_START_SCRIPT',
    'if (-not $path) { throw "WB_START_SCRIPT is not set" }',
    "$a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \"' + $path + '\"')",
    '$t1 = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME',
    '$t2 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650)',
    '$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)',
    "Register-ScheduledTask -TaskName 'WbDeepseekProxy' -Action $a -Trigger @($t1,$t2) -Settings $s -Force | Out-Null",
    "Start-ScheduledTask -TaskName 'WbDeepseekProxy'"
  ].join('; ');

  if (DRY) {
    console.log('\n----- scheduled task (dry-run, not registered) -----\n' + ps + '\n');
    console.log('  WB_START_SCRIPT = ' + startScript + '\n');
    skip('autostart', 'dry-run');
  } else {
    const result = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
      encoding: 'utf8',
      env: { ...process.env, WB_START_SCRIPT: startScript },
    });
    if (result.status === 0) {
      step('autostart', 'WbDeepseekProxy registered and started');
    } else {
      skip('autostart', String(result.stderr || 'register failed').trim().split('\n')[0]);
    }
  }
}

console.log('\n' + done + '/' + total + ' step(s) applied.');
console.log('next:    http://' + HOST + ':' + PORT + '/healthz   (or bin/status.ps1)');
console.log('DSH:     restart DSH, the model picker should show "DeepSeek-V4.1-Flash (WB proxy)"');
console.log('rollback: bin/uninstall-autostart.ps1 + restore *.bak-wbplugin-' + stamp);
