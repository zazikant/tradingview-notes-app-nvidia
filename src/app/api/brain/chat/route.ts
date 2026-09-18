import { NextRequest } from 'next/server';
import {
  searchRecords,
  rerankAndAggregate,
  buildContextFromAggregated,
  type SearchHit,
} from '@/lib/brain/pinecone';
import { nvidiaChatStreamControlled } from '@/lib/brain/nvidia';

export const runtime = 'nodejs';
export const maxDuration = 60;  // Vercel Hobby Node cap (was 180 — Vercel ignored it and killed at 60s)

// ─── Prompts (ported verbatim from rag-document-assistant / OpenCode variant) ──
// These are the exact prompts that produced great output in the source
// RAG projects. Muse Glimmer 30B's reasoning_content is treated as a
// silent scratchpad — the user only sees the finished `content`.

const SYSTEM_PROMPT = `You are an intelligent second-brain assistant with deep reasoning ability. You don't merely retrieve — you REASON through the context to produce the smartest, most useful answer.

STRICT FIDELITY RULES:
1. Use ONLY the provided Context to answer. Do NOT guess or assume details not in Context.
2. If the Context does NOT contain relevant information, say: "I don't have that information in my knowledge base."
3. When discussing specific entities (people, products, companies), use ONLY attributes explicitly stated — never transfer characteristics from one entity to another.
4. Always cite sources inline as [Document: filename] when using information from Context.
5. Never fabricate APIs, function names, or implementation details not in Context.

ADAPTIVE LENGTH (the key skill):
Match your answer length to the question's complexity. Be CONCISE when the question is simple; be COMPREHENSIVE when the question is complex.

- SHORT (2-4 sentences, ~200 chars): factual lookups — "What is X?", "Who owns Y?", "When did Z happen?"
- MEDIUM (1-3 paragraphs, ~800 chars): how/why questions about a single concept
- LONG (multiple sections, ~3000 chars): multi-faceted questions, architecture explanations, comparisons
- VERY LONG (detailed with code/examples, up to 30000 chars): complex technical questions, full implementation guides, deep architectural reasoning, multi-step tutorials

QUALITY RULES:
- Lead with the direct answer, then expand. Don't bury the lede.
- For coding questions: provide concrete code examples, patterns, and architecture when the context supports it.
- For conceptual questions: structure with headers, bullet points, and clear reasoning.
- For multi-part questions: address each part explicitly.
- When the context has gaps, say what you CAN answer and explicitly note what's missing.
- Be the smartest version of yourself — synthesize, infer logical consequences, draw connections the writer implied but didn't state.`;

const REDUCER_PROMPT = `You are a research synthesis engine. Given multiple document chunks about the same topic, REASON through them to produce a coherent, comprehensive synthesis.

Task:
1. Extract key information from each chunk
2. Merge overlapping information intelligently (don't just concatenate)
3. Note any conflicts or differences between sources
4. Infer connections that span multiple chunks
5. Provide a unified, comprehensive synthesis

Format your response as:
- Key Points: (bulleted list of main findings, each 1-2 sentences)
- Details: (comprehensive synthesis combining all sources, with inline citations)
- Conflicts: (any disagreements between sources, or "None" if consistent)
- Sources: (list of which documents contributed)

Be thorough — this synthesis will be used as context for the final answer, so include all relevant details from the chunks.`;

const NO_CONTEXT_PROMPT = `You are a helpful assistant. No notes have been synced to the Brain yet, OR none of the synced notes matched the question. Answer the user's question from general knowledge, and gently suggest they sync some notes first for better-grounded answers.`;

// Pipeline-level retry — if the first attempt times out or aborts mid-stream,
// retry up to 3 times with backoff. Each attempt gets a fresh 55s budget
// (under Vercel Hobby's 60s Node cap). The 'reset' SSE event tells the
// client to clear its partial answer buffer before each retry.
const MAX_ANSWER_ATTEMPTS = 3;

