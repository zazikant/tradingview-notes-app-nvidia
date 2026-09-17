import { NextRequest, NextResponse } from 'next/server';
import { listDocuments, deleteDocument } from '@/lib/brain/documents';
import { deleteRecords } from '@/lib/brain/pinecone';
import { getSupabaseAdmin } from '@/lib/brain/supabase-admin';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * GET /api/brain/documents
 *
 * Returns the list of all Brain documents — synced notes AND uploaded files.
 *
 * Pass ?notes=1 to filter to only synced notes (filename LIKE 'note-%').
 *
 * For rows whose filename matches the synced-note convention `note-<client_id>.txt`,
 * we also look up the note in the `notes` table and return its `ticker`.
 * The Brain UI uses this ticker to display a human-readable label instead of
 * the random client_id, and to power search-by-ticker.
 *
 * Each row: { filename, sha256, storage_path, created_at, updated_at, ticker? }
 */
export async function GET(req: NextRequest) {
  const notesOnly = req.nextUrl.searchParams.get('notes') === '1';
  try {
    const docs = await listDocuments(notesOnly ? 'note-' : null);

    // Enrich: for rows that look like synced notes, fetch the ticker from the notes table.
    const noteIdsToLookup: string[] = [];
    for (const d of docs) {
      const m = d.filename.match(/^note-(.+)\.txt$/);
      if (m) noteIdsToLookup.push(m[1]);
    }

    let tickerMap: Map<string, string> = new Map();
    if (noteIdsToLookup.length > 0) {
      try {
        const supabase = getSupabaseAdmin();
        const { data: noteRows, error } = await supabase
          .from('notes')
          .select('client_id, ticker')
          .in('client_id', noteIdsToLookup);
        if (!error && noteRows) {
          for (const row of noteRows) {
            tickerMap.set(row.client_id, row.ticker || '');
          }
        }
      } catch (err) {
        // Non-fatal — just means the ticker column won't be populated this round.
        console.warn('[/api/brain/documents] ticker lookup failed', err);
      }
    }

    const enriched = docs.map((d) => {
      const m = d.filename.match(/^note-(.+)\.txt$/);
      if (m) {
        const ticker = tickerMap.get(m[1]) || '';
        return { ...d, ticker };
      }
      return { ...d, ticker: '' };
    });

    return NextResponse.json({ documents: enriched });
  } catch (err: any) {
    console.error('[/api/brain/documents GET] error', err);
    return NextResponse.json(
      { error: err?.message || 'list failed' },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/brain/documents?filename=note-abc.txt
 *
 * Removes a single document + its Pinecone vectors.
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
    console.error('[/api/brain/documents DELETE] error', err);
    return NextResponse.json(
      { error: err?.message || 'delete failed' },
      { status: 500 },
    );
  }
}
