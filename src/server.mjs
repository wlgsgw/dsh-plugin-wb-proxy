#!/usr/bin/env node
/**
 * wb-deepseek-proxy (DSH plugin build)
 *
 * Anthropic Messages front-end for the WorkBuddy credit channel:
 *   DSH -> 127.0.0.1:8787/v1/messages -> [direct | wbipc | http] -> upstream
 *
 * upstream.mode:
 *   direct  - use the WorkBuddy process token, call copilot.tencent.com directly
 *             (real streaming, no 50s / 640KB broker limits)
 *   wbipc   - borrow the WorkBuddy local broker (hard 50s, 640KB, buffered)
 *   http    - key-based passthrough to upstream.baseURL (anthropic or openai)
 * When a credit path fails and upstream.fallback is true, the key path takes over.
 */

import http from 'node:http';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamTranslator, toAnthropicResponse, toOpenAIRequest } from './openai-bridge.mjs';
import { WbipcUpstream, sseToMessage } from './wbipc-upstream.mjs';
import { DirectUpstream, sanitizeMessages } from './direct-upstream.mjs';
import { isEmptyOpenAIJson } from './empty-guard.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// plugin layout: src/ holds code only; config.json + logs/ live in the plugin root
const PLUGIN_ROOT = resolve(HERE, '..');
const CONFIG_PATH =
  process.env.WB_PROXY_CONFIG ??
  (existsSync(join(HERE, 'config.json')) ? join(HERE, 'config.json') : join(PLUGIN_ROOT, 'config.json'));
const RUNTIME_ROOT = dirname(CONFIG_PATH);

const fileConfig = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
const cfg = {
  listen: { host: '127.0.0.1', port: 8787, ...(fileConfig.listen ?? {}) },
  clientToken: fileConfig.clientToken ?? null,
  upstream: {
    type: 'anthropic',
    baseURL: 'https://api.deepseek.com/anthropic',
    apiKey: '',
    apiKeys: [],
    timeoutMs: 300_000,
    maxRetries: 1,
    extraHeaders: {},
    ...(fileConfig.upstream ?? {}),
  },
  modelMap: fileConfig.modelMap ?? {},
  catalog: fileConfig.catalog ?? [],
  log: { dir: './logs', enabled: true, ...(fileConfig.log ?? {}) },
};

if (process.env.WB_PROXY_HOST) cfg.listen.host = process.env.WB_PROXY_HOST;
if (process.env.WB_PROXY_PORT) cfg.listen.port = Number(process.env.WB_PROXY_PORT);
if (process.env.WB_UPSTREAM_BASE) cfg.upstream.baseURL = process.env.WB_UPSTREAM_BASE;
if (process.env.WB_UPSTREAM_TYPE) cfg.upstream.type = process.env.WB_UPSTREAM_TYPE;
if (process.env.WB_DEEPSEEK_KEY) cfg.upstream.apiKey = process.env.WB_DEEPSEEK_KEY;
if (process.env.WB_CLIENT_TOKEN) cfg.clientToken = process.env.WB_CLIENT_TOKEN;

const UPSTREAM_BASE = cfg.upstream.baseURL.replace(/\/+$/u, '');
const upstreamWbipc =
  cfg.upstream.mode === 'wbipc'
    ? new WbipcUpstream({
        configDir: cfg.wbipc?.configDir,
        path: cfg.wbipc?.path ?? '/v2/chat/completions',
        modelMap: cfg.wbipc?.modelMap ?? { 'deepseek-flash': 'deepseek-v4-flash', 'deepseek-v4-pro': 'deepseek-v4-pro' },
        requestTimeoutMs: cfg.wbipc?.requestTimeoutMs ?? 52_000,
      })
    : null;
let wbipcFails = 0;
let wbipcCooldownUntil = 0;
// credit path: direct HTTPS to copilot.tencent.com using the WorkBuddy memory token
const directUpstream =
  cfg.upstream.mode === 'direct'
    ? new DirectUpstream({
        baseURL: cfg.direct?.baseURL ?? 'https://copilot.tencent.com',
        path: cfg.direct?.path ?? '/v2/chat/completions',
        tokenFile: cfg.direct?.tokenFile,
        scanScript: cfg.direct?.scanScript,
        modelMap: cfg.direct?.modelMap ?? { 'deepseek-flash': 'deepseek-v4-flash', 'deepseek-v4-pro': 'deepseek-v4-pro' },
      })
    : null;