/**
 * POST /api/brain/chat — streaming RAG chat (Server-Sent Events)
 *
 * Body: { query, top_k?, min_score?, history? }
 *   history: optional array of { role: 'user' | 'assistant', content: string }
 *            for multi-turn chat. Default empty.
 *
 * Pipeline (matches rag-document-assistant-opencode):
 *   1. Search Pinecone for relevant chunks
 *   2. Aggregate by filename (rerankAndAggregate)
 *   3. Build context (buildContextFromAggregated, 5000 chars)
 *   4. REDUCE stage — if any document has >1 chunk, call OpenCode with
 *      REDUCER_PROMPT to synthesize the multi-chunk context into a
 *      single coherent summary before the final answer. Streams nothing
 *      to the user — it's an internal prep step.
 *   5. ANSWER stage — stream the final answer via SYSTEM_PROMPT.
 *      max_tokens=32768 supports up to ~30K char outputs for complex
 *      technical questions.
 *
 * Response: text/event-stream with structured events:
 *   stage-start  { stage: 'search' | 'aggregate' | 'reduce' | 'answer' }
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

        // ── Stage 2: aggregate by filename ───────────────────────────
        send('stage-start', { stage: 'aggregate' });
        const aggregated = rerankAndAggregate(hits);
        send('log', { line: `[pinecone] ${hits.length} chunks / ${aggregated.length} notes above threshold` });

        const sources = aggregated.map((a) => ({
          filename: a.filename,
          ticker: a.ticker || '',
          avgScore: Number(a.avgScore.toFixed(3)),
          chunkCount: a.chunkCount,
        }));
        send('sources', { sources });

        // Use 5000 chars context (matches source repo, was 4000)
        const context = buildContextFromAggregated(aggregated, 5000);
        send('stage-end', { stage: 'aggregate', ok: true, elapsedMs: 0, summary: `${aggregated.length} notes aggregated, ${context.length} chars context` });

        // ── Stage 3 (optional): REDUCE ───────────────────────────────
        // If any document has >1 chunk, run an internal reducer call to
        // synthesize multi-chunk context into a coherent summary.
        // This is NOT streamed to the user — it's prep for the final answer.
        //
        // Muse Glimmer 30B is a reasoning model — its reasoning_content is
        // treated as a silent scratchpad (accumulated but not streamed).
        // The reducer uses max_tokens=512 (~15s) to keep the pipeline under
        // 60s: reduce (~15s) + answer (~30s) = ~45s total.
        let reducedContext = context;
        const reducerNeeded = aggregated.some((a) => a.chunkCount > 1) && context.length > 0;

        if (reducerNeeded) {
          send('stage-start', { stage: 'reduce' });
          send('log', { line: `[pipeline] Multi-chunk aggregation — calling NVIDIA to reduce context…` });

          try {
            const reduceResult = await nvidiaChatStreamControlled({
              messages: [
                { role: 'system', content: REDUCER_PROMPT },
                { role: 'user', content: `Question: ${query}\n\nContext:\n${context}\n\nPlease synthesize this information.` },
              ],
              temperature: 0.2,
              topP: 0.95,
              maxTokens: 512,    // small budget for quick synthesis (~15s on Muse Glimmer)
              onLog: (line) => send('log', { line }),
              // No onChunk — reducer output is internal, not streamed to the user.
            });
            reducedContext = reduceResult.content;
            send('stage-end', {
              stage: 'reduce',
              ok: true,
              elapsedMs: reduceResult.elapsedMs,
              summary: `${reducedContext.length} chars reduced context`,
            });
          } catch (reduceError: any) {
            send('log', { line: `[pipeline] Reduce failed: ${(reduceError?.message || 'unknown').slice(0, 100)} — using raw context` });
            send('stage-end', {
              stage: 'reduce',
              ok: false,
              elapsedMs: 0,
              summary: `Reduce failed — using raw context`,
            });
            // Continue with raw context — reduce is optional, don't fail the whole pipeline.
          }
        } else if (context.length > 0) {
          send('log', { line: `[pipeline] Single-chunk answers — skipping reduce step` });
        }

        // ── Stage 4: ANSWER (streaming, up to 30K chars) ─────────────
        send('stage-start', { stage: 'answer' });

        // Pick the system prompt: use the powerful SYSTEM_PROMPT when we
        // have context, fall back to NO_CONTEXT_PROMPT otherwise.
        // The context is injected into the user message (matches source repo).
        const systemPrompt = context.length > 0 ? SYSTEM_PROMPT : NO_CONTEXT_PROMPT;
        const userContent = context.length > 0
          ? `Context:\n${reducedContext}\n\n---\n\nQuestion: ${query}`
          : query;

        const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
          { role: 'system', content: systemPrompt },
          ...history.slice(-8).map((m) => ({
            role: m.role === 'assistant' ? 'assistant' as const : 'user' as const,
            content: m.content,
          })),
          { role: 'user', content: userContent },
        ];

        // Pipeline-level retry: up to 3 attempts. Each attempt gets a fresh
        // 55s budget. Between attempts, emit 'reset' so the client clears
        // its partial answer buffer (prevents garbled concatenation).
        let answerOk = false;
        let lastErr = '';

        for (let attempt = 1; attempt <= MAX_ANSWER_ATTEMPTS; attempt++) {
          send('log', { line: `[pipeline] answer attempt ${attempt}/${MAX_ANSWER_ATTEMPTS}` });

          // Before each retry, tell the client to clear its partial buffer.
          if (attempt > 1) {
            send('reset', { stage: 'answer' });
          }

          try {
            const result = await nvidiaChatStreamControlled({
              messages,
              temperature: 0.3,   // deterministic, matches OpenCode (Muse Glimmer default is 1.0 — too random for RAG)
              topP: 0.95,         // Muse Glimmer recommended value
              maxTokens: 2048,    // enough for reasoning (scratchpad) + finished content (~30s on Muse Glimmer)
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
              // Exponential backoff: 1s, 2s
              const backoff = 1000 * attempt;
              send('log', { line: `[pipeline] backing off ${backoff}ms before retry` });
              await new Promise((r) => setTimeout(r, backoff));
            }
          }
        }

        if (!answerOk) {
          send('log', { line: `[nvidia] final failure after ${MAX_ANSWER_ATTEMPTS} attempts: ${lastErr}` });
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
