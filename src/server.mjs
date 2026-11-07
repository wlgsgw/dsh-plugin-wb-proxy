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
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeSync } from 'node:fs';
import { appendFile, readdir, unlink } from 'node:fs/promises';
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
  limits: {
    maxBodyBytes: 8 * 1024 * 1024,
    maxConcurrent: 8,
    rateLimitPerMinute: 240,
    rateLimitBurst: 60,
    streamIdleTimeoutMs: 120_000,
    ...(fileConfig.limits ?? {}),
  },
};

// a missing / zero / non-numeric timeout would hang every upstream call forever
if (!Number.isFinite(cfg.upstream.timeoutMs) || cfg.upstream.timeoutMs <= 0) cfg.upstream.timeoutMs = 300_000;

if (process.env.WB_PROXY_HOST) cfg.listen.host = process.env.WB_PROXY_HOST;
if (process.env.WB_PROXY_PORT) cfg.listen.port = Number(process.env.WB_PROXY_PORT);
if (process.env.WB_UPSTREAM_BASE) cfg.upstream.baseURL = process.env.WB_UPSTREAM_BASE;
if (process.env.WB_UPSTREAM_TYPE) cfg.upstream.type = process.env.WB_UPSTREAM_TYPE;
if (process.env.WB_DEEPSEEK_KEY) cfg.upstream.apiKey = process.env.WB_DEEPSEEK_KEY;
if (process.env.WB_CLIENT_TOKEN) cfg.clientToken = process.env.WB_CLIENT_TOKEN;

// an empty / non-string clientToken never disables auth; a missing one is generated once
let tokenGenerated = false;
if (typeof cfg.clientToken !== 'string' || cfg.clientToken.length === 0) {
  cfg.clientToken = randomBytes(24).toString('base64url');
  tokenGenerated = true;
}
const CLIENT_TOKEN = Buffer.from(cfg.clientToken, 'utf8');

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

const LOG_RETENTION_DAYS = 7;
const LOG_MAX_BYTES = 20 * 1024 * 1024;
const LOG_QUEUE_LIMIT = 4096;
const LOG_FILE_PATTERN = /^proxy-\d{4}-\d{2}-\d{2}(?:-[a-z0-9]+)?\.jsonl$/u;

// async, bounded sink: a request thread never blocks on disk I/O, and a log
// flood cannot grow the heap without bound.
const logQueue = [];
let logDraining = false;
let logSwept = false;

function pruneLogs() {
  const cutoff = new Date(Date.now() - LOG_RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10);
  readdir(LOG_DIR)
    .then(async (names) => {
      for (const name of names) {
        if (!LOG_FILE_PATTERN.test(name) || name.slice(6, 16) >= cutoff) continue;
        await unlink(join(LOG_DIR, name)).catch(() => {});
      }
    })
    .catch(() => {});
}

async function drainLogs() {
  if (logDraining) return;
  logDraining = true;
  try {
    while (logQueue.length > 0) {
      const entry = logQueue.shift();
      try {
        const size = existsSync(entry.file) ? statSync(entry.file).size : 0;
        if (size > LOG_MAX_BYTES) {
          // rotate instead of letting one day file grow without bound
          await appendFile(entry.file.replace(/\.jsonl$/u, `-${Date.now().toString(36)}.jsonl`), entry.line);
        } else {
          await appendFile(entry.file, entry.line);
        }
      } catch {
        /* logging must never break a request */
      }
    }
  } finally {
    logDraining = false;
  }
}

function log(entry) {
  const record = { ts: new Date().toISOString(), ...entry };
  const line = JSON.stringify(record);
  if (cfg.log.enabled) {
    if (logQueue.length >= LOG_QUEUE_LIMIT) logQueue.shift();
    logQueue.push({ file: join(LOG_DIR, `proxy-${record.ts.slice(0, 10)}.jsonl`), line: `${line}\n` });
    if (!logDraining) drainLogs();
    if (!logSwept) {
      logSwept = true;
      pruneLogs();
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

function apiError(res, status, type, message, extra = {}) {
  sendJSON(res, status, { type: 'error', error: { type, message, ...extra } });
}

// upstream bodies and local error text stay in the log; clients get a fixed short message
function upstreamErrorMessage(status, scope) {
  return `upstream returned HTTP ${Number.isInteger(status) ? status : 'error'} (${scope})`;
}

function readBody(req, limit = cfg.limits.maxBodyBytes) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let total = 0;
    let overflow = false;
    req.on('data', (chunk) => {
      if (overflow) return;
      total += chunk.length;
      if (total > limit) {
        overflow = true;
        chunks.length = 0;
        rejectPromise(Object.assign(new Error(`request body exceeds ${limit} bytes`), { code: 'body_too_large' }));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!overflow) resolvePromise(Buffer.concat(chunks));
    });
    req.on('error', rejectPromise);
  });
}

