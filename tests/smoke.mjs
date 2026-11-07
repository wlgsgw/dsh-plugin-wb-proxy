#!/usr/bin/env node
/**
 * smoke.mjs - assembly self-check for the wb-proxy DSH plugin.
 *
 *   1. package.json parses and carries the dsh.plugin section
 *   2. every src/*.mjs passes `node --check` (the import chain resolves)
 *   3. config/config.credits.json is a usable config
 *   4. patch/cordis.patch.snippet.yml, comments removed, is one llm-deepseek block
 *   5. --live: start server.mjs on a temp port and verify
 *      /healthz, 401 without a token, /v1/models with a token
 *
 * Usage: node tests/smoke.mjs [--live]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const LIVE = process.argv.includes('--live');
const PORT = Number(process.env.SMOKE_PORT ?? 18787);
const TOKEN = 'local-proxy';

const failures = [];

function pass(name, detail) {
  console.log(`  OK   ${name}` + (detail ? `  (${detail})` : ''));
}

function fail(name, detail) {
  failures.push(name);
  console.log(`  FAIL ${name}  ${detail}`);
}

function syncCheck(name, fn) {
  try {
    const detail = fn();
    pass(name, detail);
  } catch (error) {
    fail(name, error.message);
  }
}

async function asyncCheck(name, fn) {
  try {
    const detail = await fn();
    pass(name, detail);
  } catch (error) {
    fail(name, error.message);
  }
}

console.log(`wb-proxy plugin smoke  root=${ROOT}`);

syncCheck('package.json + dsh.plugin', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  if (!pkg.dsh || !pkg.dsh.plugin || !pkg.dsh.plugin.profilePatch) {
    throw new Error('missing dsh.plugin.profilePatch');
  }
  return pkg.name + '@' + pkg.version;
});

syncCheck('src/*.mjs parses', () => {
  const dir = join(ROOT, 'src');
  const files = readdirSync(dir).filter((f) => f.endsWith('.mjs'));
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', join(dir, file)], { encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(file + ': ' + String(result.stderr || '').split('\n')[0]);
    }
  }
  return files.length + ' file(s)';
});

syncCheck('config sample', () => {
  const cfg = JSON.parse(readFileSync(join(ROOT, 'config', 'config.credits.json'), 'utf8'));
  if (!cfg.listen || !cfg.listen.port) throw new Error('listen.port missing');
  if (!cfg.upstream || !cfg.upstream.mode) throw new Error('upstream.mode missing');
  return 'mode=' + cfg.upstream.mode + ' port=' + cfg.listen.port;
});

syncCheck('patch snippet', () => {
  const text = readFileSync(join(ROOT, 'patch', 'cordis.patch.snippet.yml'), 'utf8');
  const active = text
    .split(/\r?\n/u)
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
  if (!active.includes('- id: llm-deepseek')) throw new Error('llm-deepseek entry missing');
  if (!active.includes('apiKeyEnv: DEEPSEEK_PROXY_KEY')) throw new Error('apiKeyEnv missing');
  const lines = active.split(/\r?\n/u).filter((line) => line.trim());
  return lines.length + ' active lines';
});

function get(path, headers) {
  return new Promise((res, rej) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path, method: 'GET', headers: headers || {} },
      (r) => {
        let body = '';
        r.on('data', (chunk) => {
          body += chunk;
        });
        r.on('end', () => res({ status: r.statusCode, body }));
      },
    );
    req.on('error', rej);
    req.end();
  });
}

async function live() {
  const config = join(ROOT, 'config', 'config.credits.json');
  const child = spawn(process.execPath, [join(ROOT, 'src', 'server.mjs')], {
    env: Object.assign({}, process.env, { WB_PROXY_PORT: String(PORT), WB_PROXY_CONFIG: config }),
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  let ready = false;
  try {
    for (let i = 0; i < 60 && !ready; i += 1) {
      await new Promise((done) => setTimeout(done, 100));
      try {
        ready = (await get('/healthz')).status === 200;
      } catch {
        ready = false;
      }
    }

    await asyncCheck('live: healthz 200', async () => {
      if (!ready) throw new Error('server did not come up on port ' + PORT);
      const health = await get('/healthz');
      const parsed = JSON.parse(health.body);
      if (!parsed.ok) throw new Error('healthz.ok is false');
      return 'models=' + parsed.models.join(',');
    });

    await asyncCheck('live: no token -> 401', async () => {
      const r = await get('/v1/models');
      if (r.status !== 401) throw new Error('expected 401, got ' + r.status);
      return 'authentication_error';
    });

    await asyncCheck('live: token -> /v1/models', async () => {
      const r = await get('/v1/models', { 'x-api-key': TOKEN });
      if (r.status !== 200) throw new Error('expected 200, got ' + r.status);
      const ids = JSON.parse(r.body).data.map((m) => m.id);
      if (!ids.includes('deepseek-flash')) throw new Error('deepseek-flash missing from catalog');
      return 'models=' + ids.join(',');
    });
  } finally {
    child.kill();
    await new Promise((done) => setTimeout(done, 200));
  }
}

if (LIVE) {
  await live();
}

if (failures.length === 0) {
  console.log('\nall checks passed');
  process.exit(0);
}
console.log('\n' + failures.length + ' check(s) failed: ' + failures.join(', '));
process.exit(1);
