import { NextRequest } from 'next/server';
import {
  searchRecords,
  rerankAndAggregate,
  buildContextFromAggregated,
  type SearchHit,
} from '@/lib/brain/pinecone-edge';  // Edge-compatible (no Pinecone SDK)
import { nvidiaChatStreamControlled } from '@/lib/brain/nvidia';

// Edge runtime — Vercel Hobby caps Edge at 30s (vs 60s for Node).
// We use Edge because:
//   1. SSE streaming works more reliably on Edge (no Node buffer layer)
//   2. 30s cap forces us to keep LLM calls short (25s timeout in nvidia.ts)
//   3. Cold starts are near-zero on Edge
// The Pinecone SDK uses node:stream so we use pinecone-edge.ts (raw REST).
export const runtime = 'edge';
export const maxDuration = 30;  // Vercel Hobby Edge cap

// Pipeline-level retry — if the first attempt times out or aborts mid-stream,
// retry up to 3 times with backoff. Each attempt gets a fresh 25s budget.
const MAX_ANSWER_ATTEMPTS = 3;
// 2048 tokens — matches ax-translator's default. Keeps GPT-OSS-20B under
// 25s reliably (TTFB ~3-5s + ~2000 tokens at ~80 tokens/s = ~28s worst case,
// usually much faster). Larger values (4096+) can exceed the 25s timeout
// on Vercel Hobby Edge, triggering the abort-midway bug.
const ANSWER_MAX_TOKENS = 2048;

/**
 * POST /api/brain/chat — streaming RAG chat (Server-Sent Events)
 *
 * Body: { query, top_k?, min_score?, history? }
 *   history: optional array of { role: 'user' | 'assistant', content: string }
 *
 * Pipeline:
 *   1. Search Pinecone (via Edge-compatible REST API)
 *   2. Aggregate + build context
 *   3. Stream answer via NVIDIA with pipeline-level retry (3 attempts)
 *
 * Response: text/event-stream with structured events:
 *   stage-start  { stage: 'search' | 'answer' }
 *   log          { line: string }
 *   sources      { sources: [...] }
 *   chunk        { text: string }
 *   reset        { stage: 'answer' }  // emitted before each retry — client clears buffer
 *   stage-end    { stage, ok, elapsedMs, summary }
 *   pipeline-end { ok: true }
 *   error        { message: string }
 */
export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: 'invalid JSON body' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const query: string = typeof body?.query === 'string' ? body.query.trim() : '';
  const topK: number = Number(body?.top_k) > 0 ? Number(body.top_k) : 8;
  const minScore: number =
    Number(body?.min_score) > 0 ? Number(body.min_score) : 0.55;
  const history: { role: 'user' | 'assistant'; content: string }[] =
    Array.isArray(body?.history) ? body.history : [];

  if (!query) {
    return new Response(
      JSON.stringify({ error: 'query is required' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      function send(eventType: string, payload: any) {
        const line = `data: ${JSON.stringify({ type: eventType, ...payload })}\n\n`;
        controller.enqueue(encoder.encode(line));
      }

      const pipelineStart = Date.now();

      try {
        // ── Stage 1: search Pinecone (Edge-compatible REST) ──────────
        send('stage-start', { stage: 'search' });
        send('log', { line: `[pipeline] searching top ${topK} chunks for: "${query.slice(0, 80)}${query.length > 80 ? '…' : ''}"` });

        let hits: SearchHit[] = [];
        try {
          hits = await searchRecords(query, topK, minScore);
        } catch (err: any) {
          send('log', { line: `[pinecone] search error: ${err?.message || 'unknown'}` });
          send('stage-end', { stage: 'search', ok: false, elapsedMs: Date.now() - pipelineStart, summary: 'search failed' });
          send('error', { message: `Pinecone search failed: ${err?.message || 'unknown'}` });
          send('pipeline-end', { ok: false });
          controller.close();
          return;
        }

        const aggregated = rerankAndAggregate(hits);
        send('log', { line: `[pinecone] ${hits.length} chunks / ${aggregated.length} notes above threshold` });

        const sources = aggregated.map((a) => ({
          filename: a.filename,
          ticker: (a as any).ticker || '',
          avgScore: Number(a.avgScore.toFixed(3)),
          chunkCount: a.chunkCount,
        }));
        send('sources', { sources });

        const context = buildContextFromAggregated(aggregated, 2000);  // smaller context = faster TTFB
        send('stage-end', { stage: 'search', ok: true, elapsedMs: Date.now() - pipelineStart, summary: `${hits.length} chunks in ${aggregated.length} notes` });

        // ── Stage 2: stream the answer via NVIDIA (with pipeline retry) ───
        send('stage-start', { stage: 'answer' });

        const systemPrompt = context
          ? `You are a thoughtful research assistant. Use ONLY the context below to answer the user's question. Cite the note filename(s) you used at the end of your answer as "Sources: <filenames>". If the answer is not in the context, say so — do not invent facts.

Context (synced notes):
${context}`
          : `You are a helpful assistant. No notes have been synced to the Brain yet, OR none of the synced notes matched the question. Answer the user's question from general knowledge, and gently suggest they sync some notes first for better-grounded answers.`;

        const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
          { role: 'system', content: systemPrompt },
          ...history.slice(-8).map((m) => ({
            role: m.role === 'assistant' ? 'assistant' as const : 'user' as const,
            content: m.content,
          })),
          { role: 'user', content: query },
        ];

        let answerOk = false;
        let lastErr = '';

        for (let attempt = 1; attempt <= MAX_ANSWER_ATTEMPTS; attempt++) {
          send('log', { line: `[pipeline] answer attempt ${attempt}/${MAX_ANSWER_ATTEMPTS}` });

          // Before each retry, tell the client to clear its partial answer buffer.
          if (attempt > 1) {
            send('reset', { stage: 'answer' });
          }

          try {
            const result = await nvidiaChatStreamControlled({
              messages,
              temperature: 0.4,
              maxTokens: ANSWER_MAX_TOKENS,
              // timeoutMs defaults to 25s in nvidia.ts — well under Vercel's 30s Edge cap
              onLog: (line) => send('log', { line }),
              onChunk: (text) => send('chunk', { text }),
            });

            send('stage-end', {
              stage: 'answer',
              ok: true,
              elapsedMs: result.elapsedMs,
              summary: `${result.content.length} chars in ${result.attempts} attempt(s)`,
            });
            answerOk = true;
            break;
          } catch (err: any) {
            lastErr = err?.message || 'unknown';
            send('log', { line: `[nvidia] attempt ${attempt} failed: ${lastErr.slice(0, 150)}` });

            if (attempt < MAX_ANSWER_ATTEMPTS) {
              // Exponential backoff: 1s, 2s, 3s
              const backoff = 1000 * attempt;
              send('log', { line: `[pipeline] backing off ${backoff}ms before retry` });
              await new Promise((r) => setTimeout(r, backoff));
            }
          }
        }

        if (!answerOk) {
          send('stage-end', { stage: 'answer', ok: false, elapsedMs: Date.now() - pipelineStart, summary: `failed after ${MAX_ANSWER_ATTEMPTS} attempts` });
          send('error', { message: `NVIDIA call failed after ${MAX_ANSWER_ATTEMPTS} attempts: ${lastErr}` });
          send('pipeline-end', { ok: false });
          controller.close();
          return;
        }

        send('pipeline-end', { ok: true });
        controller.close();
      } catch (err: any) {
        console.error('[/api/brain/chat] unhandled error', err);
        try {
          send('error', { message: err?.message || 'unknown error' });
          send('pipeline-end', { ok: false });
        } catch {}
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
