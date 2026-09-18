import { Pinecone } from '@pinecone-database/pinecone';
import { v4 as uuidv4 } from 'uuid';

/**
 * Pinecone vector store for the Brain.
 *
 * Ported (and simplified) from rag-document-assistant-opencode/src/lib/pinecone.ts.
 * Kept the same chunking, upsert, and search semantics — minus the heavy
 * query-expansion + person-query heuristics which we don't need for notes.
 *
 * Required env vars (set on Vercel):
 *   PINECONE_API_KEY        — your Pinecone account API key
 *   PINECONE_INDEX_NAME    — (optional) defaults to 'rag-documents'
 *
 * Reusing the same Pinecone index as the original RAG app is fine — synced
 * notes get filenames like `note-<client_id>.txt` so they don't collide
 * with any uploaded PDFs. To use a separate index, set PINECONE_INDEX_NAME
 * to e.g. `tv-notes-brain` and create that index in Pinecone (1024 dims,
 * metric: cosine, model: multilingual-e5-large).
 */

const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const PINECONE_INDEX_NAME = process.env.PINECONE_INDEX_NAME || 'rag-documents';

export const EMBEDDING_MODEL = 'multilingual-e5-large';
export const EMBEDDING_DIMENSION = 1024;

let _pc: Pinecone | null = null;
function getPinecone(): Pinecone {
  if (!_pc) {
    if (!PINECONE_API_KEY) {
      throw new Error(
        'PINECONE_API_KEY env var is not set. Add it in Vercel → Project Settings → Environment Variables.',
      );
    }
    _pc = new Pinecone({ apiKey: PINECONE_API_KEY });
  }
  return _pc;
}

function pineconeIndex() {
  return getPinecone().Index(PINECONE_INDEX_NAME);
}

/**
 * Chunk text into overlapping pieces for embedding.
 * Defaults match the RAG repo: 500 chars / 50 overlap.
 */
function chunkText(text: string, chunkSize = 500, overlap = 50): string[] {
  if (!text || text.length === 0) return [];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = start + chunkSize;
    const chunk = text.slice(start, end).trim();
    if (chunk.length > 0) chunks.push(chunk);
    start = end - overlap;
  }
  return chunks;
}

export interface ChunkMetadata {
  doc_type?: string;
  project?: string;
  version?: string;
  uploaded_at?: number;
  ticker?: string;
  note_id?: string;
}

/**
 * Upsert document chunks into Pinecone using multilingual-e5-large.
 * First deletes any existing vectors for this filename, then re-embeds.
 *
 * Returns the number of chunks written.
 */
export async function upsertRecords(
  text: string,
  filename: string,
  metadata?: ChunkMetadata,
): Promise<{ status: string; filename: string; chunks: number }> {
  if (!text || !filename) {
    throw new Error('text and filename are required');
  }

  const chunks = chunkText(text, 500);
  if (chunks.length === 0) {
    return { status: 'error', filename, chunks: 0 };
  }

  // Best-effort delete of existing vectors for this filename. 404 is OK.
  try {
    await pineconeIndex().deleteMany({ filter: { filename: { $eq: filename } } });
  } catch (err: any) {
    if (
      err?.status !== 404 &&
      err?.statusCode !== 404 &&
      !err?.message?.includes('404')
    ) {
      throw err;
    }
  }

  // Batch the embedding call — Pinecone's inference.embed has a limit
  // on the number of inputs per request. Batch in groups of 100.
  const EMBED_BATCH_SIZE = 90; // Pinecone limit is 96 inputs per embed call
  const allVectors: any[] = [];

  for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
    const chunkBatch = chunks.slice(i, i + EMBED_BATCH_SIZE);
    const embeddingsResponse = await getPinecone().inference.embed({
      model: EMBEDDING_MODEL,
      inputs: chunkBatch,
      parameters: { input_type: 'passage', truncate: 'END' },
    });

    const batchVectors = embeddingsResponse.data.map((emb: any, j: number) => ({
      id: `${filename}_${i + j}_${uuidv4().slice(0, 8)}`,
      values: emb.values as number[],
      metadata: {
        filename,
        text: chunkBatch[j],
        chunk_index: i + j,
        total_chunks: chunks.length,
        doc_type: metadata?.doc_type || 'note',
        project: metadata?.project || 'tradingview-notes',
        version: metadata?.version || '1.0',
        uploaded_at: metadata?.uploaded_at || Date.now(),
        ticker: metadata?.ticker || '',
        note_id: metadata?.note_id || '',
      },
    }));
    allVectors.push(...batchVectors);
  }

  // Batch the upsert — Pinecone limits 1000 vectors per upsert request.
  const UPSERT_BATCH_SIZE = 1000;
  for (let i = 0; i < allVectors.length; i += UPSERT_BATCH_SIZE) {
    const batch = allVectors.slice(i, i + UPSERT_BATCH_SIZE);
    await pineconeIndex().upsert({ records: batch });
  }

  return { status: 'success', filename, chunks: chunks.length };
}

