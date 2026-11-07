/** (module notes moved to README) */
import net from 'node:net';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function encodeTranscript(side, { protocol, endpoint, clientNonce, serverNonce }) {
  const parts = [side === 'server' ? 'wbipc-s' : 'wbipc-c', String(protocol), endpoint, clientNonce, serverNonce];
  const chunks = [];
  for (const part of parts) {
    const bytes = Buffer.from(part, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(bytes.length, 0);
    chunks.push(len, bytes);
  }
  return Buffer.concat(chunks);
}

const proof = (ticket, side, transcript) =>
  b64url(crypto.createHmac('sha256', Buffer.from(ticket, 'utf8')).update(encodeTranscript(side, transcript)).digest());

const ticketId = (ticket) => crypto.createHash('sha256').update(ticket, 'utf8').digest('hex').slice(0, 16);

export function readEndpoint(configDir = join(homedir(), '.workbuddy')) {
  return JSON.parse(readFileSync(join(configDir, 'wbipc', 'endpoint.json'), 'utf8'));
}

export class WbipcClient {
  constructor({ endpoint, ticket, log = () => {} }) {
    this.endpoint = endpoint;
    this.ticket = ticket;
    this.log = log;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
    this.pipes = [];
    this.epoch = null;
    this.channels = new Map();
  }

  send(frame) {
    this.socket.write(`${JSON.stringify(frame)}\n`, 'utf8');
  }

  handleFrame(frame) {
    if (frame.type === 'session_hello_error') {
      this.fail(new Error(`handshake rejected: ${frame.code ?? JSON.stringify(frame)}`));
      return;
    }
    if (frame.type === 'session_challenge') {
      const transcript = {
        protocol: frame.protocol,
        endpoint: this.endpoint,
        clientNonce: this.clientNonce,
        serverNonce: frame.server_nonce,
      };
      const expected = proof(this.ticket, 'server', transcript);
      if (expected !== frame.server_proof) {
        this.fail(new Error('server failed to prove ticket possession'));
        return;
      }
      this.send({ type: 'session_prove', client_proof: proof(this.ticket, 'client', transcript) });
      return;
    }
    if (frame.type === 'session_hello_ack') {
      this.epoch = frame.connection_epoch;
      this.pipes = frame.pipes ?? [];
      this.maxInflight = frame.max_inflight;
      this.log(`session ready epoch=${this.epoch} pipes=${JSON.stringify(this.pipes)}`);
      this.onReady?.();
      return;
    }
    if (frame.id !== undefined && this.pending.has(frame.id)) {
      const { resolve, reject, timer } = this.pending.get(frame.id);
      this.pending.delete(frame.id);
      clearTimeout(timer);
      if (frame.error) reject(Object.assign(new Error(frame.error.message ?? 'rpc error'), { data: frame.error }));
      else resolve(frame.result);
      return;
    }
    if (frame.type) this.log(`event: ${JSON.stringify(frame).slice(0, 200)}`);
  }

  fail(error) {
    this.error = error;
    this.onReady?.();
  }

  connect(timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
      const socket = net.connect(this.endpoint);
      this.socket = socket;
      const timer = setTimeout(() => reject(new Error('handshake timeout')), timeoutMs);

      socket.on('connect', () => {
        this.clientNonce = crypto.randomBytes(16).toString('base64url');
        this.send({
          type: 'session_hello',
          protocol_min: 1,
          protocol_max: 1,
          client_nonce: this.clientNonce,
          ticket_id: ticketId(this.ticket),
          client: { kind: 'dsh-proxy', id: 'wb-deepseek-proxy', version: '1.0.0' },
        });
      });

      socket.on('data', (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        for (;;) {
          const nl = this.buffer.indexOf(10);
          if (nl < 0) break;
          const line = this.buffer.subarray(0, nl);
          this.buffer = this.buffer.subarray(nl + 1);
          if (line.length === 0) continue;
          let frame;
          try {
            frame = JSON.parse(line.toString('utf8'));
          } catch {
            continue;
          }
          this.handleFrame(frame);
        }
      });

      socket.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });

      this.onReady = () => {
        clearTimeout(timer);
        if (this.error) reject(this.error);
        else resolve(this);
      };
    });
  }

  rpc(method, params = {}, { timeoutMs = 60000, mode } = {}) {
    const id = this.nextId++;
    const frame = { jsonrpc: '2.0', id, method, params };
    if (mode) frame.mode = mode;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`rpc timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send(frame);
    });
  }

  async openPipe(name) {
    if (this.channels.has(name)) return this.channels.get(name);
    const result = await this.rpc('broker/GetPipe', { pipe: name });
    this.channels.set(name, result);
    return result;
  }

  /** Send one HTTP request through the wb.request channel using WorkBuddy's login state. */
  async httpFetch({ method = 'GET', path, query, headers = {}, body }, { timeoutMs = 55000 } = {}) {
    const channel = await this.openPipe('wb.request');
    const params = { method, path, headers };
    if (query) params.query = query;
    if (body !== undefined) params.body_b64 = Buffer.from(body).toString('base64');
    const result = await this.rpc(`${channel.channel}/http.fetch`, params, { timeoutMs, mode: 'call' });
    return {
      status: result.status,
      headers: result.headers,
      body: result.body_b64 ? Buffer.from(result.body_b64, 'base64') : Buffer.alloc(0),
    };
  }

  close() {
    this.socket?.destroy();
  }
}
