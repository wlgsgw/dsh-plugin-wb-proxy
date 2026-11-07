/**
 * Empty-stream guard: when the upstream returns 200 but emits zero content deltas,
 * retry once at the proxy layer so DSH never sees a hollow answer.
 *
 * Exports `isEmptyCompletion(sse, mode)` and `withEmptyRetry(fn, opts)`.
 */

/** Does an Anthropic SSE body carry any real content (text or tool_use)? */
export function isEmptyAnthropicSse(text) {
  if (typeof text !== 'string' || text.length === 0) return true;
  if (/"text_delta","text":"[^"]+"/u.test(text)) return false;
  if (/"input_json_delta"/u.test(text)) return false;
  if (/"tool_use"/u.test(text)) return false;
  const plain = [...text.matchAll(/"type":"text","text":"([^"]*)"/gu)].map((m) => m[1]).join('');
  return plain.trim().length === 0;
}

/** Does an OpenAI-shaped JSON body carry any content? */
export function isEmptyOpenAIJson(json) {
  const choice = json?.choices?.[0];
  if (!choice) return true;
  const message = choice.message ?? choice.delta ?? {};
  const hasText = typeof message.content === 'string' && message.content.trim().length > 0;
  const hasTools = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
  return !hasText && !hasTools;
}

/**
 * Run `attempt()`; if the result is empty and retries remain, run it again.
 * @param {() => Promise<{ empty: boolean, value: any }>} attempt
 * @param {{ retries?: number, onRetry?: (n: number, detail: any) => void }} options
 */
export async function withEmptyRetry(attempt, { retries = 1, onRetry } = {}) {
  let last;
  for (let attemptIndex = 0; attemptIndex <= retries; attemptIndex += 1) {
    last = await attempt(attemptIndex);
    if (!last.empty) return { ...last, attempts: attemptIndex + 1 };
    if (attemptIndex < retries) onRetry?.(attemptIndex + 1, last);
  }
  return { ...last, attempts: retries + 1 };
}
