#!/usr/bin/env node
/**
 * smoke.mjs - assembly self-check for the wb-proxy DSH plugin.
 *
 *   1. package.json parses and carries the dsh.plugin section
 *   2. every src/*.mjs passes `node --check` (the import chain resolves)
 *   3. config/config.credits.json is a usable config
 *   4. patch/cordis.patch.snippet.yml, comments removed, is one llm-deepseek block
 *   5. --live: start server.mjs on a temp port and verify
 *      /healthz, 401 without a token, /v1/models with a token,
 *      and /v1/messages (non-streaming + streaming) with a dummy key.
 *      The upstream may be unreachable; what matters is that the proxy
 *      answers structured JSON and stays alive (no 500 from a bad gate,
 *      no unhandledRejection killing the process).
 *
 * Usage: node tests/smoke.mjs [--live]
 *   SMOKE_PORT overrides the temp port for the proxy under test.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const LIVE = process.argv.includes('--live');
const PORT = Number(process.env.SMOKE_PORT ?? 18787);
const TOKEN = 'local-proxy';
const DUMMY_KEY = 'sk-smoke-dummy-key';

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

function request({ method, path, headers, body, port }) {
  return new Promise((res, rej) => {
    const payload = body === undefined ? null : Buffer.from(body);
    const head = Object.assign({}, headers || {});
    if (payload) {
      head['content-type'] = 'application/json';
      head['content-length'] = String(payload.length);
    }
    const req = http.request(
      { host: '127.0.0.1', port: port ?? PORT, path, method: method ?? 'GET', headers: head },
      (r) => {
        let text = '';
        r.setEncoding('utf8');
        r.on('data', (chunk) => {
          text += chunk;
        });
        r.on('end', () => res({ status: r.statusCode, headers: r.headers, body: text, complete: r.complete }));
        r.on('error', rej);
      },
    );
    req.on('error', rej);
    if (payload) req.write(payload);
    req.end();
  });
}

function get(path, headers) {
  return request({ method: 'GET', path, headers, port: PORT });
}

function post(path, payload, headers) {
  return request({ method: 'POST', path, headers, body: JSON.stringify(payload), port: PORT });
}

/** A live upstream may be unreachable here; only the shape of the answer is contract. */
function assertStructured(r, wantStatus) {
  const where = wantStatus === 'any' ? `status ${r.status}` : `status ${r.status} (want ${wantStatus})`;
  if (wantStatus !== 'any' && r.status !== wantStatus) {
    throw new Error(`${where}: ${String(r.body).slice(0, 200)}`);
  }
  const contentType = String(r.headers['content-type'] ?? '');
  if (!contentType.includes('application/json')) {
    throw new Error(`${where}: content-type is not JSON (${contentType || 'none'})`);
  }
  let parsed;
  try {
    parsed = JSON.parse(r.body);
  } catch {
    throw new Error(`${where}: body is not JSON: ${String(r.body).slice(0, 200)}`);
  }
  const type = parsed.type ?? parsed?.error?.type;
  if (!type) throw new Error(`${where}: JSON error payload has no type`);
  if (r.status >= 400 && r.status !== 200 && !parsed.error?.message) {
    throw new Error(`${where}: error payload has no error.message`);
  }
  return `${where} type=${type}`;
}

async function healthzOk(headers) {
  try {
    const r = await get('/healthz', headers);
    if (r.status !== 200) return false;
    return JSON.parse(r.body).ok === true;
  } catch {
    return false;
  }
}

/** True when the child process is still running (exit is async on Windows, so poll briefly). */
async function alive(child) {
  if (child.exitCode !== null || child.signalCode !== null) return false;
  await new Promise((done) => setTimeout(done, 100));
  return child.exitCode === null && child.signalCode === null;
}

function writeCreditsConfig(dir) {
  const base = JSON.parse(readFileSync(join(ROOT, 'config', 'config.credits.json'), 'utf8'));
  const file = join(dir, 'config.credits.json');
  // same credit-mode shape as the shipped config, but with no API key at all:
  // this is the regression case for the "no upstream API key configured" 500.
  const config = Object.assign({}, base, {
    upstream: Object.assign({}, base.upstream, { apiKey: '', apiKeys: [], fallback: false }),
    direct: Object.assign({}, base.direct, { tokenFile: join(dir, 'missing-token.json') }),
    log: { dir: join(dir, 'logs'), enabled: true },
  });
  writeFileSync(file, JSON.stringify(config, null, 2));
  return file;
}

