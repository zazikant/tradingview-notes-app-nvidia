import { NextRequest, NextResponse } from 'next/server';
import { upsertDocument, deleteDocument, uploadToStorage, STORAGE_BUCKET } from '@/lib/brain/documents';
import { upsertRecords, deleteRecords } from '@/lib/brain/pinecone';
import { liteParse } from '@/lib/brain/liteparse';

export const runtime = 'nodejs';
export const maxDuration = 180; // large PDFs take a while to parse + embed

const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB — matches storage bucket limit

/**
 * POST /api/brain/upload (multipart/form-data)
 *
 * Form fields:
 *   file   — the file to upload (PDF, TXT, MD, or JSON). Required unless mode=Delete.
 *   name   — override filename (optional). Defaults to file.name.
 *   mode   — 'Add' (default) | 'Replace' | 'Delete'
 *
 * Pipeline:
 *   1. Validate extension (pdf/txt/md/json) and size.
 *   2. liteParse → extract text content. For PDFs, also keep the raw buffer.
 *   3. Compute sha256 — short-circuit if a doc row already has the same sha256.
 *   4. For PDFs: upload raw bytes to Storage bucket `documents` (storage_path = filename).
 *      For TXT/MD/JSON: skip Storage (storage_path = NULL — text is in Pinecone metadata).
 *   5. Upsert vectors into Pinecone (delete old + re-embed).
 *   6. Upsert documents row.
 *
 * Returns: { filename, status, chunks, pages?, sha256 }
 *   status: 'added' | 'updated' | 'skipped' | 'deleted' | 'error'
 */
export async function POST(req: NextRequest) {
  const contentType = req.headers.get('content-type') || '';
  if (!contentType.includes('multipart/form-data')) {
    return NextResponse.json(
      { error: 'Content-Type must be multipart/form-data' },
      { status: 400 },
    );
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: 'invalid form data' }, { status: 400 });
  }

  const file = formData.get('file') as File | null;
  const nameOverride = formData.get('name') as string | null;
  const mode = (formData.get('mode') as string) || 'Add';

  if (!['Add', 'Replace', 'Delete'].includes(mode)) {
    return NextResponse.json(
      { error: 'Invalid mode. Must be: Add, Replace, or Delete' },
      { status: 400 },
    );
  }

  const filename = (nameOverride || file?.name || '').trim();
  if (!filename) {
    return NextResponse.json(
      { error: 'Missing filename (name field or file.name)' },
      { status: 400 },
    );
  }

  // ─── DELETE mode ────────────────────────────────────────────────
  if (mode === 'Delete') {
    try {
      await deleteRecords(filename);
      await deleteDocument(filename);
      return NextResponse.json({ filename, status: 'deleted' });
    } catch (err: any) {
      console.error('[/api/brain/upload DELETE] error', err);
      return NextResponse.json(
        { error: err?.message || 'delete failed' },
        { status: 500 },
      );
    }
  }

  if (!file) {
    return NextResponse.json(
      { error: 'Missing file field' },
      { status: 400 },
    );
  }

  // ─── Validate extension ────────────────────────────────────────
  const ext = filename.toLowerCase().split('.').pop() || '';
  if (!['pdf', 'txt', 'md', 'json'].includes(ext)) {
    return NextResponse.json(
      { error: `Unsupported file format: .${ext}. Supported: PDF, TXT, MD, JSON.` },
      { status: 400 },
    );
  }

  // ─── Validate size ──────────────────────────────────────────────
  if (file.size > MAX_FILE_BYTES) {
    return NextResponse.json(
      {
        error: `File too large: ${(file.size / 1024 / 1024).toFixed(1)} MB. Max: 50 MB.`,
      },
      { status: 413 },
    );
  }

  // ─── Read file into buffer ──────────────────────────────────────
  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const isPdf = ext === 'pdf';

  // ─── Parse text ─────────────────────────────────────────────────
  let text: string;
  let pages: number | undefined;
  try {
    const parsed = await liteParse(buffer, isPdf ? 'pdf' : 'text', filename);
    if (!parsed.success) {
      return NextResponse.json(
        { error: `Parse failed: ${parsed.error}` },
        { status: 400 },
      );
    }
    text = parsed.text;
    pages = parsed.pages;
  } catch (err: any) {
    console.error('[/api/brain/upload] parse error', err);
    return NextResponse.json(
      { error: `Parse failed: ${err?.message || 'unknown'}` },
      { status: 500 },
    );
  }

  if (!text || !text.trim()) {
    return NextResponse.json(
      { error: 'No text content extracted from the file' },
      { status: 400 },
    );
  }

  try {
    // ─── Upload to Storage (PDFs only — preserves raw bytes for re-download) ───
    let storagePath: string | null = null;
    if (isPdf) {
      try {
        storagePath = await uploadToStorage(
          filename,
          buffer,
          file.type || 'application/pdf',
        );
      } catch (err: any) {
        return NextResponse.json(
          { error: `Storage upload failed: ${err.message}` },
          { status: 500 },
        );
      }
    }

    // ─── Upsert Pinecone vectors ────────────────────────────────
    let upsertRes;
    try {
      upsertRes = await upsertRecords(text, filename, {
        doc_type: isPdf ? 'pdf' : 'text',
        project: 'tradingview-notes',
        version: '1.0',
        uploaded_at: Date.now(),
        ticker: '',
        note_id: '',
      });
    } catch (err: any) {
      console.error('[/api/brain/upload] pinecone error', err);
      return NextResponse.json(
        { error: `Pinecone upsert failed: ${err?.message || 'unknown'}` },
        { status: 502 },
      );
    }

    if (upsertRes.status === 'error') {
      return NextResponse.json(
        { error: 'Pinecone embedding returned error', detail: upsertRes },
        { status: 502 },
      );
    }

    // ─── Upsert documents row ───────────────────────────────────
    const doc = await upsertDocument(filename, text, storagePath);

    return NextResponse.json({
      filename,
      status: doc.inserted ? 'added' : 'updated',
      chunks: upsertRes.chunks,
      pages,
      sha256: doc.sha256,
    });
  } catch (err: any) {
    console.error('[/api/brain/upload] unhandled error', err);
    return NextResponse.json(
      { error: err?.message || 'upload failed' },
      { status: 500 },
    );
  }
}

/**
 * GET /api/brain/upload — returns the Storage bucket name + file size limit
 * for the UI to display in the upload dropzone.
 */
export async function GET() {
  return NextResponse.json({
    bucket: STORAGE_BUCKET,
    maxSize: MAX_FILE_BYTES,
    allowedExtensions: ['pdf', 'txt', 'md', 'json'],
  });
}
