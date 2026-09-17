import { NextRequest } from 'next/server';
import {
  searchRecords,
  rerankAndAggregate,
  buildContextFromAggregated,
  type SearchHit,
} from '@/lib/brain/pinecone';
import { nvidiaChatStreamControlled } from '@/lib/brain/nvidia';

export const runtime = 'nodejs';
export const maxDuration = 180;

/**
 * POST /api/brain/chat — streaming RAG chat (Server-Sent Events)
 *
 * Body: { query, top_k?, min_score?, history? }
 *   history: optional array of { role: 'user' | 'assistant', content: string }
 *            for multi-turn chat. Default empty.
 *
 * Response: text/event-stream with structured events:
 *   stage-start  { stage: 'search' | 'answer' }
 *   log          { line: string }
 *   sources      { sources: [{ filename, ticker, avgScore, chunkCount }] }
 *   chunk        { text: string }                 // streamed answer token
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
        // ── Stage 1: search Pinecone ─────────────────────────────────
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
          ticker: a.ticker || '',
          avgScore: Number(a.avgScore.toFixed(3)),
          chunkCount: a.chunkCount,
        }));
        send('sources', { sources });

        const context = buildContextFromAggregated(aggregated, 4000);
        send('stage-end', { stage: 'search', ok: true, elapsedMs: Date.now() - pipelineStart, summary: `${hits.length} chunks in ${aggregated.length} notes` });

        // ── Stage 2: stream the answer via OpenCode ─────────────────
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

        try {
          const result = await nvidiaChatStreamControlled({
            messages,
            temperature: 0.4,
            maxTokens: 1500,
            onLog: (line) => send('log', { line }),
            onChunk: (text) => send('chunk', { text }),
          });

          send('stage-end', {
            stage: 'answer',
            ok: true,
            elapsedMs: result.elapsedMs,
            summary: `${result.content.length} chars in ${result.attempts} attempt(s)`,
          });
        } catch (err: any) {
          send('log', { line: `[nvidia] final failure: ${err?.message || 'unknown'}` });
          send('stage-end', { stage: 'answer', ok: false, elapsedMs: Date.now() - pipelineStart, summary: 'answer failed' });
          send('error', { message: `NVIDIA call failed: ${err?.message || 'unknown'}` });
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