async function live() {
  const tempDir = mkdtempSync(join(tmpdir(), 'wb-proxy-smoke-'));
  const config = writeCreditsConfig(tempDir);
  const startedAt = Date.now();
  const child = spawn(process.execPath, [join(ROOT, 'src', 'server.mjs')], {
    env: Object.assign({}, process.env, {
      WB_PROXY_PORT: String(PORT),
      WB_PROXY_CONFIG: config,
      WB_CLIENT_TOKEN: TOKEN,
    }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });

  // /healthz may require the token and its detail fields are being slimmed down,
  // so readiness only checks for a 200 JSON with ok:true.
  const healthzHeaders = { 'x-api-key': TOKEN };
  let ready = false;
  try {
    for (let i = 0; i < 60 && !ready; i += 1) {
      await new Promise((done) => setTimeout(done, 100));
      ready = await healthzOk(healthzHeaders);
    }

    await asyncCheck('live: healthz 200', async () => {
      if (!ready) throw new Error('server did not come up on port ' + PORT);
      const health = await get('/healthz', healthzHeaders);
      if (health.status !== 200) throw new Error('healthz status ' + health.status);
      const parsed = JSON.parse(health.body);
      if (parsed.ok !== true) throw new Error('healthz.ok is not true');
      return 'ok';
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

    // credit mode (direct / wbipc) needs no upstream key: the key gate used to
    // answer 500 "no upstream API key configured" and hid every /v1/messages call.
    const messages = {
      model: 'deepseek-flash',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'smoke ping' }],
    };
    const auth = { 'x-api-key': TOKEN };

    await asyncCheck('live: POST /v1/messages (no key, credit mode) not a key-gate 500', async () => {
      const r = await post('/v1/messages', messages, auth);
      if (r.status >= 400 && r.status < 500) {
        // 401/400/404 are request-shape problems, never "nothing is configured"
        throw new Error(`rejected before routing: status ${r.status} ${r.body.slice(0, 160)}`);
      }
      if (r.status === 200) {
        const parsed = JSON.parse(r.body);
        if (parsed.type !== 'message') throw new Error('200 body is not an Anthropic message');
        return 'status 200 message';
      }
      // 5xx is fine offline (no WorkBuddy / no network) — it must be a structured
      // JSON error and it must not be the missing-key gate: the credit path is configured.
      const detail = assertStructured(r, 'any');
      if (/configuration_error|no upstream (?:API key|configured)/u.test(r.body)) {
        throw new Error('blocked by the key gate in credit mode: ' + r.body.slice(0, 160));
      }
      return detail;
    });

    await asyncCheck('live: POST /v1/messages stream=true (structured reply)', async () => {
      const r = await post('/v1/messages', Object.assign({}, messages, { stream: true }), auth);
      if (r.status >= 400 && r.status < 500) {
        throw new Error(`rejected before routing: status ${r.status} ${r.body.slice(0, 160)}`);
      }
      const contentType = String(r.headers['content-type'] ?? '');
      if (r.status === 200 && contentType.includes('text/event-stream')) {
        if (!r.body.includes('data:')) throw new Error('SSE 200 without any data frame');
        return 'SSE stream (' + r.body.length + ' bytes)';
      }
      if (r.status === 200) {
        const parsed = JSON.parse(r.body);
        if (parsed.type !== 'message') throw new Error('200 body is neither SSE nor an Anthropic message');
        return 'buffered message';
      }
      return assertStructured(r, 'any');
    });

    await asyncCheck('live: POST /v1/messages bad JSON -> 400', async () => {
      const r = await request({ method: 'POST', path: '/v1/messages', body: '{"model":', headers: auth, port: PORT });
      const detail = assertStructured(r, 400);
      return detail;
    });

    await asyncCheck('live: POST /v1/messages unknown route shape stays JSON', async () => {
      const r = await post('/v1/messages', { model: 'not-a-model', messages: [{ role: 'user', content: 'x' }] }, auth);
      const detail = r.status === 200 ? 'status 200' : assertStructured(r, 'any');
      if (/configuration_error|no upstream (?:API key|configured)/u.test(r.body)) {
        throw new Error('blocked by the key gate in credit mode: ' + r.body.slice(0, 160));
      }
      return detail;
    });

    await asyncCheck('live: proxy still running after /v1/messages calls', async () => {
      if (!(await alive(child))) {
        throw new Error(`proxy exited (code=${child.exitCode}) stderr=${stderr.slice(-300)}`);
      }
      if (stderr.includes('unhandledRejection')) {
        throw new Error('unhandledRejection reached stderr: ' + stderr.slice(-300));
      }
      if (!(await healthzOk(healthzHeaders))) throw new Error('healthz failed after /v1/messages traffic');
      return `alive, ${Math.round((Date.now() - startedAt) / 1000)}s uptime`;
    });

    await asyncCheck('live: GET /v1/messages -> 404 JSON', async () => {
      const r = await get('/v1/messages', auth);
      return assertStructured(r, 404);
    });
  } finally {
    child.kill();
    await new Promise((done) => setTimeout(done, 200));
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* temp dir cleanup is best effort */
    }
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