function tokenMatches(value) {
  if (typeof value !== 'string') return false;
  const candidate = Buffer.from(value, 'utf8');
  if (candidate.length !== CLIENT_TOKEN.length) return false;
  return timingSafeEqual(candidate, CLIENT_TOKEN);
}

// header-only channel: a token in the query string would leak through logs, proxies and history
function authorized(req) {
  const header = req.headers['x-api-key'] ?? req.headers.authorization?.replace(/^Bearer\s+/iu, '');
  return tokenMatches(Array.isArray(header) ? header[0] : header);
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
  const retries = Math.max(0, Number(cfg.upstream.maxRetries) || 0);
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (signal?.aborted) throw signal.reason ?? new Error('aborted');
    // headers are rebuilt per attempt so a retry rotates to the next key
    const { headers, key } = upstreamHeaders(accept);
    let response = null;
    try {
      response = await fetch(url, { method: 'POST', headers, body, signal, redirect: 'error' });
      if ((response.status === 429 || response.status >= 500) && attempt < retries) {
        // release the body before the next attempt: an unconsumed response
        // otherwise holds the socket (and that key's rate budget) open
        await response.body?.cancel().catch(() => {});
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        continue;
      }
      return { response, key };
    } catch (error) {
      await response?.body?.cancel().catch(() => {});
      lastError = error;
      if (signal?.aborted) throw error;
      if (attempt >= retries) throw error;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw lastError ?? new Error('upstream call failed');
}

// Rough token estimate for routing decisions (wbipc input cap). CJK-heavy text
// lands near 1 char/token, ASCII near 4; /3 is the conservative middle.
function estimateTokens(requestBody) {
  let chars = 0;
  for (const message of Array.isArray(requestBody?.messages) ? requestBody.messages : []) {
    const content = message?.content;
    if (typeof content === 'string') chars += content.length;
    else if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block?.text === 'string') chars += block.text.length;
        else if (block?.input !== undefined) chars += JSON.stringify(block.input).length;
      }
    }
  }
  if (typeof requestBody?.system === 'string') chars += requestBody.system.length;
  return Math.ceil(chars / 3);
}

/**
 * Two-phase deadline for one upstream call:
 *   - phase 1 (headers) is bounded by upstream.timeoutMs;
 *   - phase 2 (body / stream) is bounded by one overall wall-clock deadline,
 *     so a stalled stream cannot idle a request forever.
 * Every return path must call done() or the timer leaks.
 */
function headerPhaseSignal() {
  const controller = new AbortController();
  let timer = null;
  const arm = (ms, reason) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error(reason)), ms);
  };
  arm(cfg.upstream.timeoutMs, 'upstream header timeout');
  return {
    signal: controller.signal,
    // switch from the header deadline to the whole-stream deadline
    stream() {
      arm(cfg.upstream.timeoutMs, 'upstream stream timeout');
    },
    done() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
    abort(reason = 'client aborted') {
      controller.abort(new Error(reason));
    },
  };
}

/**
 * Copy the upstream body to the client honouring backpressure, and abort the
 * upstream read as soon as the client disconnects.
 */
