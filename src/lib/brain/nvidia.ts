/**
 * NVIDIA LLM client — streaming chat completions via NVIDIA's integrate API.
 *
 * Ported from rag-document-assistant/src/lib/nvidia.ts (which itself was
 * ported from the OpenCode variant). Uses raw fetch + SSE parsing so we
 * don't need the openai SDK at runtime.
 *
 * Required env vars (set on Vercel):
 *   NVIDIA_API_KEY        — your NVIDIA build API key
 *
 * Gateway: https://integrate.api.nvidia.com/v1/chat/completions
 * Model:   openai/gpt-oss-20b (default) — NVIDIA-hosted GPT-OSS 20B.
 *          Other options: `openai/gpt-oss-120b`, `meta/llama-3.1-405b-instruct`,
 *          `nvidia/llama-3.1-nemotron-70b-instruct`, etc.
 *
 * Key differences from the OpenCode variant:
 *   - Different base URL: integrate.api.nvidia.com (vs opencode.ai/zen/go/v1)
 *   - No `reasoning_effort: 'low'` param — NVIDIA's GPT-OSS doesn't need it.
 *     (OpenCode required it because GLM 5.3 is a thinking-only model.)
 *   - No `x-opencode-session` header — that was OpenCode-specific routing.
 *
 * Retry / rate-handling (faithful to the source RAG project):
 *   - Retryable HTTP statuses: 429 (rate limit), 500, 502, 503, 504
 *   - Retryable error codes: ECONNRESET, ETIMEDOUT, UND_ERR_CONNECT_TIMEOUT
 *   - Retryable error names: APIConnectionError, APITimeoutError, ConnectionError
 *   - Legacy non-streaming path: 3 retries, 15s delay between attempts
 *   - Controlled streaming path: 1 attempt per call (pipeline-level retry
 *     handles additional attempts), exponential backoff (500ms × attempt)
 *   - Per-call timeout: 25s (under Vercel Hobby's 30s Edge cap)
 */

const NVIDIA_GATEWAY = 'https://integrate.api.nvidia.com/v1/chat/completions';
const NVIDIA_DEFAULT_MODEL = 'openai/gpt-oss-20b';
// 25s per-call timeout — under Vercel Hobby's 30s Edge runtime cap.
// The previous 120s was fine on Node runtime but Vercel Hobby kills Node
// functions at 60s and Edge at 30s, so 120s was never actually reachable.
// 25s gives a 5s safety margin for stream setup + final chunk flushing.
const NVIDIA_DEFAULT_TIMEOUT_MS = 25_000;

export interface ControlledStreamOptions {
  model?: string;
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  maxRetries?: number;
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
 * Streaming chat completion via NVIDIA's integrate API.
 *
 * - 120s per-call timeout (proven reliable for gpt-oss on Vercel)
 * - 1 attempt per call (caller can retry at the pipeline level)
 * - Streams chunks via onChunk callback
 * - Emits structured log lines via onLog callback
 * - Returns full content + reasoning + timing metadata
 *
 * Note: NVIDIA's GPT-OSS models can emit both `delta.content` (the answer)
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
  const callStart = Date.now();
  const apiKey = process.env.NVIDIA_API_KEY;

  if (!apiKey) {
    throw new Error(
      'NVIDIA_API_KEY env var is not set. Add it in Vercel → Project Settings → Environment Variables.',
    );
  }

  opts.onLog?.(
    `[nvidia] start  model=${model} max_tokens=${opts.maxTokens ?? 2048} temp=${opts.temperature ?? 0.7} timeout=${timeoutMs}ms`,
  );

  let lastErr: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(NVIDIA_GATEWAY, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({
          model,
          messages: opts.messages,
          max_tokens: opts.maxTokens ?? 2048,
          temperature: opts.temperature ?? 0.7,
          stream: true,
          // NOTE: no `reasoning_effort` here — NVIDIA's GPT-OSS doesn't need it.
          // NOTE: no `x-opencode-session` header — that was OpenCode-specific.
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errText = await response.text();
        // Surface rate-limit / server errors with their status code so the
        // retry helper above can pick them up if the caller wraps this in a loop.
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
            const elapsed = Date.now() - callStart;
            opts.onLog?.(
              `[nvidia] ttfb=${ttfbMs ?? 'n/a'}ms  done attempt=${attempt} elapsed=${elapsed}ms content_chars=${content.length} reasoning_chars=${reasoning.length}`,
            );
            if (!content && reasoning) {
              // Model misbehaved — only returned reasoning. Fall back to using it.
              content = reasoning;
              opts.onChunk?.(content);
            }
            if (!content) {
              throw new Error(
                `empty content (reasoning_chars=${reasoning.length})`,
              );
            }
            return { content, reasoning, model, elapsedMs: elapsed, attempts: attempt };
          }
          try {
            const json = JSON.parse(data);
            const delta = json.choices?.[0]?.delta;
            if (delta) {
              if (typeof delta.content === 'string' && delta.content) {
                content += delta.content;
                opts.onChunk?.(delta.content);
              }
              if (typeof delta.reasoning_content === 'string') {
                reasoning += delta.reasoning_content;
              }
            }
          } catch {
            // Partial JSON across chunks — ignore, will be retried on next read.
          }
        }
      }

      const elapsed = Date.now() - callStart;
      if (!content && reasoning) {
        content = reasoning;
        opts.onChunk?.(content);
      }
      if (!content) {
        throw new Error(
          `empty content (stream ended without [DONE], reasoning_chars=${reasoning.length})`,
        );
      }
      opts.onLog?.(
        `[nvidia] ttfb=${ttfbMs ?? 'n/a'}ms  done attempt=${attempt} elapsed=${elapsed}ms content_chars=${content.length} reasoning_chars=${reasoning.length}`,
      );
      return { content, reasoning, model, elapsedMs: elapsed, attempts: attempt };
    } catch (err: unknown) {
      clearTimeout(timeout);
      const e = err as Error;
      const elapsed = Date.now() - callStart;
      lastErr = e;
      if (e.name === 'AbortError') {
        opts.onLog?.(
          `[nvidia] TIMEOUT attempt=${attempt} after ${timeoutMs}ms`,
        );
      } else {
        opts.onLog?.(
          `[nvidia] ERROR attempt=${attempt} after ${elapsed}ms: ${e.name}: ${e.message.slice(0, 200)}`,
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

  const elapsed = Date.now() - callStart;
  const finalErr = lastErr ?? new Error('unknown error');
  throw new Error(
    `NVIDIA call failed after ${maxRetries} attempts (${elapsed}ms): ${finalErr.name}: ${finalErr.message}`,
  );
}

// Exported for callers that want to do their own retry loop and check
// retryability themselves.
export { isRetryableError };
