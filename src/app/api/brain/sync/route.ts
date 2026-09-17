import { NextRequest, NextResponse } from 'next/server';
import { upsertDocument, deleteDocument, getDocument } from '@/lib/brain/documents';
import { upsertRecords, deleteRecords } from '@/lib/brain/pinecone';
import { hashText } from '@/lib/brain/hash';

export const runtime = 'nodejs';
export const maxDuration = 180; // embedding upsert can take a while on large notes

/**
 * POST /api/brain/sync
 *   Body: { noteId, ticker, body }
 *
 * Idempotent upsert:
 *   1. Compute sha256 of body.
 *   2. If a document row already exists with the same sha256 → no-op (return synced=true, chunks=0).
 *   3. Otherwise: upsert Pinecone vectors (delete old + re-embed), then upsert the documents row.
 *
 * Returns: { filename, inserted, sha256, chunks, alreadySynced }
 */
export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const noteId = typeof body?.noteId === 'string' ? body.noteId : null;
  const ticker = typeof body?.ticker === 'string' ? body.ticker : '';
  const text = typeof body?.body === 'string' ? body.body : '';

  if (!noteId) {
    return NextResponse.json({ error: 'noteId is required' }, { status: 400 });
  }
  if (!text.trim()) {
    return NextResponse.json(
      { error: 'note body is empty — nothing to sync' },
      { status: 400 },
    );
  }

  // Filename convention: note-<client_id>.txt
  const filename = `note-${noteId}.txt`;
  const newSha = hashText(text);

  try {
    // 1. Has it been synced with the same content already?
    const existing = await getDocument(filename);
    if (existing && existing.sha256 === newSha) {
      return NextResponse.json({
        filename,
        inserted: false,
        sha256: newSha,
        chunks: 0,
        alreadySynced: true,
      });
    }

    // 2. Re-embed (delete + upsert) into Pinecone.
    const upsertRes = await upsertRecords(text, filename, {
      doc_type: 'note',
      project: 'tradingview-notes',
      version: '1.0',
      uploaded_at: Date.now(),
      ticker,
      note_id: noteId,
    });

    if (upsertRes.status === 'error') {
      return NextResponse.json(
        { error: 'failed to embed note into Pinecone', detail: upsertRes },
        { status: 502 },
      );
    }

    // 3. Upsert the documents row.
    const doc = await upsertDocument(filename, text, null);

    return NextResponse.json({
      filename,
      inserted: doc.inserted,
      sha256: newSha,
      chunks: upsertRes.chunks,
      alreadySynced: false,
    });
  } catch (err: any) {
    console.error('[/api/brain/sync] error', err);
    return NextResponse.json(
      { error: err?.message || 'sync failed' },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/brain/sync?filename=note-abc.txt
 *
 * Removes the document row AND its Pinecone vectors. Used by the "remove from
 * Brain" button in the synced-docs list.
 */
export async function DELETE(req: NextRequest) {
  const filename = req.nextUrl.searchParams.get('filename');
  if (!filename) {
    return NextResponse.json(
      { error: 'filename query param is required' },
      { status: 400 },
    );
  }

  try {
    await deleteRecords(filename);
    await deleteDocument(filename);
    return NextResponse.json({ filename, deleted: true });
  } catch (err: any) {
    console.error('[/api/brain/sync DELETE] error', err);
    return NextResponse.json(
      { error: err?.message || 'delete failed' },
      { status: 500 },
    );
  }
}
