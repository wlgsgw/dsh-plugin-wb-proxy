/**
 * OpenAI Chat Completions  <->  Anthropic Messages translation layer.
 *
 * Used only when config.upstream.type === "openai" (a relay that speaks
 * /chat/completions only). The native DeepSeek endpoint already speaks
 * Anthropic Messages, so the default deployment path is a pure passthrough.
 *
 * Deliberate limits:
 *  - `thinking` / reasoning deltas are dropped: an OpenAI relay cannot supply
 *    the Anthropic `signature` that DSH needs to replay a thinking block in a
 *    later turn, and an unsigned block breaks the next request.
 *  - `tool_addition` / `tool_removal` beta blocks are dropped (they only exist
 *    in the Anthropic-native path).
 */

const FINISH_TO_STOP = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  content_filter: 'end_turn',
};

function asBlocks(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content.filter((b) => b && typeof b === 'object') : [];
}

function imageURL(source) {
  if (!source) return '';
  if (source.type === 'base64') return `data:${source.media_type || 'image/png'};base64,${source.data}`;
  if (source.type === 'url') return source.url;
  return '';
}

/** Anthropic Messages request body -> OpenAI Chat Completions request body. */
export function toOpenAIRequest(body, model) {
  const messages = [];

  const system = [];
  if (typeof body.system === 'string') system.push(body.system);
  else for (const b of asBlocks(body.system)) if (b.type === 'text') system.push(b.text);
  if (system.length > 0) messages.push({ role: 'system', content: system.join('\n\n') });

  for (const message of body.messages ?? []) {
    const blocks = asBlocks(message.content);

    if (message.role === 'assistant') {
      const texts = [];
      const toolCalls = [];
      for (const block of blocks) {
        if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
        else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
          });
        }
      }
      const out = { role: 'assistant', content: texts.length > 0 ? texts.join('') : null };
      if (toolCalls.length > 0) out.tool_calls = toolCalls;
      if (out.content === null && !out.tool_calls) out.content = '';
      messages.push(out);
      continue;
    }

    // user turn: tool_result blocks become OpenAI `tool` messages and must
    // directly follow the assistant turn that requested them.
    const parts = [];
    for (const block of blocks) {
      if (block.type === 'tool_result') {
        const text = asBlocks(block.content)
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n');
        messages.push({ role: 'tool', tool_call_id: block.tool_use_id, content: text || '' });
      } else if (block.type === 'text' && typeof block.text === 'string') {
        parts.push({ type: 'text', text: block.text });
      } else if (block.type === 'image') {
        const url = imageURL(block.source);
        if (url) parts.push({ type: 'image_url', image_url: { url } });
      }
    }
    if (parts.length === 1 && parts[0].type === 'text') messages.push({ role: 'user', content: parts[0].text });
    else if (parts.length > 0) messages.push({ role: 'user', content: parts });
  }

  const out = {
    model,
    messages,
    stream: body.stream === true,
  };
  if (body.max_tokens !== undefined) out.max_tokens = body.max_tokens;
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) out.stop = body.stop_sequences;

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    out.tools = body.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description ?? '',
        parameters: tool.input_schema ?? { type: 'object', properties: {} },
      },
    }));
    const choice = body.tool_choice;
    if (choice?.type === 'any') out.tool_choice = 'required';
    else if (choice?.type === 'tool' && choice.name) out.tool_choice = { type: 'function', function: { name: choice.name } };
    else if (choice?.type === 'auto') out.tool_choice = 'auto';
    else if (choice?.type === 'none') out.tool_choice = 'none';
  }

  if (out.stream) out.stream_options = { include_usage: true };
  return out;
}

/** OpenAI Chat Completions response -> Anthropic Messages response. */
export function toAnthropicResponse(json, model) {
  const choice = json?.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const content = [];

  if (typeof message.content === 'string' && message.content.length > 0) {
    content.push({ type: 'text', text: message.content });
  }
  for (const call of message.tool_calls ?? []) {
    let input = {};
    try {
      input = JSON.parse(call.function?.arguments ?? '{}');
    } catch {
      input = {};
    }
    content.push({ type: 'tool_use', id: call.id, name: call.function?.name, input });
  }
  if (content.length === 0) content.push({ type: 'text', text: '' });

  return {
    id: json?.id?.startsWith?.('msg_') ? json.id : `msg_${json?.id ?? crypto.randomUUID()}`,
    type: 'message',
    role: 'assistant',
    model: json?.model ?? model,
    content,
    stop_reason: FINISH_TO_STOP[choice.finish_reason] ?? 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: json?.usage?.prompt_tokens ?? 0,
      output_tokens: json?.usage?.completion_tokens ?? 0,
    },
  };
}

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/**
 * Incremental OpenAI SSE -> Anthropic SSE translator.
 * Feed it raw decoded strings; it returns the Anthropic frames to write.
 */
