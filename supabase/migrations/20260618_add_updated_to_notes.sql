-- Migration: add `updated` column to notes table
--
-- Backs the "most-recently-edited note floats to top" feature ported from
-- zazikant/GEMs-notes-app (commit 219f8c4). The frontend now SELECTs, INSERTs,
-- and UPDATEs this column on every note write; without it, `loadNotes()` will
-- fail and the notes list will appear empty.
--
-- Run this once against the tradingview-notes-app Supabase project
-- (sdrjqrlvttbyrtkppfam) via the Supabase SQL editor.

-- 1. Add the column, matching the type of `created` (BIGINT epoch millis).
--    `IF NOT EXISTS` makes the migration idempotent.
ALTER TABLE notes
  ADD COLUMN IF NOT EXISTS updated BIGINT;

-- 2. Backfill existing rows so legacy notes sort by their creation time
--    until the next time they are edited.
UPDATE notes
   SET updated = created
 WHERE updated IS NULL;

-- 3. Optional: keep the column non-null going forward. We leave it nullable
--    in case there are concurrent inserts from older clients; the frontend
--    already falls back to `created` when `updated` is missing.
