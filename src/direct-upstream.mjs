/**
 * Direct credit upstream: OIDC access token read from the WorkBuddy process, HTTPS
 * straight to copilot.tencent.com. Real streaming, no 50s / 640KB broker caps.
 * Token source: scan-token.ps1 -> logs/token.json, rescanned on expiry / account
 * switch / 401. Two channel adaptations: system-prompt sanitizing, and official
 * channel headers (X-Agent-Purpose / X-Conversation-* / X-IDE-*).
 */
import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toOpenAIRequest } from './openai-bridge.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** (notes: see README) */
export function sanitizeSystem(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  return text
    .replace(/DeepSeek Harness/gu, 'this harness')
    .replace(/(explicitly referenced\.)[ \t]+(Relative paths)/gu, '$1\n$2');
}

export function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  const first = messages[0];
  if (first && first.role === 'system' && typeof first.content === 'string') {
    return [{ ...first, content: sanitizeSystem(first.content) }, ...messages.slice(1)];
  }
  return messages;
}

export class DirectUpstream {
  constructor({
    baseURL = 'https://copilot.tencent.com',
    path = '/v2/chat/completions',
    tokenFile = join(HERE, '..', 'logs', 'token.json'),
    scanScript = join(HERE, 'scan-token.ps1'),
    modelMap = {},
    refreshSkewSeconds = 300,
    maxConcurrent = 3,
    extraHeaders = {},
    refreshTimeoutMs = 30_000,
    refreshMaxOutput = 16 * 1024,
    queueTimeoutMs = 60_000,
  } = {}) {
    this.baseURL = baseURL.replace(/\/+$/u, '');
    this.path = path;
    this.tokenFile = resolve(tokenFile);
    this.scanScript = resolve(scanScript);
    this.modelMap = modelMap;
    this.refreshSkewSeconds = refreshSkewSeconds;
    this.refreshTimeoutMs = refreshTimeoutMs;
    this.refreshMaxOutput = refreshMaxOutput;
    this.queueTimeoutMs = queueTimeoutMs;
    this.extraHeaders = extraHeaders;
    this.refreshing = null;
    this.maxConcurrent = maxConcurrent;
    this.active = 0;
    this.queue = [];
  }

/** (notes: see README) */
  currentAccountUid() {
    const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
    const candidate = join(home, '.workbuddy', 'storage', 'skeleton', 'account-snapshot.json');
    if (!existsSync(candidate)) return null;
    try {
      const snapshot = JSON.parse(readFileSync(candidate, 'utf8').replace(/^\uFEFF/, ''));
      const uid = snapshot?.primary?.uid;
      return typeof uid === 'string' && uid ? uid : null;
    } catch {
      return null;
    }
  }

