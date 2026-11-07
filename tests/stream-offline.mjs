#!/usr/bin/env node
/**
 * stream-offline.mjs - dependency-free unit tests for the stream/resource paths
 * that a live smoke cannot reach deterministically.
 *
 *   1. StreamTranslator.finish() on a stream whose first frame is [DONE] still
 *      emits a complete message_start / message_delta / message_stop sequence
 *   2. sseToMessage() rejects out-of-range content block indexes and keeps
 *      sparse blocks ordered
 *   3. DirectUpstream queue timeout / abort and bounded token-scan output
 *
 * Usage: node tests/stream-offline.mjs
 */
import assert from 'node:assert/strict';

import { StreamTranslator } from '../src/openai-bridge.mjs';
import { sseToMessage } from '../src/wbipc-upstream.mjs';
import { DirectUpstream } from '../src/direct-upstream.mjs';

const failures = [];

async function check(name, fn) {
  try {
    const detail = await fn();
    console.log('  OK   ' + name + (detail ? '  (' + detail + ')' : ''));
  } catch (error) {
    failures.push(name);
    console.log('  FAIL ' + name + '  ' + (error?.message ?? error));
  }
}

/** Every event frame of an Anthropic SSE string, parsed. */
function events(sse) {
  return sse
    .split('\n\n')
    .map((block) =>
      block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join(''),
    )
    .filter(Boolean)
    .map((data) => JSON.parse(data));
}

console.log('wb-proxy stream offline tests');

await check('finish(): first frame is [DONE] still yields a full message', () => {
  const translator = new StreamTranslator('deepseek-flash');
  const out = translator.feed('data: [DONE]\n\n');
  const parsed = events(out);
  const types = parsed.map((e) => e.type);
  assert.deepEqual(types, ['message_start', 'message_delta', 'message_stop'], 'event order: ' + types.join(','));
  assert.equal(parsed[0].message.id.startsWith('msg_'), true);
  assert.equal(parsed[1].delta.stop_reason, 'end_turn');
  return types.join(' -> ');
});

await check('finish(): first frame [DONE] then a second finish() is a no-op', () => {
  const translator = new StreamTranslator('m');
  const first = translator.feed('data: [DONE]\n\n');
  const second = translator.finish(null);
  assert.equal(second, '');
  assert.deepEqual(
    events(first).map((e) => e.type),
    ['message_start', 'message_delta', 'message_stop'],
  );
  return 'no duplicate frames';
});

await check('finish(): empty stream still closes cleanly', () => {
  const translator = new StreamTranslator('m');
  const parsed = events(translator.finish('length'));
  assert.deepEqual(
    parsed.map((e) => e.type),
    ['message_start', 'message_delta', 'message_stop'],
  );
  assert.equal(parsed[1].delta.stop_reason, 'max_tokens');
  return 'max_tokens';
});

await check('feed(): text deltas then finish() produces one text block', () => {
  const translator = new StreamTranslator('m');
  const out =
    translator.feed('data: {"choices":[{"delta":{"content":"hel"}}]}\n\n') +
    translator.feed('data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n');
  const types = events(out).map((e) => e.type);
  assert.deepEqual(types, [
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_delta',
    'content_block_stop',
    'message_delta',
    'message_stop',
  ]);
  return types.length + ' frames';
});

await check('sseToMessage(): out-of-range indexes are dropped, order preserved', () => {
  const frames = [
    { type: 'message_start', message: { usage: { input_tokens: 7 } } },
    { type: 'content_block_start', index: 2000, content_block: { type: 'text', text: 'nope' } },
    { type: 'content_block_start', index: 2, content_block: { type: 'text', text: 'b' } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'a' } },
    { type: 'content_block_delta', index: -1, delta: { type: 'text_delta', text: 'nope' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: '!' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
  ];
  const sse = frames.map((f) => 'event: ' + f.type + '\ndata: ' + JSON.stringify(f) + '\n\n').join('');
  const message = sseToMessage(sse, 'm');
  assert.equal(message.content.length, 2);
  assert.equal(message.content[0].text, 'a');
  assert.equal(message.content[1].text, 'b!');
  assert.equal(message.usage.input_tokens, 7);
  assert.equal(message.usage.output_tokens, 3);
  return message.content.map((b) => b.text).join('|');
});

await check('sseToMessage(): hostile sparse frame set collapses to one text block', () => {
  const frames = [
    { type: 'content_block_start', index: 1023, content_block: { type: 'text', text: 'x' } },
    { type: 'content_block_start', index: 1e9, content_block: { type: 'text', text: 'y' } },
    { type: 'content_block_delta', index: '2', delta: { type: 'text_delta', text: 'z' } },
  ];
  const sse = frames.map((f) => 'data: ' + JSON.stringify(f) + '\n\n').join('');
  const message = sseToMessage(sse, 'm');
  assert.equal(message.content.length, 2);
  assert.equal(message.content[0].text, 'z');
  assert.equal(message.content[1].text, 'x');
  return 'index 1e9 dropped, order 2 < 1023';
});

await check('DirectUpstream.acquire(): queue timeout rejects instead of hanging', async () => {
  const upstream = new DirectUpstream({ maxConcurrent: 1, queueTimeoutMs: 60 });
  const release = await upstream.acquire();
  const started = Date.now();
  await assert.rejects(() => upstream.acquire(), /queue timeout/iu);
  release();
  assert.ok(Date.now() - started < 2000);
  return 'rejected in ' + (Date.now() - started) + 'ms';
});

await check('DirectUpstream.acquire(): an aborted waiter leaves the queue', async () => {
  const upstream = new DirectUpstream({ maxConcurrent: 1, queueTimeoutMs: 5000 });
  const release = await upstream.acquire();
  const controller = new AbortController();
  const pending = upstream.acquire(controller.signal);
  controller.abort();
  await assert.rejects(() => pending);
  assert.equal(upstream.queue.length, 0);
  release();
  return 'queue drained';
});

await check('DirectUpstream.refresh(): failure path settles once and clears state', async () => {
  const upstream = new DirectUpstream({ scanScript: 'definitely-missing-scan-token.ps1', refreshTimeoutMs: 5000 });
  upstream.readToken = () => null;
  await assert.rejects(() => upstream.refresh());
  assert.equal(upstream.refreshing, null);
  return 'refreshing reset';
});

if (failures.length === 0) {
  console.log('\nall offline stream checks passed');
  process.exit(0);
}
console.log('\n' + failures.length + ' check(s) failed: ' + failures.join(', '));
process.exit(1);
