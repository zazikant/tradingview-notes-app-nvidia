-- Migration: create `documents` table + Storage bucket for the integrated "Chat RAG" brain
--
-- Mirrors the schema of the `documents` table in rag-document-assistant-opencode.
-- Also creates the `documents` Storage bucket so PDFs can be uploaded directly
-- from the Chat Brain UI.
--
-- Run this once against the tradingview-notes-app Supabase project
-- (sdrjqrlvttbyrtkppfam) via the Supabase SQL editor:
--   https://supabase.com/dashboard/project/sdrjqrlvttbyrtkppfam/sql/new
--
-- Idempotent: safe to re-run.

-- ============================================================
-- 1. Documents table — one row per synced note or uploaded file.
--    `filename` is the natural primary key.
--    - Synced notes:     filename = `note-<client_id>.txt`, storage_path = NULL
--    - Uploaded PDFs:    filename = original (e.g. `report.pdf`), storage_path = filename
--    - Uploaded TXT/MD:  filename = original, storage_path = NULL (we only store text)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.documents (
  filename     text PRIMARY KEY,
  sha256       text NOT NULL,
  storage_path text,
  created_at   timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now()
);

-- ============================================================
-- 2. Enable Row Level Security with service-role-only access.
--    The Next.js API routes use SUPABASE_SERVICE_ROLE_KEY (server-only),
--    so they keep working. The anon role is blocked from direct access —
--    all Brain reads/writes must go through the API routes.
-- ============================================================
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service role full access on documents" ON public.documents;
CREATE POLICY "service role full access on documents"
  ON public.documents FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

-- ============================================================
-- 3. updated_at trigger — auto-stamps every UPDATE
-- ============================================================
CREATE OR REPLACE FUNCTION public.touch_documents_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS documents_touch_updated_at ON public.documents;
CREATE TRIGGER documents_touch_updated_at
  BEFORE UPDATE ON public.documents
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_documents_updated_at();

-- ============================================================
-- 4. Prefix index for `note-*.txt` scans
-- ============================================================
CREATE INDEX IF NOT EXISTS documents_filename_prefix_idx
  ON public.documents (filename text_pattern_ops);

-- ============================================================
-- 5. Storage bucket `documents` — holds raw PDF blobs.
--    Created via direct insert into storage.buckets (Supabase internal).
--    50 MB limit per file is plenty for PDFs.
-- ============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'documents',
  'documents',
  false,                                       -- private — only service_role can read/write
  52428800,                                    -- 50 MB
  ARRAY[
    'application/pdf',
    'text/plain',
    'text/markdown',
    'application/octet-stream'                 -- fallback for files with wrong mime detection
  ]
)
ON CONFLICT (id) DO UPDATE SET
  public       = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ============================================================
-- 6. Storage RLS policies — service-role only.
--    Without these, RLS blocks all bucket access (even for the service role
--    when going through the anon/authenticated HTTP path used by supabase-js).
-- ============================================================
-- Drop old policies if re-running.
DROP POLICY IF EXISTS "documents bucket service role read" ON storage.objects;
DROP POLICY IF EXISTS "documents bucket service role write" ON storage.objects;
DROP POLICY IF EXISTS "documents bucket service role delete" ON storage.objects;

-- Allow service_role to SELECT (download) objects in the documents bucket.
CREATE POLICY "documents bucket service role read"
  ON storage.objects FOR SELECT
  TO service_role
  USING (bucket_id = 'documents');

-- Allow service_role to INSERT (upload) objects in the documents bucket.
CREATE POLICY "documents bucket service role write"
  ON storage.objects FOR INSERT
  TO service_role
  WITH CHECK (bucket_id = 'documents');

-- Allow service_role to UPDATE (overwrite) objects in the documents bucket.
CREATE POLICY "documents bucket service role update"
  ON storage.objects FOR UPDATE
  TO service_role
  USING (bucket_id = 'documents')
  WITH CHECK (bucket_id = 'documents');

-- Allow service_role to DELETE objects in the documents bucket.
CREATE POLICY "documents bucket service role delete"
  ON storage.objects FOR DELETE
  TO service_role
  USING (bucket_id = 'documents');

-- ============================================================
-- 7. Refresh PostgREST schema cache so the new table is immediately
--    visible to the supabase-js client (otherwise you may see
--    "Could not find the table 'public.documents' in the schema cache"
--    for up to 60 seconds after running this migration).
-- ============================================================
NOTIFY pgrst, 'reload schema';
