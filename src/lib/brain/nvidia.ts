/**
 * NVIDIA LLM client — streaming chat completions via NVIDIA's integrate API.
 *
 * Uses raw fetch + SSE parsing so we don't need the openai SDK at runtime.
 *
 * Required env vars (set on Vercel):
 *   NVIDIA_API_KEY        — your NVIDIA build API key
 *
 * Gateway: https://integrate.api.nvidia.com/v1/chat/completions
 * Model:   nvidia/nemotron-3-ultra-550b-a55b (default) — 550B params (55B
 *          active via MoE), heavier than nemotron-3-super-120b but better
 *          for complex reasoning, multi-document synthesis, and long-form
 *          answers. Uses reasoning_effort:'low' to keep TTFB fast (~4s).
 *
 * Auto-continue on truncation:
 *   When the model returns `finish_reason: "length"` (hit max_tokens
 *   mid-generation), we automatically send another call with the partial
 *   output appended as an assistant message + a generic "continue from
 *   where you left off" user prompt, then concatenate. The user sees
 *   continuous streaming with no visible boundary between the original
 *   call and the continuation(s). Capped at `maxContinuations` (default 3).
 *
 * Retry / rate-handling (ported verbatim from rag-document-assistant):
 *   - Retryable HTTP statuses: 429, 500, 502, 503, 504
 *   - Retryable error codes: ECONNRESET, ETIMEDOUT, UND_ERR_CONNECT_TIMEOUT
 *   - Per-call timeout: 55s (under Vercel Hobby's 60s Node cap)
 */

const NVIDIA_GATEWAY = 'https://integrate.api.nvidia.com/v1/chat/completions';
const NVIDIA_DEFAULT_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b';
const NVIDIA_DEFAULT_TEMPERATURE = 0.3;
const NVIDIA_DEFAULT_TOP_P = 1.0;
// 8192 tokens ≈ 6K chars. This is the default for chat/RAG use cases where
// strict fidelity matters — the SYSTEM_PROMPT in chat/route.ts explicitly
// asks for "VERY LONG (up to 30000 chars)" answers, but with thin context
// (5000 chars of retrieved notes) the model will hallucinate to fill the
// gap. Capping max_tokens at 8192 acts as a natural brake: long enough for
// legitimate technical answers, short enough to prevent runaway fabrication.
// Callers that genuinely need longer output (e.g. document summarization)
// can override via opts.maxTokens + opts.maxContinuations.
const NVIDIA_DEFAULT_MAX_TOKENS = 8192;
const NVIDIA_DEFAULT_TIMEOUT_MS = 55_000;
// Default continuation rounds. 1 is enough for legitimate long technical
// answers (gives ~16K tokens of effective capacity). Higher values (3) are
// appropriate for translation/document-generation use cases where the input
// explicitly demands very long output. RAG callers should pass maxContinuations:1
// to prevent hallucination runaway when context is sparse.
const NVIDIA_DEFAULT_MAX_CONTINUATIONS = 1;

export interface ControlledStreamOptions {
  model?: string;
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  timeoutMs?: number;
  maxRetries?: number;
  /**
   * Max auto-continue rounds when the model returns finish_reason === 'length'.
   * Each round re-calls the model with the partial output appended as an
   * assistant message, asking it to continue. Default 3.
   *
   * Set to 0 to disable continuation (older behavior — output truncates
   * at max_tokens with no auto-resume).
   */
  maxContinuations?: number;
  /** Fired for every log line — surfaced to the LivePipelineLog panel in the UI. */
  onLog?: (line: string) => void;
  /** Fired for every content token as it arrives — appended to the chat bubble. */
  onChunk?: (text: string) => void;
}

export interface ControlledStreamResult {
  content: string;
  reasoning: string;
  model: string;
  elapsedMs: number;
  attempts: number;
  /** Number of continuation rounds that were triggered (0 if the model finished in one call). */
  continuations: number;
  /** True if the model exhausted all continuations and is STILL truncated. */
  truncated: boolean;
}