/**
 * Delete all vectors for a given filename.
 */
export async function deleteRecords(filename: string): Promise<void> {
  try {
    await pineconeIndex().deleteMany({ filter: { filename: { $eq: filename } } });
  } catch (err: any) {
    if (
      err?.status === 404 ||
      err?.statusCode === 404 ||
      err?.message?.includes('404')
    ) {
      return;
    }
    throw err;
  }
}

export interface SearchHit {
  text: string;
  filename: string;
  score: number;
  chunk_index?: number;
  total_chunks?: number;
  ticker?: string;
  note_id?: string;
}

/**
 * Embed a query and search Pinecone for the top-K most similar chunks.
 * Filters out chunks below `minScore`.
 */
export async function searchRecords(
  query: string,
  topK = 8,
  minScore = 0.55,
): Promise<SearchHit[]> {
  const queryEmbedding = await getPinecone().inference.embed({
    model: EMBEDDING_MODEL,
    inputs: [query],
    parameters: { input_type: 'query', truncate: 'END' },
  });

  const queryVector = (queryEmbedding.data as any[])[0].values as number[];

  const searchResponse = pineconeIndex().query({
    vector: queryVector,
    topK,
    includeMetadata: true,
  });

  const matches = (await searchResponse).matches || [];

  const hits: SearchHit[] = matches
    .filter((m: any) => (m.score ?? 0) >= minScore)
    .map((m: any) => ({
      text: m.metadata?.text || '',
      filename: m.metadata?.filename || '',
      score: m.score ?? 0,
      chunk_index: m.metadata?.chunk_index,
      total_chunks: m.metadata?.total_chunks,
      ticker: m.metadata?.ticker || '',
      note_id: m.metadata?.note_id || '',
    }));

  // Dedupe by filename+text and sort by score
  const deduped = new Map<string, SearchHit>();
  for (const hit of hits) {
    const key = `${hit.filename}_${hit.text.substring(0, 100)}`;
    if (!deduped.has(key) || deduped.get(key)!.score < hit.score) {
      deduped.set(key, hit);
    }
  }
  return Array.from(deduped.values()).sort((a, b) => b.score - a.score);
}

/**
 * Aggregate hits by filename so the LLM context shows the top chunks per note,
 * not duplicates. Also used to render the "Sources" chips in the chat UI.
 */
export interface AggregatedHit {
  filename: string;
  ticker: string;
  chunks: { text: string; score: number }[];
  totalScore: number;
  avgScore: number;
  chunkCount: number;
}

export function rerankAndAggregate(hits: SearchHit[]): AggregatedHit[] {
  const byFile = new Map<string, AggregatedHit>();
  for (const hit of hits) {
    if (!byFile.has(hit.filename)) {
      byFile.set(hit.filename, {
        filename: hit.filename,
        ticker: hit.ticker || '',
        chunks: [],
        totalScore: 0,
        avgScore: 0,
        chunkCount: 0,
      });
    }
    const agg = byFile.get(hit.filename)!;
    agg.chunks.push({ text: hit.text, score: hit.score });
    agg.totalScore += hit.score;
    agg.chunkCount++;
  }
  for (const agg of byFile.values()) {
    agg.avgScore = agg.totalScore / agg.chunkCount;
  }
  return Array.from(byFile.values()).sort((a, b) => {
    const sa = a.avgScore * Math.log(a.chunkCount + 1);
    const sb = b.avgScore * Math.log(b.chunkCount + 1);
    return sb - sa;
  });
}

/**
 * Build a single text blob (capped at maxChars) from the top aggregated hits,
 * to use as the LLM context.
 */
export function buildContextFromAggregated(
  aggregated: AggregatedHit[],
  maxChars = 4000,
): string {
  let context = '';
  let remaining = maxChars;
  for (const hit of aggregated) {
    const sorted = hit.chunks.slice().sort((a, b) => b.score - a.score);
    const combined = sorted.map((c) => c.text).join('\n\n');
    if (combined.length <= remaining) {
      context += `[Note: ${hit.filename}${hit.ticker ? ` (ticker: ${hit.ticker})` : ''}]\n${combined}\n\n---\n\n`;
      remaining -= combined.length;
    } else {
      let acc = '';
      for (const chunk of sorted) {
        if (acc.length + chunk.text.length + 50 <= remaining) {
          acc += chunk.text + '\n\n';
        } else break;
      }
      if (acc.length > 0) {
        context += `[Note: ${hit.filename}${hit.ticker ? ` (ticker: ${hit.ticker})` : ''}]\n${acc}\n\n---\n\n`;
      }
    }
  }
  return context.trim();
}