async function pipeStream(upstream, res, onText, { signal, idleMs = cfg.limits.streamIdleTimeoutMs } = {}) {
  const reader = upstream.body?.getReader?.();
  if (!reader) return;
  const decoder = new TextDecoder();
  let idleTimer = null;
  const cancelReader = (reason) => {
    reader.cancel(reason).catch(() => {});
  };
  const onClose = () => cancelReader(new Error('client disconnected'));
  const onAbort = () => cancelReader(signal?.reason ?? new Error('upstream aborted'));
  res.on('close', onClose);
  signal?.addEventListener?.('abort', onAbort, { once: true });
  try {
    for (;;) {
      if (res.destroyed || res.writableEnded) break;
      const reading = reader.read();
      if (idleMs > 0) {
        idleTimer = setTimeout(() => onAbort(), idleMs);
        idleTimer.unref?.();
      }
      const { done, value } = await reading;
      if (idleTimer !== null) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (onText) onText(text);
      // false means the socket buffer is full: wait for drain, never buffer unbounded
      if (!res.write(Buffer.from(value))) {
        await new Promise((r) => {
          const finish = () => {
            res.off('drain', finish);
            res.off('close', finish);
            r();
          };
          res.on('drain', finish);
          res.on('close', finish);
        });
      }
    }
  } finally {
    if (idleTimer !== null) clearTimeout(idleTimer);
    res.off('close', onClose);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

async function handleMessages(req, res, url) {
  const started = Date.now();
  let requestBody;
  try {
    const raw = await readBody(req);
    requestBody = JSON.parse(raw.toString('utf8'));
  } catch (error) {
    if (error?.code === 'body_too_large') {
      apiError(res, 413, 'invalid_request_error', `request body exceeds ${cfg.limits.maxBodyBytes} bytes`);
      log({ route: 'messages', status: 413, ms: Date.now() - started, error: String(error.message) });
      return;
    }
    apiError(res, 400, 'invalid_request_error', 'request body is not valid JSON');
    log({ route: 'messages', status: 400, ms: Date.now() - started, error: String(error.message) });
    return;
  }

  const model = requestBody.model;
  const upstreamModel = cfg.modelMap[model] ?? model;
  const streaming = requestBody.stream === true;
  const approxTokens = estimateTokens(requestBody);
  if (directUpstream) {
    const direct = new AbortController();
    const onDirectClose = () => {
      if (!res.writableEnded) direct.abort(new Error('client aborted'));
    };
    res.on('close', onDirectClose);
    try {
      const { response, wbModel } = await directUpstream.open(requestBody, model, { signal: direct.signal });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        const message = `direct ${response.status}: ${String(detail).slice(0, 200)}`.replace(/[\r\n]+/gu, ' ');
        throw Object.assign(new Error(message), { status: response.status });
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
        const onClose = () => {
          reader.cancel(new Error('client disconnected')).catch(() => {});
        };
        const onAbort = () => {
          reader.cancel(direct.signal.reason ?? new Error('upstream aborted')).catch(() => {});
        };
        res.on('close', onClose);
        direct.signal.addEventListener('abort', onAbort, { once: true });
        const decoder = new TextDecoder();
        let pending = '';
        try {
          for (;;) {
            if (res.destroyed || res.writableEnded) break;
            const { done, value } = await reader.read();
            if (done) break;
            pending += decoder.decode(value, { stream: true });
            const boundary = pending.lastIndexOf('\n\n');
            if (boundary === -1) continue;
            const frame = translator.feed(pending.slice(0, boundary + 2));
            pending = pending.slice(boundary + 2);
            if (frame.length > 0 && !res.write(frame)) {
              await new Promise((r) => {
                res.once('drain', r);
                res.once('close', r);
              });
            }
          }
        } finally {
          res.off('close', onClose);
          direct.signal.removeEventListener('abort', onAbort);
        }
        if (pending.length > 0 && !res.destroyed) res.write(translator.feed(pending));
        if (!res.destroyed) res.write(translator.finish(null));
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
      if (direct.signal.aborted && res.destroyed) {
        res.off('close', onDirectClose);
        return;
      }
      log({ route: 'messages', mode: 'direct', model, status: 502, ms: Date.now() - started, error: String(error?.message ?? error).slice(0, 300), fallback: cfg.upstream.fallback !== false });
      // a failed direct attempt must not escape as an uncaught abort into the key path
      if (cfg.upstream.fallback === false || direct.signal.aborted) {
        if (!res.headersSent) apiError(res, 502, 'upstream_error', upstreamErrorMessage(error?.status, 'direct'));
        else res.end();
        return;
      }
    } finally {
      res.off('close', onDirectClose);
    }
  }
  const wbipcMaxInput = cfg.wbipc?.maxInputTokens ?? 20_000;
  const wbipcUsable = Boolean(upstreamWbipc) && Date.now() >= wbipcCooldownUntil && approxTokens <= wbipcMaxInput;
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
      if (cfg.upstream.fallback === false || /rpc timeout|handshake timeout/iu.test(String(error?.message ?? ''))) {
        apiError(res, 504, 'upstream_timeout', 'credit channel timed out');
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
          const detail = await call.response.text().catch(() => '');
          phase.done();
          apiError(res, call.response.status, 'upstream_error', upstreamErrorMessage(call.response.status, 'openai'));
          log({ route: 'messages', mode: 'openai', model, status: call.response.status, ms: Date.now() - started, error: String(detail).slice(0, 500) });
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
      if (attempt === null) {
        phase.done();
        apiError(res, 502, 'upstream_error', upstreamErrorMessage(502, 'openai'));
        log({ route: 'messages', mode: 'openai', model, status: 502, ms: Date.now() - started, error: 'no openai attempt completed' });
        return;
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
    phase.stream();

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      phase.done();
      apiError(res, response.status, 'upstream_error', upstreamErrorMessage(response.status, 'anthropic'));
      log({ route: 'messages', mode: 'anthropic', model, status: response.status, ms: Date.now() - started, error: String(detail).slice(0, 500), key: maskKey(key) });
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
    await pipeStream(
      response,
      res,
      (text) => {
        tail = (tail + text).slice(-4096);
        const matches = tail.match(/"usage":\{[^}]*\}/gu);
        if (matches && matches.length > 0) {
          try {
            usage = JSON.parse(`{${matches.at(-1)}}`).usage;
          } catch {
            /* partial frame; a later chunk will complete it */
          }
        }
      },
      { signal: phase.signal },
    );
    log({ route: 'messages', mode: 'anthropic', model, upstreamModel, stream: true, status: 200, ms: Date.now() - started, usage, key: maskKey(key) });
  } catch (error) {
    phase.done();
    if (res.headersSent) {
      res.end();
    } else {
      apiError(res, 502, 'proxy_error', 'proxy internal error; see the proxy log');
    }
    log({ route: 'messages', model, status: 502, ms: Date.now() - started, error: String(error?.message ?? error).slice(0, 300) });
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
    log({ route: 'count_tokens', status: 502, error: String(error?.message ?? error).slice(0, 300) });
    apiError(res, 502, 'proxy_error', 'token counting failed');
  }
}

// ---- cheap admission control: a global in-flight cap plus a per-IP token bucket ----
const inflight = { total: 0, perIp: new Map() };
const buckets = new Map();

function clientIp(req) {
  const remote = req.socket?.remoteAddress ?? 'unknown';
  // a loopback peer is a single client regardless of v4/v6 notation
  return remote === '::1' || remote === '::ffff:127.0.0.1' ? '127.0.0.1' : remote;
}

function allowRequest(ip, now = Date.now()) {
  const perMinute = cfg.limits.rateLimitPerMinute;
  const burst = Math.max(1, cfg.limits.rateLimitBurst);
  if (!(perMinute > 0)) return true;
  let bucket = buckets.get(ip);
  if (!bucket) {
    bucket = { tokens: burst, last: now };
    buckets.set(ip, bucket);
  }
  bucket.tokens = Math.min(burst, bucket.tokens + ((now - bucket.last) / 60_000) * perMinute);
  bucket.last = now;
  if (buckets.size > 4096) {
    for (const [key, value] of buckets) if (now - value.last > 600_000) buckets.delete(key);
  }
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

/** Reserve a concurrency slot; returns null when the proxy is saturated. */
function acquireSlot(ip) {
  if (inflight.total >= cfg.limits.maxConcurrent) return null;
  if ((inflight.perIp.get(ip) ?? 0) >= cfg.limits.maxConcurrent) return null;
  inflight.total += 1;
  inflight.perIp.set(ip, (inflight.perIp.get(ip) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    inflight.total -= 1;
    const left = (inflight.perIp.get(ip) ?? 1) - 1;
    if (left <= 0) inflight.perIp.delete(ip);
    else inflight.perIp.set(ip, left);
  };
}

async function route(req, res) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);

  // unauthenticated liveness probe: reachability only, no upstream/topology disclosure
  if (req.method === 'GET' && (url.pathname === '/healthz' || url.pathname === '/health')) {
    sendJSON(res, 200, { ok: true });
    return;
  }

  // diagnostics (upstream type, model catalog, key count) require the proxy token
  if (req.method === 'GET' && url.pathname === '/healthz/details') {
    if (!authorized(req)) {
      apiError(res, 401, 'authentication_error', 'invalid proxy token');
      return;
    }
    sendJSON(res, 200, {
      ok: true,
      upstream: { type: cfg.upstream.type, keys: keys.length },
      models: MODELS.map((m) => m.id),
      credit: { mode: cfg.upstream.mode ?? 'http', wbipcCoolingDown: Date.now() < wbipcCooldownUntil },
      log: { enabled: Boolean(cfg.log.enabled) },
    });
    return;
  }

  if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
    if (!authorized(req)) {
      apiError(res, 401, 'authentication_error', 'invalid proxy token');
      return;
    }
    sendJSON(res, 200, { object: 'list', data: MODELS });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/messages') {
    if (!authorized(req)) {
      apiError(res, 401, 'authentication_error', 'invalid proxy token');
      return;
    }
    // Credit paths (direct / wbipc) need no API key: only the key-based http path does.
    // In direct/wbipc mode the key path is a fallback, so a missing key must not block the route.
    const creditPath = cfg.upstream.type !== 'http' && Boolean(directUpstream || upstreamWbipc);
    if (keys.length === 0 && !creditPath) {
      apiError(
        res,
        500,
        'configuration_error',
        'no upstream configured: set upstream.apiKey / WB_DEEPSEEK_KEY, or enable the direct / wbipc credit channel',
      );
      return;
    }
    const ip = clientIp(req);
    if (!allowRequest(ip)) {
      apiError(res, 429, 'rate_limit_error', 'too many requests', { 'retry-after': '1' });
      return;
    }
    const release = acquireSlot(ip);
    if (release === null) {
      apiError(res, 429, 'rate_limit_error', 'proxy is at its concurrency limit', { 'retry-after': '1' });
      return;
    }
    // the slot is held for as long as the response lives, stream included
    res.on('close', release);
    await handleMessages(req, res, url);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/messages/count_tokens') {
    if (!authorized(req)) {
      apiError(res, 401, 'authentication_error', 'invalid proxy token');
      return;
    }
    await handleCountTokens(req, res, url);
    return;
  }

  apiError(res, 404, 'not_found_error', `no route for ${req.method} ${url.pathname}`);
}

// Last line of defence: never let a rejected handler become an unhandledRejection
// (which kills the process). Any throw past this point still answers JSON.
const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    try {
      log({ route: 'handler', status: 500, method: req.method, path: req.url, error: String(error?.message ?? error).slice(0, 300) });
      if (!res.headersSent && !res.writableEnded) {
        apiError(res, 500, 'internal_error', 'proxy handler failed');
      } else if (!res.writableEnded) {
        res.end();
      }
    } catch {
      /* the socket is already gone */
    }
  });
});

