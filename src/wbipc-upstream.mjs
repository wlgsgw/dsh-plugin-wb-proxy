/** (module notes: see README) */
import { WbipcClient, readEndpoint } from './wbipc-client.mjs';
import { StreamTranslator, toOpenAIRequest } from './openai-bridge.mjs';

export class WbipcUpstream {
  constructor({ configDir, path = '/v2/chat/completions', modelMap = {}, requestTimeoutMs = 52000 } = {}) {
    this.configDir = configDir;
    this.path = path;
    this.modelMap = modelMap;
    this.requestTimeoutMs = requestTimeoutMs;
    this.client = null;
  }

  async ensure() {
    if (this.client && this.client.socket && !this.client.socket.destroyed) return this.client;
    const { endpoint, ticket } = readEndpoint(this.configDir);
    const client = new WbipcClient({ endpoint, ticket, log: () => {} });
    await client.connect();
    this.client = client;
    return client;
  }

  /** Translate an Anthropic request into a WorkBuddy chat completion, and stream back Anthropic SSE. */
  async complete(anthropicBody, model) {
    const wbModel = this.modelMap[model] ?? model;
    const payload = toOpenAIRequest({ ...anthropicBody, model: wbModel }, wbModel);
    payload.stream = true;

    const client = await this.ensure();
    const response = await client.httpFetch(
      {
        method: 'POST',
        path: this.path,
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(payload),
      },
      { timeoutMs: this.requestTimeoutMs },
    );

    const text = response.body.toString('utf8');
    if (response.status !== 200) {
      const error = new Error(`wbipc upstream ${response.status}: ${text.slice(0, 300)}`);
      error.status = response.status;
      error.body = text;
      throw error;
    }

    const translator = new StreamTranslator(model);
    let out = translator.feed(text);
    out += translator.finish(null);
    return { sse: out, usage: { input_tokens: translator.inputTokens, output_tokens: translator.outputTokens }, wbModel };
  }
}

/** Parse an Anthropic SSE stream into one Anthropic message JSON (for non-streaming calls). */
export function sseToMessage(sseText, model) {
  const content = [];
  let stopReason = 'end_turn';
  let usage = { input_tokens: 0, output_tokens: 0 };

  for (const block of sseText.split('\n\n')) {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('');
    if (!data) continue;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    if (event.type === 'content_block_start') content[event.index] = { ...event.content_block };
    if (event.type === 'content_block_delta') {
      const slot = content[event.index] ?? {};
      if (event.delta.type === 'text_delta') slot.text = (slot.text ?? '') + event.delta.text;
      if (event.delta.type === 'input_json_delta') slot._json = (slot._json ?? '') + event.delta.partial_json;
      content[event.index] = slot;
    }
    if (event.type === 'message_delta') {
      stopReason = event.delta?.stop_reason ?? stopReason;
      if (event.usage) usage = { input_tokens: usage.input_tokens, output_tokens: event.usage.output_tokens ?? 0 };
    }
    if (event.type === 'message_start' && event.message?.usage) usage.input_tokens = event.message.usage.input_tokens ?? 0;
  }

  const blocks = content.filter(Boolean).map((block) => {
    if (block.type === 'tool_use') {
      let input = {};
      try {
        input = block._json ? JSON.parse(block._json) : {};
      } catch {
        input = {};
      }
      return { type: 'tool_use', id: block.id, name: block.name, input };
    }
    return { type: 'text', text: block.text ?? '' };
  });
  if (blocks.length === 0) blocks.push({ type: 'text', text: '' });

  return {
    id: `msg_${Date.now().toString(36)}`,
    type: 'message',
    role: 'assistant',
    model,
    content: blocks,
    stop_reason: stopReason,
    stop_sequence: null,
    usage,
  };
}