  readToken() {
    if (!existsSync(this.tokenFile)) return null;
    try {
      const record = JSON.parse(readFileSync(this.tokenFile, 'utf8').replace(/^\uFEFF/, ''));
      if (!record?.token) return null;
      const now = Date.now() / 1000;
      if (Number(record.exp) - this.refreshSkewSeconds <= now) return null;
      const uid = this.currentAccountUid();
      if (uid && record.sub && record.sub !== uid) return null;
      return record;
    } catch {
      return null;
    }
  }

  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = new Promise((resolvePromise, rejectPromise) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', this.scanScript], {
        windowsHide: true,
      });
      let output = '';
      let settled = false;
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.refreshing = null;
        fn(value);
      };
      const append = (chunk) => {
        // bounded capture: a chatty or hostile script must not grow the heap
        if (output.length >= this.refreshMaxOutput) return;
        output += String(chunk);
        if (output.length > this.refreshMaxOutput) output = output.slice(0, this.refreshMaxOutput);
      };
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        settle(rejectPromise, new Error(`token scan timed out after ${this.refreshTimeoutMs}ms`));
      }, this.refreshTimeoutMs);
      timer.unref?.();
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      child.on('error', (error) => settle(rejectPromise, error));
      child.on('close', (code) => {
        const record = this.readToken();
        if (record) settle(resolvePromise, record);
        else settle(rejectPromise, new Error(`token scan produced no usable token (exit ${code}): ${output.slice(-300)}`));
      });
    });
    return this.refreshing;
  }

  async token(force = false) {
    if (!force) {
      const cached = this.readToken();
      if (cached) return cached.token;
    }
    const record = await this.refresh();
    return record.token;
  }

  /** Take a concurrency slot; rejects instead of queueing forever when the pool stays saturated. */
  acquire(signal) {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return Promise.resolve(() => {
        this.active -= 1;
        this.drain();
      });
    }
    if (this.queueTimeoutMs <= 0) {
      return Promise.reject(new Error(`direct upstream saturated (${this.maxConcurrent} in flight)`));
    }
    return new Promise((resolvePromise, rejectPromise) => {
      const waiter = {
        grant: () => {
          cleanup();
          this.active += 1;
          resolvePromise(() => {
            this.active -= 1;
            this.drain();
          });
        },
        reject: () => {
          cleanup();
          rejectPromise(new Error(`direct upstream queue timeout after ${this.queueTimeoutMs}ms`));
        },
      };
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
        const at = this.queue.indexOf(waiter);
        if (at !== -1) this.queue.splice(at, 1);
      };
      const onAbort = () => {
        cleanup();
        rejectPromise(signal.reason ?? new Error('aborted'));
      };
      // deliberately not unref'd: a queued request must be released even when
      // it is the only thing keeping the event loop alive
      const timer = setTimeout(waiter.reject, this.queueTimeoutMs);
      signal?.addEventListener?.('abort', onAbort, { once: true });
      this.queue.push(waiter);
    });
  }

  drain() {
    while (this.queue.length > 0 && this.active < this.maxConcurrent) {
      this.queue.shift().grant();
    }
  }

/** (notes: see README) */
  async open(anthropicBody, model, { signal } = {}) {
    const wbModel = this.modelMap[model] ?? model;
    const payload = toOpenAIRequest({ ...anthropicBody, model: wbModel }, wbModel);
    payload.stream = true;
    payload.messages = sanitizeMessages(payload.messages);

    const conversationId = `wb-${process.pid}-${Math.floor(Date.now() / 60000).toString(36)}`;
    const reqId = randomUUID();
    const messageId = createHash('sha256')
      .update(JSON.stringify(payload.messages?.at(-1) ?? {}))
      .digest('hex')
      .slice(0, 32);

    const send = async (token) =>
      fetch(`${this.baseURL}${this.path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'x-domain': new URL(this.baseURL).host,
          'x-product': 'SaaS',
          'x-product-code': 'workbuddy',
          'x-agent-purpose': 'conversation',
          'x-agent-intent': 'craft',
          'x-ide-name': 'WorkBuddy',
          'x-ide-type': 'WorkBuddy',
          'x-ide-version': '5.9.3',
          'x-conversation-id': conversationId,
          'x-conversation-message-id': messageId,
          'x-conversation-request-id': reqId,
          'x-request-id': reqId,
          'x-session-id': conversationId,
          'x-model-id': wbModel,
          'user-agent': 'WorkBuddy/5.9.3 WorkBuddy/5.9.3 CLI/5.9.3',
          ...this.extraHeaders,
        },
        body: JSON.stringify(payload),
        signal,
      });

    const release = await this.acquire(signal);
    try {
      let response = await send(await this.token());
      if (response.status === 401) {
        response = await send(await this.token(true));
      } else if (response.status === 400) {
        const detail = await response.clone().text().catch(() => '');
        if (/"code"\s*:\s*11128|unapproved channel/i.test(detail)) {
          response = await send(await this.token(true));
        }
      }
      // the slot only guards the request until the response headers arrive;
      // streaming the body must not keep the pool blocked.
      release();
      return { response, wbModel };
    } catch (error) {
      release();
      throw error;
    }
  }
}