process.on('unhandledRejection', (reason) => {
  try {
    log({ route: 'process', event: 'unhandledRejection', error: String(reason?.message ?? reason).slice(0, 300) });
    process.stderr.write(`[wb-proxy] unhandledRejection: ${String(reason?.message ?? reason)}\n`);
  } catch {
    /* logging must never break the process guard */
  }
});

// a token that nobody knows cannot be used: print the generated one exactly once, on stderr
if (tokenGenerated) {
  const notice = [
    '[wb-proxy] clientToken was missing from config: generated a random one for this run.',
    '[wb-proxy] set "clientToken" in config.json (or WB_CLIENT_TOKEN) to a fixed value for DSH.',
    `[wb-proxy] token: ${cfg.clientToken}`,
    '',
  ].join('\n');
  // fs.writeSync on fd 2 is synchronous and works even when stdio is a closed pipe
  try {
    writeSync(2, notice);
  } catch {
    process.stdout.write(notice);
  }
}

// requestTimeout bounds a whole request (headers + body + handler); a stalled
// stream is caught by the per-stream deadline instead, so keep it long enough
// for a long generation but never infinite.
server.requestTimeout = 300_000;
server.headersTimeout = 60_000;
server.listen(cfg.listen.port, cfg.listen.host, () => {
  const where = `http://${cfg.listen.host}:${cfg.listen.port}`;
  process.stdout.write(
    [
      'wb-deepseek-proxy up',
      `  listen    ${where}`,
      `  upstream  mode=${cfg.upstream.mode ?? 'http'} type=${cfg.upstream.type}`,
      `  keys      ${keys.length}`,
      '  auth      x-api-key required (config.json clientToken or WB_CLIENT_TOKEN)',
      `  health    ${where}/healthz   (details: /healthz/details with token)`,
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

