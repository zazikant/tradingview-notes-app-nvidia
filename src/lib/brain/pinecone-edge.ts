/**
 * Edge-compatible Pinecone search using direct REST API calls.
 *
 * The @pinecone-database/pinecone SDK pulls in node:stream which is
 * unsupported in Edge runtime. This module replaces the searchRecords,
 * rerankAndAggregate, and buildContextFromAggregated functions with
 * pure-fetch implementations that work in Edge runtime.
 *
 * Used by /api/query-stream (Edge). The original /lib/pinecone.ts
 * (Node runtime) is still used by /api/query, /api/ingest, /api/upload.
 */

const PINECONE_INDEX_NAME = process.env.PINECONE_INDEX_NAME || 'rag-documents';
const EMBEDDING_MODEL = 'multilingual-e5-large';

export interface SearchHit {
  text: string;
  filename: string;
  score: number;
  chunk_index?: number;
  total_chunks?: number;
}

export interface AggregatedHit {
  filename: string;
  chunks: { text: string; score: number }[];
  totalScore: number;
  avgScore: number;
  chunkCount: number;
}

// ─── Query expansion (same logic as pinecone.ts) ─────────────

const QUERY_EXPANSION_MAP: Record<string, string[]> = {
  'owner': ['responsible', 'lead', 'manager', 'accountable', 'main'],
  'owners': ['responsible', 'lead', 'manager', 'accountable', 'main'],
  'lead': ['leader', 'manager', 'head', 'owner', 'responsible'],
  'leads': ['leader', 'manager', 'head', 'owner', 'responsible'],
  'manager': ['lead', 'leader', 'head', 'owner', 'responsible'],
  'team': ['group', 'department', 'squad', 'unit', 'members'],
  'project': ['initiative', 'system', 'application', 'service', 'platform'],
  'architecture': ['design', 'structure', 'system design', 'technical design'],
  'database': ['db', 'storage', 'postgres', 'postgresql', 'data'],
  'api': ['endpoint', 'rest', 'service', 'interface', 'route'],
  'deploy': ['deployment', 'release', 'publish', 'host', 'server'],
  'config': ['configuration', 'settings', 'env', 'environment'],
  'error': ['bug', 'issue', 'problem', 'failure', 'exception'],
  'test': ['testing', 'qa', 'unit test', 'integration test'],
};

function expandQuery(query: string): string[] {
  const words = query.toLowerCase().split(/\s+/);
  const expanded = [query];

  for (const word of words) {
    const synonyms = QUERY_EXPANSION_MAP[word];
    if (synonyms) {
      for (const synonym of synonyms) {
        const expandedQuery = query.toLowerCase().replace(word, synonym);
        if (expandedQuery.toLowerCase() !== query.toLowerCase()) {
          expanded.push(expandedQuery);
        }
      }
    }
  }

  return expanded;
}

// ─── Aggregation (same logic as pinecone.ts) ─────────────────

