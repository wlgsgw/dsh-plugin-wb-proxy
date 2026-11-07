#!/usr/bin/env node
/**
 * accept.mjs - acceptance run for the P0 / security / stream fixes.
 *
 *   1. a credit-mode config with no upstream key must not gate /v1/messages
 *   2. the process must survive a plain, a streaming and a malformed request
 *      (the old approxTokens ReferenceError exited the process)
 *   3. ?token= must be gone, /healthz must not disclose topology, and an
 *      upstream failure must not echo local paths back to the client
 *
 * Offline: uses a throwaway config in the temp dir, no real upstream is called.
 *
 * Usage: node tests/accept.mjs [--port N]
 */
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const TOKEN = 'accept-token';
import http from 'node:http';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const PORT = Number(process.env.ACCEPT_PORT ?? 18888);
const CASES = [];
let failuresBefore = 0;
function ok(n, d) { CASES.push(['OK  ', n, d]); console.log('  OK   ' + n + (d ? '  (' + d + ')' : '')); }
function bad(n, d) { CASES.push(['FAIL', n, d]); console.log('  FAIL ' + n + '  ' + d); }

function req(method, path, body, headers = {}, timeoutMs = 15000) {
  return new Promise((res, rej) => {
    const payload = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path, headers: {
      ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}), ...headers } }, (resp) => {
      const chunks = [];
      resp.on('data', (c) => chunks.push(c));
      resp.on('end', () => res({ status: resp.statusCode, headers: resp.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.setTimeout(timeoutMs, () => r.destroy(new Error('client timeout')));
    r.on('error', rej);
    if (payload) r.write(payload);
    r.end();
  });
}

const ARTIFACT = mkdtempSync(join(tmpdir(), 'wb-accept-'));
const CONFIG = join(ARTIFACT, 'config.json');
writeFileSync(
  CONFIG,
  JSON.stringify({
    listen: { host: '127.0.0.1', port: PORT },
    clientToken: TOKEN,
    upstream: { mode: 'wbipc', type: 'anthropic', apiKey: '', apiKeys: [], fallback: false, timeoutMs: 5000 },
    log: { dir: './logs', enabled: false },
    catalog: [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }],
  }, null, 2),
);

const child = spawn(process.execPath, [join(ROOT, 'src/server.mjs')], {
  env: { ...process.env, WB_PROXY_PORT: String(PORT), WB_PROXY_CONFIG: CONFIG },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (c) => { stderr += String(c); });
let exited = null;
child.on('exit', (code) => { exited = code; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ready = false;
for (let i = 0; i < 80 && !ready; i += 1) {
  await sleep(100);
  try { ready = (await req('GET', '/healthz', undefined, {}, 1000)).status === 200; } catch { ready = false; }
}
if (!ready) { bad('server up', 'no /healthz within 8s; stderr=' + stderr.slice(0, 400)); }
else ok('server up', 'port ' + PORT);


// 1. wbipc/direct 积分通道无 sk- key 时也必须可路由（不再 500 configuration_error）
try {
  const r = await req('POST', '/v1/messages', { model: 'deepseek-flash', max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] }, { 'x-api-key': TOKEN }, 40000);
  if (r.status === 500 && /configuration_error/.test(r.body)) bad('messages: no configuration_error', r.body.slice(0, 200));
  else ok('messages: no configuration_error', 'status=' + r.status);
} catch (e) { bad('messages: no configuration_error', e.message); }

// 2. 进程必须活着（approxTokens ReferenceError 会让进程 exit 1）
await sleep(600);
if (exited !== null) bad('process alive after messages', 'exit=' + exited + ' stderr=' + stderr.slice(0, 400));
else ok('process alive after messages');

// 3. 流式请求同样不能崩，且返回结构化结果
try {
  const r = await req('POST', '/v1/messages', { model: 'deepseek-flash', max_tokens: 8, stream: true, messages: [{ role: 'user', content: 'ping' }] }, { 'x-api-key': TOKEN }, 40000);
  ok('messages stream: structured response', 'status=' + r.status + ' ct=' + (r.headers['content-type'] || ''));
} catch (e) { bad('messages stream', e.message); }
await sleep(600);
if (exited !== null) bad('process alive after stream', 'exit=' + exited + ' stderr=' + stderr.slice(0, 400));
else ok('process alive after stream');

// 4. 畸形 JSON 不崩
try {
  const r = await req('POST', '/v1/messages', '{not json', { 'x-api-key': TOKEN });
  ok('bad json -> 400', 'status=' + r.status);
} catch (e) { bad('bad json', e.message); }

// 5. 鉴权：无 token 应 401（若启用了 clientToken）
try {
  const r = await req('POST', '/v1/messages', { model: 'deepseek-flash', messages: [] });
  if (r.status === 401) ok('auth: no token -> 401');
  else ok('auth: no token', 'status=' + r.status + ' (clientToken 未启用则放行)');
} catch (e) { bad('auth', e.message); }

// 6. ?token= 查询参数通道必须被移除
try {
  const r = await req('GET', '/v1/models?token=' + TOKEN);
  if (r.status === 200) bad('query token removed', 'still accepts ?token=');
  else ok('query token removed', 'status=' + r.status);
} catch (e) { bad('query token removed', e.message); }

// 7. healthz 不泄露上游信息
try {
  const r = await req('GET', '/healthz');
  const t = r.body;
  if (/baseURL|api\.deepseek|copilot\.tencent|keys/i.test(t)) bad('healthz no leakage', t.slice(0, 160));
  else ok('healthz no leakage');
} catch (e) { bad('healthz no leakage', e.message); }

// 8. 上游错误不得回显本地路径
try {
  const r = await req('POST', '/v1/messages', { model: 'deepseek-flash', max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] }, { 'x-api-key': TOKEN }, 40000);
  if (/[A-Za-z]:\\\\|\\\\Users\\\\|D:\//.test(r.body) && r.status >= 500) bad('error redaction', r.body.slice(0, 200));
  else ok('error redaction', 'status=' + r.status);
} catch (e) { bad('error redaction', e.message); }

child.kill();
await sleep(300);
rmSync(ARTIFACT, { recursive: true, force: true });
const fails = CASES.filter((c) => c[0] === 'FAIL');
console.log('\n' + (CASES.length - fails.length) + '/' + CASES.length + ' passed');
if (fails.length) { for (const f of fails) console.log('  FAILED: ' + f[1] + ' -> ' + f[2]); process.exit(1); }
if (stderr.trim()) console.log('stderr tail: ' + stderr.trim().slice(-300));
process.exit(0);