export class StreamTranslator {
  constructor(model) {
    this.model = model;
    this.messageId = `msg_${crypto.randomUUID().replaceAll('-', '')}`;
    this.started = false;
    this.finished = false;
    this.index = -1;
    this.current = null; // { kind: 'text' | 'tool', index }
    this.toolSlots = new Map(); // openai tool index -> anthropic block index
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.buffer = '';
  }

  start() {
    this.started = true;
    return sse('message_start', {
      type: 'message_start',
      message: {
        id: this.messageId,
        type: 'message',
        role: 'assistant',
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  openText() {
    if (this.current?.kind === 'text') return '';
    const close = this.closeCurrent();
    this.index += 1;
    this.current = { kind: 'text', index: this.index };
    return close + sse('content_block_start', {
      type: 'content_block_start',
      index: this.index,
      content_block: { type: 'text', text: '' },
    });
  }

  openTool(slot, id, name) {
    if (this.toolSlots.has(slot)) return '';
    const close = this.closeCurrent();
    this.index += 1;
    this.toolSlots.set(slot, this.index);
    this.current = { kind: 'tool', index: this.index };
    return close + sse('content_block_start', {
      type: 'content_block_start',
      index: this.index,
      content_block: { type: 'tool_use', id: id ?? `toolu_${crypto.randomUUID().replaceAll('-', '')}`, name: name ?? '', input: {} },
    });
  }

  closeCurrent() {
    if (this.current === null) return '';
    const frame = sse('content_block_stop', { type: 'content_block_stop', index: this.current.index });
    this.current = null;
    return frame;
  }

  /** @param raw decoded SSE text from the OpenAI stream */
  feed(raw) {
    let out = '';
    this.buffer += raw;
    let boundary;
    while ((boundary = this.buffer.indexOf('\n\n')) !== -1) {
      const frame = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      out += this.frame(frame);
    }
    return out;
  }

  frame(frame) {
    const dataLines = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim());
    if (dataLines.length === 0) return '';
    const payload = dataLines.join('\n');
    if (payload === '[DONE]') return this.finish(null);

    let json;
    try {
      json = JSON.parse(payload);
    } catch {
      return '';
    }
    let out = '';
    if (!this.started) out += this.start();

    if (json.usage) {
      this.inputTokens = json.usage.prompt_tokens ?? this.inputTokens;
      this.outputTokens = json.usage.completion_tokens ?? this.outputTokens;
    }

    const choice = json.choices?.[0];
    if (!choice) return out;

    const delta = choice.delta ?? {};
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      out += this.openText();
      out += sse('content_block_delta', {
        type: 'content_block_delta',
        index: this.current.index,
        delta: { type: 'text_delta', text: delta.content },
      });
    }

    for (const call of delta.tool_calls ?? []) {
      const slot = call.index ?? 0;
      out += this.openTool(slot, call.id, call.function?.name);
      const args = call.function?.arguments;
      if (typeof args === 'string' && args.length > 0) {
        out += sse('content_block_delta', {
          type: 'content_block_delta',
          index: this.toolSlots.get(slot),
          delta: { type: 'input_json_delta', partial_json: args },
        });
      }
    }

    if (choice.finish_reason) out += this.finish(choice.finish_reason);
    return out;
  }

  finish(reason) {
    if (this.finished) return '';
    if (!this.started) return this.start() + this.finish(reason);
    this.finished = true;
    let out = this.closeCurrent();
    out += sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: FINISH_TO_STOP[reason] ?? 'end_turn', stop_sequence: null },
      usage: { input_tokens: this.inputTokens, output_tokens: this.outputTokens },
    });
    out += sse('message_stop', { type: 'message_stop' });
    return out;
  }
}