const LOG_DIR = resolve(RUNTIME_ROOT, cfg.log.dir);
if (cfg.log.enabled && !existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

const keys = [...new Set([cfg.upstream.apiKey, ...(cfg.upstream.apiKeys ?? [])].filter((k) => typeof k === 'string' && k.length > 0))];
let keyCursor = 0;
function nextKey() {
  if (keys.length === 0) return null;
  const key = keys[keyCursor % keys.length];
  keyCursor += 1;
  return key;
}
function maskKey(key) {
  if (key === null) return 'none';
  return key.length <= 10 ? '***' : key.slice(0, 5) + '...' + key.slice(-4);
}

function log(entry) {
  const record = { ts: new Date().toISOString(), ...entry };
  const line = JSON.stringify(record);
  if (cfg.log.enabled) {
    const file = join(LOG_DIR, `proxy-${record.ts.slice(0, 10)}.jsonl`);
    try {
      appendFileSync(file, `${line}\n`);
    } catch {
      /* logging must never break a request */
    }
  }
  if (process.env.WB_PROXY_VERBOSE === '1') process.stdout.write(`${line}\n`);
}

const MODELS = cfg.catalog.map((entry) => ({
  id: entry.id,
  type: 'model',
  display_name: entry.name ?? entry.id,
  created_at: '2026-01-01T00:00:00Z',
  context_window: entry.context_window ?? 1_048_576,
  max_output_tokens: entry.max_output_tokens ?? 384_000,
  input_modalities: entry.input_modalities ?? ['text'],
}));

function sendJSON(res, status, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function apiError(res, status, type, message) {
  sendJSON(res, status, { type: 'error', error: { type, message } });
}

function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) {
        rejectPromise(new Error(`request body exceeds ${limit} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks)));
    req.on('error', rejectPromise);
  });
}

function authorized(req, url) {
  if (!cfg.clientToken) return true;
  const header = req.headers['x-api-key'] ?? req.headers.authorization?.replace(/^Bearer\s+/iu, '');
  return header === cfg.clientToken || url.searchParams.get('token') === cfg.clientToken;
}

function upstreamURL(pathname) {
  if (cfg.upstream.type === 'openai') return `${UPSTREAM_BASE}/chat/completions`;
  return `${UPSTREAM_BASE}${pathname}`;
}

function upstreamHeaders(accept) {
  const key = nextKey();
  const base = {
    'content-type': 'application/json',
    accept,
    'user-agent': 'wb-deepseek-proxy/1.0',
    ...cfg.upstream.extraHeaders,
  };
  if (key === null) return { headers: base, key };
  if (cfg.upstream.type === 'openai') base.authorization = `Bearer ${key}`;
  else {
    base['x-api-key'] = key;
    base['anthropic-version'] = '2023-06-01';
  }
  return { headers: base, key };
}

async function callUpstream(url, body, accept, signal) {
  const { headers, key } = upstreamHeaders(accept);
  let lastError;
  for (let attempt = 0; attempt <= cfg.upstream.maxRetries; attempt += 1) {
    try {
      const response = await fetch(url, { method: 'POST', headers, body, signal, redirect: 'error' });
      if (response.status === 429 || response.status >= 500) {
        if (attempt < cfg.upstream.maxRetries) {
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
          continue;
        }
      }
      return { response, key };
    } catch (error) {
      lastError = error;
      if (signal?.aborted) throw error;
      if (attempt >= cfg.upstream.maxRetries) throw error;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw lastError;
}

function headerPhaseSignal() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('upstream header timeout')), cfg.upstream.timeoutMs);
  return {
    signal: controller.signal,
    done() {
      clearTimeout(timer);
    },
    abort() {
      controller.abort(new Error('client aborted'));
    },
  };
}

async function pipeStream(upstream, res, onText) {
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    if (onText) onText(text);
    if (!res.write(Buffer.from(value))) await new Promise((r) => res.once('drain', r));
  }
  res.end();
}

async function handleMessages(req, res, url) {
  const started = Date.now();
  let requestBody;
  try {
    const raw = await readBody(req);
    requestBody = JSON.parse(raw.toString('utf8'));
  } catch (error) {
    apiError(res, 400, 'invalid_request_error', `bad JSON body: ${error.message}`);
    log({ route: 'messages', status: 400, ms: Date.now() - started, error: String(error.message) });
    return;
  }

  const model = requestBody.model;
  const upstreamModel = cfg.modelMap[model] ?? model;
  const streaming = requestBody.stream === true;
  if (directUpstream) {
    try {
      const { response, wbModel } = await directUpstream.open(requestBody, model);
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw Object.assign(new Error(`direct ${response.status}: ${detail.slice(0, 200)}`), { status: response.status });
      }
      const translator = new StreamTranslator(model);
      if (streaming) {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let pending = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          const boundary = pending.lastIndexOf('\n\n');
          if (boundary === -1) continue;
          const frame = translator.feed(pending.slice(0, boundary + 2));
          if (frame.length > 0) res.write(frame);
          pending = pending.slice(boundary + 2);
        }
        if (pending.length > 0) res.write(translator.feed(pending));
        res.write(translator.finish(null));
        res.end();
      } else {
        let full = '';
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          full += decoder.decode(value, { stream: true });
        }
        sendJSON(res, 200, sseToMessage(translator.feed(full) + translator.finish(null), model));
      }
      log({
        route: 'messages',
        mode: 'direct',
        model,
        upstreamModel: wbModel,
        stream: streaming,
        status: 200,
        ms: Date.now() - started,
        usage: { input_tokens: translator.inputTokens, output_tokens: translator.outputTokens },
      });
      return;
    } catch (error) {
      log({ route: 'messages', mode: 'direct', model, status: 502, ms: Date.now() - started, error: String(error?.message ?? error).slice(0, 300), fallback: cfg.upstream.fallback !== false });
      if (cfg.upstream.fallback === false) {
        apiError(res, 502, 'upstream_error', String(error?.message ?? error));
        return;
      }
    }
  }
  const wbipcMaxInput = cfg.wbipc?.maxInputTokens ?? 20_000;
  const wbipcUsable = upstreamWbipc && Date.now() >= wbipcCooldownUntil && approxTokens <= wbipcMaxInput;
  if (upstreamWbipc && !wbipcUsable) {
    log({ route: 'messages', mode: 'wbipc', model, skipped: true, approxTokens, reason: Date.now() < wbipcCooldownUntil ? 'cooldown' : 'input-too-large' });
  }
  if (wbipcUsable) {
    try {
      const { sse, usage, wbModel } = await upstreamWbipc.complete(requestBody, model);
      wbipcFails = 0;
      if (streaming) {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        res.end(sse);
      } else {
        sendJSON(res, 200, sseToMessage(sse, model));
      }
      log({ route: 'messages', mode: 'wbipc', model, upstreamModel: wbModel, stream: streaming, status: 200, ms: Date.now() - started, usage });
      return;
    } catch (error) {
      wbipcFails += 1;
      if (wbipcFails >= 2) {
        wbipcCooldownUntil = Date.now() + 10 * 60_000;
        wbipcFails = 0;
      }
      log({
        route: 'messages',
        mode: 'wbipc',
        model,
        status: 502,
        ms: Date.now() - started,
        error: String(error?.message ?? error).slice(0, 300),
        fallback: cfg.upstream.fallback !== false,
      });
      if (cfg.upstream.fallback === false || /rpc timeout|handshake timeout/i.test(String(error?.message ?? ''))) {
        apiError(res, 504, 'upstream_timeout', String(error?.message ?? error));
        return;
      }
    }
  }

  const phase = headerPhaseSignal();
  res.on('close', () => {
    if (!res.writableEnded) phase.abort();
  });

  try {
    if (cfg.upstream.type === 'openai') {
      const maxAttempts = 2;
      let attempt = null;
      for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
        const payload = toOpenAIRequest({ ...requestBody, model: upstreamModel }, upstreamModel);
        payload.messages = sanitizeMessages(payload.messages);
        const call = await callUpstream(
          upstreamURL('/v1/messages'),
          JSON.stringify(payload),
          streaming ? 'text/event-stream' : 'application/json',
          phase.signal,
        );
        if (!call.response.ok) {
          const detail = await call.response.text();
          apiError(res, call.response.status, 'upstream_error', detail.slice(0, 2000));
          log({ route: 'messages', mode: 'openai', model, status: call.response.status, ms: Date.now() - started, error: detail.slice(0, 500) });
          return;
        }
        const body = await call.response.text();
        attempt = { body, key: call.key };
        const hasContent = streaming
          ? /"(?:text|input_json)_delta"/u.test(body)
          : (() => {
              try {
                return !isEmptyOpenAIJson(JSON.parse(body));
              } catch {
                return true;
              }
            })();
        if (hasContent) break;
        if (attemptIndex + 1 < maxAttempts) {
          log({ route: 'messages', mode: 'openai', model, status: 200, note: 'empty-stream retry', ms: Date.now() - started });
        }
      }
      phase.done();
      const key = attempt.key;
      log({ route: 'messages', mode: 'openai', model, upstreamModel, stream: streaming, status: 200, statusNote: 'forwarded', key: maskKey(key) });
      if (!streaming) {
        let json = {};
        try {
          json = JSON.parse(attempt.body);
        } catch {
          json = {};
        }
        sendJSON(res, 200, toAnthropicResponse(json, model));
        log({ route: 'messages', mode: 'openai', model, stream: false, status: 200, ms: Date.now() - started });
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      const translator = new StreamTranslator(model);
      const sse = translator.feed(attempt.body) + translator.finish(null);
      res.write(sse);
      res.end();
      log({ route: 'messages', mode: 'openai', model, stream: true, status: 200, ms: Date.now() - started, usage: { input_tokens: translator.inputTokens, output_tokens: translator.outputTokens } });
      return;
    }

    // ---- Anthropic passthrough (default) ----
    const payload = JSON.stringify({ ...requestBody, model: upstreamModel });
    const { response, key } = await callUpstream(upstreamURL(url.pathname), payload, streaming ? 'text/event-stream' : 'application/json', phase.signal);
    phase.done();

    if (!response.ok) {
      const detail = await response.text();
      apiError(res, response.status, 'upstream_error', detail.slice(0, 2000));
      log({ route: 'messages', mode: 'anthropic', model, status: response.status, ms: Date.now() - started, error: detail.slice(0, 500), key: maskKey(key) });
      return;
    }

    const contentType = response.headers.get('content-type') ?? 'application/json';
    if (!contentType.includes('text/event-stream')) {
      const text = await response.text();
      res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' });
      res.end(text);
      let usage = null;
      try {
        usage = JSON.parse(text).usage ?? null;
      } catch {
        usage = null;
      }
      log({ route: 'messages', mode: 'anthropic', model, upstreamModel, stream: false, status: 200, ms: Date.now() - started, usage, key: maskKey(key) });
      return;
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    let tail = '';
    let usage = null;
    await pipeStream(response, res, (text) => {
      tail = (tail + text).slice(-4096);
      const matches = tail.match(/"usage":\{[^}]*\}/gu);
      if (matches && matches.length > 0) {
        try {
          usage = JSON.parse(`{${matches.at(-1)}}`).usage;
        } catch {
          /* partial frame; a later chunk will complete it */
        }
      }
    });
    log({ route: 'messages', mode: 'anthropic', model, upstreamModel, stream: true, status: 200, ms: Date.now() - started, usage, key: maskKey(key) });
  } catch (error) {
    phase.done();
    if (res.headersSent) {
      res.end();
    } else {
      apiError(res, 502, 'proxy_error', String(error?.message ?? error));
    }
    log({ route: 'messages', model, status: 502, ms: Date.now() - started, error: String(error?.message ?? error) });
  }
}

async function handleCountTokens(req, res, url) {
  if (cfg.upstream.type === 'openai') {
    sendJSON(res, 200, { input_tokens: 0 });
    return;
  }
  try {
    const raw = await readBody(req);
    const { response, key } = await callUpstream(upstreamURL(url.pathname), raw.toString('utf8'), 'application/json', AbortSignal.timeout(cfg.upstream.timeoutMs));
    const text = await response.text();
    res.writeHead(response.status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(text);
    log({ route: 'count_tokens', status: response.status, key: maskKey(key) });
  } catch (error) {
    apiError(res, 502, 'proxy_error', String(error?.message ?? error));
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);

  if (req.method === 'GET' && (url.pathname === '/healthz' || url.pathname === '/health')) {
    sendJSON(res, 200, {
      ok: true,
      upstream: { type: cfg.upstream.type, baseURL: UPSTREAM_BASE, keys: keys.length },
      models: MODELS.map((m) => m.id),
      clientTokenRequired: Boolean(cfg.clientToken),
    });
    return;
  }

  if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
    if (!authorized(req, url)) {
      apiError(res, 401, 'authentication_error', 'invalid proxy token');
      return;
    }
    sendJSON(res, 200, { object: 'list', data: MODELS });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/messages') {
    if (!authorized(req, url)) {
      apiError(res, 401, 'authentication_error', 'invalid proxy token');
      return;
    }
    if (keys.length === 0) {
      apiError(res, 500, 'configuration_error', 'no upstream API key configured (upstream.apiKey or WB_DEEPSEEK_KEY)');
      return;
    }
    await handleMessages(req, res, url);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/messages/count_tokens') {
    if (!authorized(req, url)) {
      apiError(res, 401, 'authentication_error', 'invalid proxy token');
      return;
    }
    await handleCountTokens(req, res, url);
    return;
  }

  apiError(res, 404, 'not_found_error', `no route for ${req.method} ${url.pathname}`);
});

server.requestTimeout = 0;
server.headersTimeout = 60_000;
server.listen(cfg.listen.port, cfg.listen.host, () => {
  const where = `http://${cfg.listen.host}:${cfg.listen.port}`;
  process.stdout.write(
    [
      'wb-deepseek-proxy up',
      `  listen    ${where}`,
      `  upstream  ${cfg.upstream.type} ${UPSTREAM_BASE}`,
      `  keys      ${keys.length} (${keys.map(maskKey).join(', ')})`,
      `  models    ${MODELS.map((m) => m.id).join(', ')}`,
      `  DSH       baseURL: ${where}  apiKeyEnv -> "${cfg.clientToken ?? '<unset>'}"`,
      '',
    ].join('\n'),
  );
});

for (const event of ['SIGINT', 'SIGTERM']) {
  process.on(event, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}

