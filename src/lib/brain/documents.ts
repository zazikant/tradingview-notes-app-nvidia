import { getSupabaseAdmin } from './supabase-admin';
import { hashText } from './hash';

/**
 * Documents table + Storage bucket CRUD.
 *
 * Schema (created by `supabase/migrations/20260917_create_documents_table.sql`):
 *   filename     text PRIMARY KEY
 *   sha256       text NOT NULL
 *   storage_path text          (NULL for synced notes & plain-text uploads;
 *                              equals filename for PDFs stored in the bucket)
 *   created_at   timestamptz DEFAULT now()
 *   updated_at   timestamptz DEFAULT now()
 *
 * Storage bucket `documents` (created in the same migration):
 *   - Private bucket (only service_role can read/write)
 *   - 50 MB per-file limit
 *   - Allowed mime types: application/pdf, text/plain, text/markdown
 *
 * RLS is ENABLED with service-role-only policies on both the table and the bucket.
 * All access from the app must go through this module (which uses the service role key).
 */

export const STORAGE_BUCKET = 'documents';

export interface BrainDocument {
  filename: string;
  sha256: string;
  storage_path: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Upload a binary blob to the `documents` storage bucket.
 * Returns the storage_path (== the filename passed in) on success.
 *
 * Used by PDF uploads — the original PDF is preserved in the bucket so users
 * can re-download / re-parse later without re-uploading.
 *
 * For synced notes & plain-text uploads, this is NOT called (storage_path stays NULL).
 */
export async function uploadToStorage(
  filename: string,
  buffer: Buffer,
  contentType: string = 'application/pdf',
): Promise<string> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(filename, buffer, {
      contentType,
      upsert: true,  // overwrite if exists (idempotent re-uploads)
    });

  if (error) {
    throw new Error(`Storage upload failed: ${error.message}`);
  }
  return filename;
}

/**
 * Delete a file from the `documents` storage bucket.
 * No-op if the file doesn't exist.
 */
export async function deleteFromStorage(filename: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .remove([filename]);
  // Supabase returns no error if the file didn't exist — only real errors throw.
  if (error) {
    console.warn(`Storage delete failed for ${filename}: ${error.message}`);
  }
}

/**
 * Upsert a document row.
 *
 * @param filename     Primary key (e.g. `note-abc123.txt` or `report.pdf`)
 * @param text         Parsed text content — used to compute sha256 for dedup
 * @param storagePath  NULL for synced notes & plain-text uploads;
 *                     equals filename for PDFs stored in the bucket.
 *
 * Returns true if a new row was inserted (vs updated).
 */
export async function upsertDocument(
  filename: string,
  text: string,
  storagePath: string | null = null,
): Promise<{ inserted: boolean; sha256: string }> {
  const supabase = getSupabaseAdmin();
  const sha256 = hashText(text);
  const now = new Date().toISOString();

  // Check if row already exists with the same sha256 — if so, no-op.
  const { data: existing, error: selErr } = await supabase
    .from('documents')
    .select('filename, sha256')
    .eq('filename', filename)
    .maybeSingle();

  if (selErr) {
    throw new Error(`documents select failed: ${selErr.message}`);
  }

  if (existing && existing.sha256 === sha256) {
    // Content unchanged — bump updated_at for visibility, but skip Pinecone re-embed.
    await supabase
      .from('documents')
      .update({ updated_at: now })
      .eq('filename', filename);
    return { inserted: false, sha256 };
  }

  const { error: upErr } = await supabase.from('documents').upsert(
    {
      filename,
      sha256,
      storage_path: storagePath,
      updated_at: now,
    },
    { onConflict: 'filename' },
  );

  if (upErr) {
    throw new Error(`documents upsert failed: ${upErr.message}`);
  }

  return { inserted: !existing, sha256 };
}

/**
 * Delete a document row + its bucket file (if any) by filename.
 * Caller is responsible for also deleting Pinecone vectors (pinecone.ts `deleteRecords`).
 */
export async function deleteDocument(filename: string): Promise<void> {
  const supabase = getSupabaseAdmin();

  // Look up the row first to see if there's a storage_path to remove.
  const { data: existing } = await supabase
    .from('documents')
    .select('storage_path')
    .eq('filename', filename)
    .maybeSingle();

  if (existing?.storage_path) {
    await deleteFromStorage(existing.storage_path);
  }

  const { error } = await supabase
    .from('documents')
    .delete()
    .eq('filename', filename);
  if (error) {
    throw new Error(`documents delete failed: ${error.message}`);
  }
}

/**
 * List all documents in the Brain. Optionally filter by a filename prefix.
 *
 * @param prefix  Pass `'note-'` to list only synced notes. Pass `null` to list everything.
 */
export async function listDocuments(
  prefix: string | null = null,
): Promise<BrainDocument[]> {
  const supabase = getSupabaseAdmin();
  let query = supabase
    .from('documents')
    .select('filename, sha256, storage_path, created_at, updated_at')
    .order('updated_at', { ascending: false })
    .limit(500);

  if (prefix) {
    query = query.like('filename', `${prefix}%`);
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(`documents list failed: ${error.message}`);
  }
  return (data || []) as BrainDocument[];
}

/**
 * Get a single document row, or null if not found.
 */
export async function getDocument(
  filename: string,
): Promise<BrainDocument | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('documents')
    .select('filename, sha256, storage_path, created_at, updated_at')
    .eq('filename', filename)
    .maybeSingle();

  if (error) {
    throw new Error(`documents get failed: ${error.message}`);
  }
  return (data as BrainDocument) || null;
}