export function rerankAndAggregate(hits: SearchHit[]): AggregatedHit[] {
  const byFile = new Map<string, AggregatedHit>();

  for (const hit of hits) {
    if (!byFile.has(hit.filename)) {
      byFile.set(hit.filename, {
        filename: hit.filename,
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

  const aggregated = Array.from(byFile.values());

  return aggregated.sort((a, b) => {
    const scoreA = a.avgScore * Math.log(a.chunkCount + 1);
    const scoreB = b.avgScore * Math.log(b.chunkCount + 1);
    return scoreB - scoreA;
  });
}

export function buildContextFromAggregated(aggregated: AggregatedHit[], maxChars: number = 4000): string {
  let context = '';
  let remaining = maxChars;

  for (const hit of aggregated) {
    const sortedChunks = hit.chunks.sort((a, b) => b.score - a.score);
    const combined = sortedChunks.map(c => c.text).join('\n\n');

    if (combined.length <= remaining) {
      context += `[Document: ${hit.filename}]\n${combined}\n\n---\n\n`;
      remaining -= combined.length;
    } else {
      let acc = '';
      for (const chunk of sortedChunks) {
        if (acc.length + chunk.text.length + 50 <= remaining) {
          acc += chunk.text + '\n\n';
        } else {
          break;
        }
      }
      if (acc.length > 0) {
        context += `[Document: ${hit.filename}]\n${acc}\n\n---\n\n`;
      }
    }
  }

  return context.trim();
}

// ─── Person query detection ──────────────────────────────────

const PERSON_QUERY_KEYWORDS = [
  'who', 'person', 'rep', 'sales rep', 'account', 'manager', 'lead',
  'founder', 'director', 'ceo', 'cto', 'vp', 'head of',
];

function isPersonQuery(query: string): boolean {
  const lower = query.toLowerCase();
  return PERSON_QUERY_KEYWORDS.some(kw => lower.includes(kw));
}

function roundRobinDiversify(hits: SearchHit[]): SearchHit[] {
  const byFile = new Map<string, SearchHit[]>();
  for (const hit of hits) {
    if (!byFile.has(hit.filename)) byFile.set(hit.filename, []);
    byFile.get(hit.filename)!.push(hit);
  }

  const diverse: SearchHit[] = [];
  let round = 0;
  while (diverse.length < hits.length && round < 10) {
    for (const [, fileHits] of byFile) {
      const chunk = fileHits[round];
      if (chunk) diverse.push(chunk);
    }
    round++;
  }
  return diverse;
}

// ─── Edge-compatible search via direct REST API ──────────────

/**
 * Get the Pinecone environment URL from the API key.
 * Pinecone API keys are prefixed with the environment, e.g.:
 *   pcsk_4zE62G_... → environment is in the key
 *
 * Actually, the control plane URL is https://api.pinecone.io and
 * the index URL is fetched from there. But for simplicity, we use
 * the index host directly. The Pinecone SDK does this internally.
 *
 * For Edge runtime, we hit the Pinecone REST API directly:
 *   1. POST https://api.pinecone.io/indexes/{index}/project
 *      to get the index host URL (or use a cached value)
 *   2. POST {index_host}/vectors/query
 *      to search
 *   3. POST {index_host}/vectors/embed
 *      to get embeddings
 *
 * Actually, the simpler approach: use the inference + index endpoints
 * directly. The Pinecone SDK uses these same endpoints under the hood.
 */

let cachedIndexHost: string | null = null;

async function getIndexHost(): Promise<string> {
  if (cachedIndexHost) return cachedIndexHost;

  const apiKey = process.env.PINECONE_API_KEY!;
  const response = await fetch(`https://api.pinecone.io/indexes/${PINECONE_INDEX_NAME}`, {
    method: 'GET',
    headers: {
      'Api-Key': apiKey,
      'X-Pinecone-Api-Version': '2024-07',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to get Pinecone index host: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  const host: string | undefined | null = data?.host;
  if (!host || typeof host !== 'string') {
    throw new Error(
      `Pinecone index "${PINECONE_INDEX_NAME}" response did not contain a valid host field`,
    );
  }
  cachedIndexHost = host;
  return cachedIndexHost;
}

async function getEmbedding(text: string): Promise<number[]> {
  const apiKey = process.env.PINECONE_API_KEY!;

  const response = await fetch('https://api.pinecone.io/embed', {
    method: 'POST',
    headers: {
      'Api-Key': apiKey,
      'Content-Type': 'application/json',
      'X-Pinecone-Api-Version': '2024-07',
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      inputs: [{ text }],
      parameters: {
        input_type: 'query',
        truncate: 'END',
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Pinecone embed failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  return data.data[0].values as number[];
}

async function queryIndex(
  vector: number[],
  topK: number,
  filter?: Record<string, any>,
): Promise<any[]> {
  const apiKey = process.env.PINECONE_API_KEY!;
  const indexHost = await getIndexHost();

  const body: any = {
    vector,
    topK,
    includeMetadata: true,
  };

  if (filter && Object.keys(filter).length > 0) {
    body.filter = filter;
  }

  const response = await fetch(`https://${indexHost}/query`, {
    method: 'POST',
    headers: {
      'Api-Key': apiKey,
      'Content-Type': 'application/json',
      'X-Pinecone-Api-Version': '2024-07',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Pinecone query failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  return data.matches || [];
}

/**
 * Edge-compatible searchRecords — same logic as pinecone.ts but uses
 * direct REST API calls instead of the Pinecone SDK.
 */
export async function searchRecords(
  query: string,
  topK: number = 8,
  minScore: number = 0.70,
  filter?: { doc_type?: string; project?: string },
  forceAggregation?: boolean,
): Promise<SearchHit[]> {
  const aggregationKeywords = ['all', 'every', 'list', 'how many', 'compare', 'show me', 'find all', 'get all', 'total', 'count'];
  const isAggregation = forceAggregation || aggregationKeywords.some(kw => query.toLowerCase().includes(kw));
  const isPersonSearch = isPersonQuery(query);

  const effectiveTopK = isAggregation ? 50 : (isPersonSearch ? 50 : topK);
  const effectiveMinScore = isAggregation ? 0.50 : minScore;

  const expandedQueries = expandQuery(query);
  const allHits: SearchHit[] = [];

  for (const expandedQuery of expandedQueries) {
    const queryVector = await getEmbedding(expandedQuery);

    const metadataFilter: any = {};
    if (filter?.doc_type) metadataFilter.doc_type = { $eq: filter.doc_type };
    if (filter?.project) metadataFilter.project = { $eq: filter.project };

    const matches = await queryIndex(
      queryVector,
      effectiveTopK,
      Object.keys(metadataFilter).length > 0 ? metadataFilter : undefined,
    );

    const hits: SearchHit[] = matches
      .filter((match: any) => match.score >= effectiveMinScore)
      .map((match: any) => ({
        text: match.metadata?.text || '',
        filename: match.metadata?.filename || '',
        score: match.score || 0,
        chunk_index: match.metadata?.chunk_index,
        total_chunks: match.metadata?.total_chunks,
      }));

    allHits.push(...hits);
  }

  const deduped = new Map<string, SearchHit>();
  for (const hit of allHits) {
    const key = `${hit.filename}_${hit.text.substring(0, 100)}`;
    if (!deduped.has(key) || deduped.get(key)!.score < hit.score) {
      deduped.set(key, hit);
    }
  }

  const sorted = Array.from(deduped.values()).sort((a, b) => b.score - a.score);

  if (isPersonSearch) {
    return roundRobinDiversify(sorted);
  }

  return sorted;
}