interface StreamOnceResult {
  content: string;
  reasoning: string;
  ttfbMs: number | null;
  /**
   * finish_reason from the model:
   *   'stop'       — model finished naturally (clean stop)
   *   'length'     — model hit max_tokens mid-generation (output truncated)
   *   'content_filter' / 'tool_calls' / undefined — other terminal states
   *
   * We use 'length' to trigger an auto-continue call so the user sees the
   * full output instead of a truncated response.
   */
  finishReason: string | null;
}

/**
 * Determines if an error is retryable (timeout, rate limit, or server error).
 * Ported verbatim from rag-document-assistant/src/lib/nvidia.ts.
 */
function isRetryableError(err: any): boolean {
  const status = err?.status || err?.statusCode || 0;
  if ([429, 500, 502, 503, 504].includes(status)) return true;
  if (['ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(err?.code)) return true;
  const errName: string = err?.constructor?.name || '';
  if (['APIConnectionError', 'APITimeoutError', 'ConnectionError'].includes(errName)) return true;
  const msg: string = (err?.message || '').toLowerCase();
  if (msg.includes('timeout') || msg.includes('rate limit') || msg.includes('too many requests') || msg.includes('econnreset')) return true;
  return false;
}

/**
 * Internal: stream + accumulate a single chat completion attempt.
 * Throws on timeout or HTTP error. The thrown error carries `.status`
 * so the caller's retry loop can decide retryability via isRetryableError.
 */
async function streamOnce(
  body: Record<string, unknown>,
  apiKey: string,
  signal: AbortSignal,
  onChunk?: (text: string) => void,
): Promise<StreamOnceResult> {
  const callStart = Date.now();
  const response = await fetch(NVIDIA_GATEWAY, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  });

  if (!response.ok) {
    const errText = await response.text();
    const err: any = new Error(
      `NVIDIA API error (${response.status}): ${errText.slice(0, 300)}`,
    );
    err.status = response.status;
    throw err;
  }
  if (!response.body) {
    throw new Error('NVIDIA API returned no response body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = '';
  let ttfbMs: number | null = null;
  let finishReason: string | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (ttfbMs === null) ttfbMs = Date.now() - callStart;

    buffer += decoder.decode(value, { stream: true });
    let nlIdx: number;
    while ((nlIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nlIdx).trim();
      buffer = buffer.slice(nlIdx + 1);
      if (!line || !line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') {
        // Nemotron-3 occasionally spends its entire token budget on
        // reasoning_content when max_tokens is too small. Fall back to
        // reasoning so the user still sees a result instead of an empty
        // string. The real fix is a large enough max_tokens (see
        // NVIDIA_DEFAULT_MAX_TOKENS above).
        if (!content && reasoning) {
          content = reasoning;
          onChunk?.(content);
        }
        return { content, reasoning, ttfbMs, finishReason };
      }
      try {
        const json = JSON.parse(data);
        const choice = json.choices?.[0];
        const delta = choice?.delta;
        if (delta) {
          if (typeof delta.content === 'string' && delta.content) {
            content += delta.content;
            onChunk?.(delta.content);
          }
          // Accumulate reasoning_content but do NOT stream it to the user.
          // Reasoning is the model's internal scratchpad (chain-of-thought,
          // self-debate, uncertainty hedging) — it should never be shown.
          // The user only sees the finished `content` (the actual answer).
          // If the model only produces reasoning (no content), we fall back
          // to using it AFTER the stream completes (see [DONE] handler below).
          if (typeof delta.reasoning_content === 'string') {
            reasoning += delta.reasoning_content;
          }
        }
        // Capture finish_reason as soon as it appears. NVIDIA's SSE stream
        // emits it on the final chunk BEFORE [DONE]. We need it to decide
        // whether to auto-continue (see nvidiaChatStreamControlled below).
        if (choice && typeof choice.finish_reason === 'string' && choice.finish_reason) {
          finishReason = choice.finish_reason;
        }
      } catch {
        // Partial JSON across chunks — ignore, will be retried on next read.
      }
    }
  }

  // Stream ended without an explicit [DONE]. Apply the same reasoning
  // fallback in case the model finished on a reasoning-only flush.
  if (!content && reasoning) {
    content = reasoning;
    onChunk?.(content);
  }
  return { content, reasoning, ttfbMs, finishReason };
}

// Generic continuation prompt used when the model returns finish_reason:'length'.
// This does NOT modify the caller's system/user prompts — it's a fixed
// instruction appended only when a continuation round is needed.
const CONTINUE_USER_PROMPT =
  'Continue your previous response from exactly where you left off. Do not repeat any text you have already produced. Do not add any preamble, acknowledgements, or summary — output only the continuation.';

/**
 * Streaming chat completion via NVIDIA's integrate API.
 *
 * - 55s per-call timeout (under Vercel Hobby's 60s Node cap)
 * - 1 attempt per call (caller can retry at the pipeline level)
 * - Streams chunks via onChunk callback
 * - Emits structured log lines via onLog callback
 * - Auto-continues when finish_reason === 'length' (up to maxContinuations rounds)
 * - Returns full content + reasoning + timing metadata
 *
 * Note: NVIDIA's Nemotron-3 models can emit both `delta.content` (the answer)
 * and `delta.reasoning_content` (chain-of-thought). We accumulate both but
 * only stream `content` to the user. If the model misbehaves and only
 * returns reasoning, we fall back to using reasoning as the content.
 */
export async function nvidiaChatStreamControlled(
  opts: ControlledStreamOptions,
): Promise<ControlledStreamResult> {
  const model = opts.model || NVIDIA_DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? NVIDIA_DEFAULT_TIMEOUT_MS;
  const maxRetries = opts.maxRetries ?? 1;
  const maxContinuations = opts.maxContinuations ?? NVIDIA_DEFAULT_MAX_CONTINUATIONS;
  const temperature = opts.temperature ?? NVIDIA_DEFAULT_TEMPERATURE;
  const topP = opts.topP ?? NVIDIA_DEFAULT_TOP_P;
  const maxTokens = opts.maxTokens ?? NVIDIA_DEFAULT_MAX_TOKENS;
  const callStart = Date.now();
  const apiKey = process.env.NVIDIA_API_KEY;

  if (!apiKey) {
    throw new Error(
      'NVIDIA_API_KEY env var is not set. Add it in Vercel → Project Settings → Environment Variables.',
    );
  }

  opts.onLog?.(
    `[nvidia] start  model=${model} max_tokens=${maxTokens} temp=${temperature} top_p=${topP} timeout=${timeoutMs}ms max_continuations=${maxContinuations}`,
  );

  // Accumulate across the original call + any continuation rounds.
  let fullContent = '';
  let fullReasoning = '';
  let lastTtfbMs: number | null = null;
  let attemptsUsed = 0;
  let continuations = 0;
  let stillTruncated = false;

  // The messages array may grow across continuation rounds: each round
  // appends the assistant's partial output + the generic continue prompt.
  let messages = opts.messages;

  for (let round = 0; round <= maxContinuations; round++) {
    let lastErr: Error | null = null;
    let roundResult: StreamOnceResult | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const result = await streamOnce(
          {
            model,
            messages,
            max_tokens: maxTokens,
            temperature,
            top_p: topP,
            reasoning_effort: 'low',
          },
          apiKey,
          controller.signal,
          opts.onChunk,
        );
        clearTimeout(timeout);
        attemptsUsed++;
        roundResult = result;
        lastTtfbMs = result.ttfbMs ?? lastTtfbMs;
        break;
      } catch (err: unknown) {
        clearTimeout(timeout);
        const e = err as Error;
        const elapsed = Date.now() - callStart;
        lastErr = e;
        if (e.name === 'AbortError') {
          opts.onLog?.(
            `[nvidia] TIMEOUT round=${round} attempt=${attempt} after ${timeoutMs}ms`,
          );
        } else {
          opts.onLog?.(
            `[nvidia] ERROR round=${round} attempt=${attempt} after ${elapsed}ms: ${e.name}: ${e.message.slice(0, 200)}`,
          );
        }
        // If the error is retryable and we have attempts left, back off and retry.
        if (attempt < maxRetries && isRetryableError(e)) {
          const backoff = 500 * attempt; // 500ms, 1000ms, 1500ms, ...
          opts.onLog?.(
            `[nvidia] retry  backing off ${backoff}ms before attempt ${attempt + 1}`,
          );
          await new Promise((r) => setTimeout(r, backoff));
        } else if (!isRetryableError(e)) {
          // Non-retryable — surface immediately so the UI shows a real error.
          throw e;
        }
      }
    }

    if (!roundResult) {
      const elapsed = Date.now() - callStart;
      const finalErr = lastErr ?? new Error('unknown error');
      throw new Error(
        `NVIDIA call failed after ${maxRetries} attempts in round ${round} (${elapsed}ms): ${finalErr.name}: ${finalErr.message}`,
      );
    }

    // Accumulate content/reasoning across rounds. Round 0 is the original
    // call; rounds 1+ are continuations.
    fullContent += roundResult.content;
    fullReasoning += roundResult.reasoning;

    const elapsed = Date.now() - callStart;
    opts.onLog?.(
      `[nvidia] round=${round} done  ttfb=${roundResult.ttfbMs ?? 'n/a'}ms elapsed=${elapsed}ms content_chars=${roundResult.content.length} (total=${fullContent.length}) reasoning_chars=${roundResult.reasoning.length} finish_reason=${roundResult.finishReason ?? 'n/a'}`,
    );

    if (roundResult.finishReason !== 'length') {
      // Model finished naturally (or via content_filter / tool_calls).
      // No continuation needed.
      stillTruncated = false;
      break;
    }

    // finish_reason === 'length' → output was truncated.
    // If we have continuation budget left, append the partial output as an
    // assistant message + the generic continue prompt, and loop again.
    if (round >= maxContinuations || !roundResult.content) {
      stillTruncated = true;
      opts.onLog?.(
        `[nvidia] TRUNCATED after ${round + 1} round(s) — exhausted maxContinuations=${maxContinuations}. Output ends mid-sentence.`,
      );
      break;
    }

    continuations++;
    opts.onLog?.(
      `[nvidia] continue  round=${round + 1}/${maxContinuations} — model hit max_tokens, resuming from char ${fullContent.length}`,
    );

    // Build the next round's messages: original + assistant's partial + continue prompt.
    messages = [
      ...opts.messages,
      { role: 'assistant' as const, content: roundResult.content },
      { role: 'user' as const, content: CONTINUE_USER_PROMPT },
    ];
  }

  const elapsed = Date.now() - callStart;
  opts.onLog?.(
    `[nvidia] done   elapsed=${elapsed}ms content_chars=${fullContent.length} reasoning_chars=${fullReasoning.length} attempts=${attemptsUsed} continuations=${continuations} truncated=${stillTruncated}`,
  );

  if (!fullContent) {
    throw new Error(
      `empty content (reasoning_chars=${fullReasoning.length})`,
    );
  }

  return {
    content: fullContent,
    reasoning: fullReasoning,
    model,
    elapsedMs: elapsed,
    attempts: attemptsUsed,
    continuations,
    truncated: stillTruncated,
  };
}

// Exported for callers that want to do their own retry loop and check
// retryability themselves.
export { isRetryableError };
