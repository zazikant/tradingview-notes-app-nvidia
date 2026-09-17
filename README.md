# TradingView Notes App — NVIDIA variant

An exact replica of [`zazikant/tradingview-notes-app`](https://github.com/zazikant/tradingview-notes-app), with the LLM backend swapped from **OpenCode (GLM-5.1)** to **NVIDIA's integrate API (GPT-OSS 20B)**.

## What's different from the original

| Aspect | Original | This repo |
|---|---|---|
| LLM provider | OpenCode gateway (`https://opencode.ai/zen/go/v1`) | NVIDIA integrate API (`https://integrate.api.nvidia.com/v1`) |
| Default model | `glm-5.1` (GLM 5.3 thinking model) | `openai/gpt-oss-20b` (NVIDIA-hosted GPT-OSS) |
| Env var | `OPENCODE_API_KEY` | `NVIDIA_API_KEY` |
| `reasoning_effort` param | Required (`'low'`) | Not sent (NVIDIA GPT-OSS doesn't need it) |
| `x-opencode-session` header | Required | Not sent (OpenCode-specific routing) |

Everything else — the Brain UI, Sync to Brain flow, multi-select, PDF upload, Supabase schema, Pinecone vector lifecycle, ticker-aware search, pagination — is identical to the original.

## Retry / rate-handling (faithfully ported from `rag-document-assistant`)

The retry logic is ported from [`zazikant/rag-document-assistant`](https://github.com/zazikant/rag-document-assistant) (the NVIDIA variant of the RAG project). It applies to the controlled streaming path used by `/api/brain/chat`:

- **Retryable HTTP statuses**: `429` (rate limit), `500`, `502`, `503`, `504`
- **Retryable error codes**: `ECONNRESET`, `ETIMEDOUT`, `UND_ERR_CONNECT_TIMEOUT`
- **Retryable error class names**: `APIConnectionError`, `APITimeoutError`, `ConnectionError`
- **Per-call timeout**: 120 seconds (proven reliable for gpt-oss on Vercel)
- **Max attempts per call**: 1 (pipeline-level retry handles additional attempts)
- **Backoff**: `500ms × attempt` (i.e. 500ms, 1000ms, 1500ms)
- **Non-retryable errors** (4xx other than 429, etc.) surface immediately to the UI

The `isRetryableError()` helper is exported from `src/lib/brain/nvidia.ts` so callers can wrap the streaming call in their own retry loop if needed.

## Setup

### 1. Environment variables (set on Vercel)

| Key | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Your Supabase project URL (e.g. `https://<ref>.supabase.co`) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase publishable key (`sb_publishable_...`) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase secret key (`sb_secret_...`) — server-only |
| `PINECONE_API_KEY` | Your Pinecone account API key |
| `PINECONE_INDEX_NAME` | (optional) Defaults to `rag-documents`. Set to a different index to keep notes separate |
| `NVIDIA_API_KEY` | Your NVIDIA integrate API key |

Get a NVIDIA API key at: https://build.nvidia.com/

### 2. Run the SQL migration

Paste the contents of `supabase/migrations/20260917_create_documents_table.sql` into the Supabase SQL editor for your project. This creates:
- The `documents` table with RLS (service-role-only access)
- The `documents` Storage bucket (private, 50 MB per-file limit)
- Storage RLS policies for the service role
- `updated_at` trigger
- `NOTIFY pgrst, 'reload schema'` so the table is immediately visible

### 3. Deploy to Vercel

```bash
vercel --prod
```

Or import the repo at https://vercel.com/new and let Vercel auto-deploy.

### 4. Try other NVIDIA models (optional)

Override the default model by editing the chat route, or by passing `model` in the request body to `/api/brain/chat`. Options include:

- `openai/gpt-oss-20b` (default — fast, 20B params)
- `openai/gpt-oss-120b` (heavier, better for complex reasoning)
- `meta/llama-3.1-405b-instruct`
- `nvidia/llama-3.1-nemotron-70b-instruct`
- `mistralai/mixtral-8x22b-instruct-v0.1`

Browse the full catalog at https://build.nvidia.com/models

## File structure

```
src/
  lib/brain/
    nvidia.ts          ← NVIDIA LLM client (replaces opencode.ts)
    pinecone.ts         ← Vector upsert + search (unchanged from original)
    supabase-admin.ts   ← Service-role Supabase client (unchanged)
    documents.ts         ← Documents table CRUD (unchanged)
    hash.ts              ← sha256 helper (unchanged)
    liteparse.ts         ← PDF/TXT/MD parser (unchanged)
  app/api/brain/
    chat/route.ts       ← Streaming RAG chat — now uses nvidiaChatStreamControlled
    sync/route.ts       ← Upsert note → Pinecone + documents table
    upload/route.ts     ← PDF/TXT/MD upload via multipart/form-data
    documents/route.ts  ← List + delete docs (joins notes table for ticker)
  components/
    BrainPanel.tsx      ← Full-screen chat overlay
    LivePipelineLog.tsx ← Pipeline event log
    NotesPanel.tsx       ← Note cards with Sync to Brain / ↻ / ✓ Brain buttons
    Sidebar.tsx          ← Chat RAG button replaces Date section
    ...
```

## License

Same as the original repo.
