#!/usr/bin/env node
/**
 * pack.mjs - build the distributable zip of this plugin.
 *
 * Output: <out>/dsh-plugin-wb-proxy-<version>.zip   (default <out> = Desktop)
 *
 * Excluded: logs/ node_modules/ __pycache__/ *.pyc *.log *.bak-* and (unless
 * --with-python) any py-packages/ or relay/ directory.
 *
 * Usage:
 *   node scripts/pack.mjs                          # -> Desktop
 *   node scripts/pack.mjs --out D:\dist
 *   node scripts/pack.mjs --with-python            # bundle the codebuddy_proxy relay
 *   node scripts/pack.mjs --verify                 # unzip to temp and run the smoke test
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, cpSync, rmSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const outIndex = process.argv.indexOf('--out');
const OUT = resolve(outIndex >= 0 ? process.argv[outIndex + 1] : join(homedir(), 'Desktop'));
const WITH_PYTHON = process.argv.includes('--with-python');
const VERIFY = process.argv.includes('--verify');
const NAME = pkg.name + '-' + pkg.version;
const STAGE = join(tmpdir(), 'dsh-pack-' + Date.now());
const ZIP = join(OUT, NAME + '.zip');

const SKIP_DIRS = new Set(['logs', 'node_modules', '.git', '__pycache__', 'dist']);
const SKIP_RE = [/\.pyc$/u, /\.log$/u, /\.bak-[^\\/]*$/u, /\.bak-encoding$/u, /^(?:[\\/]|\.\.?[\\/])?config\.json$/u, /\.tmp(?:\.json)?$/u];

function skip(rel, name) {
  const first = rel.split(/[\\/]/)[0];
  if (SKIP_DIRS.has(first) || SKIP_DIRS.has(name)) return true;
  if (!WITH_PYTHON && (first === 'py-packages' || first === 'relay')) return true;
  return SKIP_RE.some((re) => re.test(rel));
}

function copyTree(dir, base) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const from = join(dir, entry.name);
    const rel = relative(base, from);
    if (skip(rel, entry.name)) continue;
    const to = join(STAGE, NAME, rel);
    if (entry.isDirectory()) {
      mkdirSync(to, { recursive: true });
      copyTree(from, base);
    } else if (entry.isFile()) {
      mkdirSync(dirname(to), { recursive: true });
      cpSync(from, to);
    }
  }
}

function countFiles(dir) {
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    n += entry.isDirectory() ? countFiles(join(dir, entry.name)) : 1;
  }
  return n;
}

mkdirSync(OUT, { recursive: true });
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(join(STAGE, NAME), { recursive: true });
copyTree(ROOT, ROOT);
// a shipped archive must never carry credentials, tokens or request logs
for (const dir of ['logs', 'temp', 'temps', 'tmp', '.tmp']) {
  mkdirSync(join(STAGE, NAME, dir), { recursive: true });
}

console.log('staged ' + countFiles(join(STAGE, NAME)) + ' file(s)');

if (existsSync(ZIP)) rmSync(ZIP, { force: true });
// paths travel through the environment, never spliced into PowerShell source
const zipScript = 'Compress-Archive -Path (Join-Path $env:WB_PACK_STAGE "*") -DestinationPath $env:WB_PACK_ZIP -CompressionLevel Optimal -Force';
const zipped = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', zipScript], {
  encoding: 'utf8',
  env: { ...process.env, WB_PACK_STAGE: join(STAGE, NAME), WB_PACK_ZIP: ZIP },
});
if (zipped.status !== 0) {
  console.error(String(zipped.stderr || 'compress failed'));
  process.exit(1);
}
const size = statSync(ZIP).size;
console.log('packed  ' + ZIP + '  (' + (size / 1024).toFixed(1) + ' KiB)');

if (VERIFY) {
  const unpack = join(STAGE, 'verify');
  mkdirSync(unpack, { recursive: true });
  const expanded = spawnSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'Expand-Archive -Path $env:WB_PACK_ZIP -DestinationPath $env:WB_PACK_DEST -Force'],
    { encoding: 'utf8', env: { ...process.env, WB_PACK_ZIP: ZIP, WB_PACK_DEST: unpack } },
  );
  if (expanded.status !== 0) {
    console.error(String(expanded.stderr || 'expand failed'));
    process.exit(1);
  }
  const inner = existsSync(join(unpack, NAME, 'package.json')) ? join(unpack, NAME) : unpack;
  const smoke = spawnSync(process.execPath, [join(inner, 'tests', 'smoke.mjs'), '--live'], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { SMOKE_PORT: '18799' }),
  });
  process.stdout.write(smoke.stdout || '');
  process.stderr.write(smoke.stderr || '');
  console.log(smoke.status === 0 ? 'verify: PASS (unpacked copy passes its own smoke test)' : 'verify: FAIL');
  if (smoke.status !== 0) process.exit(1);
}
