'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { useNotes } from '@/hooks/useNotes';
import { usePullToRefresh } from '@/hooks/usePullToRefresh';
import { PALETTE, Note } from '@/types';
import { relDate } from '@/lib/utils';

const PAGE_SIZE = 20;

export function NotesPanel() {
  const { filteredNotes, activeId, openNote, sortMode, setSortMode, deleteNote, exportSelectedNotes } = useNotes();
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [isLoading, setIsLoading] = useState(false);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const notesListRef = useRef<HTMLDivElement>(null);

  // ─── Brain sync state ────────────────────────────────────────────
  const [syncedNoteIds, setSyncedNoteIds] = useState<Set<string>>(new Set());
  const [syncingNoteIds, setSyncingNoteIds] = useState<Set<string>>(new Set());

  // ─── Multi-select state ──────────────────────────────────────────
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkAction, setBulkAction] = useState<'idle' | 'syncing' | 'deleting'>('idle');
  const [bulkProgress, setBulkProgress] = useState<{ current: number; total: number } | null>(null);
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);
  const [brainFilter, setBrainFilter] = useState<'all' | 'in' | 'not-in'>('all');

  // Load the list of synced documents and mark each as a synced note id.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/brain/documents?notes=1', { cache: 'no-store' });
        if (!r.ok) return;
        const json = await r.json();
        const ids: string[] = (json.documents || [])
          .map((d: { filename: string }) => {
            const m = d.filename.match(/^note-(.+)\.txt$/);
            return m ? m[1] : null;
          })
          .filter(Boolean) as string[];
        if (!cancelled) setSyncedNoteIds(new Set(ids));
      } catch (err) {
        console.warn('[NotesPanel] failed to load synced docs', err);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Single-note sync (preserved for the per-card Sync button when not in select mode)
  const handleSyncToBrain = useCallback(async (note: Note, e: React.MouseEvent) => {
    e.stopPropagation();
    if (syncingNoteIds.has(note.id)) return;
    setSyncingNoteIds((prev) => new Set(prev).add(note.id));

    try {
      const r = await fetch('/api/brain/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          noteId: note.id,
          ticker: note.ticker || '',
          body: note.body || '',
        }),
      });
      if (!r.ok) {
        const errJson = await r.json().catch(() => ({}));
        alert(`Sync failed: ${errJson.error || r.statusText}`);
        return;
      }
      setSyncedNoteIds((prev) => new Set(prev).add(note.id));
    } catch (err: any) {
      alert(`Sync failed: ${err?.message || 'network error'}`);
    } finally {
      setSyncingNoteIds((prev) => {
        const n = new Set(prev);
        n.delete(note.id);
        return n;
      });
    }
  }, [syncingNoteIds]);

  // ─── Remove a single note from the Brain (NO confirm dialog — user said no prompts) ───
  // Called when user clicks ✓ Brain on an already-synced note card.
  const removeFromBrain = useCallback(async (note: Note, e: React.MouseEvent) => {
    e.stopPropagation();
    const filename = `note-${note.id}.txt`;
    // Optimistically remove the badge so the UI feels instant.
    setSyncedNoteIds((prev) => {
      const n = new Set(prev);
      n.delete(note.id);
      return n;
    });
    try {
      const r = await fetch(`/api/brain/documents?filename=${encodeURIComponent(filename)}`, {
        method: 'DELETE',
      });
      if (!r.ok) {
        // Rollback on failure.
        setSyncedNoteIds((prev) => new Set(prev).add(note.id));
        const err = await r.json().catch(() => ({}));
        alert(`Failed to remove from Brain: ${err.error || r.statusText}`);
      }
    } catch (err: any) {
      setSyncedNoteIds((prev) => new Set(prev).add(note.id));
      alert(`Failed to remove from Brain: ${err?.message || 'network error'}`);
    }
  }, []);

  // ─── Bulk actions ────────────────────────────────────────────────
  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    setSelectedIds(new Set());
    setBulkAction('idle');
    setBulkProgress(null);
  }, []);

  // ─── Bulk remove from Brain ───────────────────────────────────────
  const handleBulkRemoveFromBrain = useCallback(async () => {
    if (selectedIds.size === 0 || bulkAction !== 'idle') return;
    setBulkAction('deleting');
    setBulkProgress({ current: 0, total: selectedIds.size });

    const ids = Array.from(selectedIds);
    let successCount = 0;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      setBulkProgress({ current: i + 1, total: ids.length });
      if (syncedNoteIds.has(id)) {
        try {
          await fetch(`/api/brain/documents?filename=${encodeURIComponent(`note-${id}.txt`)}`, {
            method: 'DELETE',
          });
          successCount++;
        } catch (err) {
          console.error('[NotesPanel] bulk remove from Brain error for', id, err);
        }
      }
    }
    // Update synced set
    const newSynced = new Set(syncedNoteIds);
    for (const id of ids) newSynced.delete(id);
    setSyncedNoteIds(newSynced);

    setBulkAction('idle');
    setBulkProgress(null);
    setSelectMode(false);
    setSelectedIds(new Set());
    if (successCount > 0) {
      alert(`Removed ${successCount} note${successCount !== 1 ? 's' : ''} from the Brain.`);
    }
  }, [selectedIds, bulkAction, syncedNoteIds]);

  const handleBulkSync = useCallback(async () => {
    if (selectedIds.size === 0 || bulkAction !== 'idle') return;
    setBulkAction('syncing');
    setBulkProgress({ current: 0, total: selectedIds.size });

    const ids = Array.from(selectedIds);
    let successCount = 0;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const note = filteredNotes.find((n) => n.id === id);
      if (!note) continue;
      setBulkProgress({ current: i + 1, total: ids.length });
      setSyncingNoteIds((prev) => new Set(prev).add(id));
      try {
        const r = await fetch('/api/brain/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            noteId: note.id,
            ticker: note.ticker || '',
            body: note.body || '',
          }),
        });
        if (r.ok) {
          setSyncedNoteIds((prev) => new Set(prev).add(id));
          successCount++;
        }
      } catch (err) {
        console.error('[NotesPanel] bulk sync error for', id, err);
      } finally {
        setSyncingNoteIds((prev) => {
          const n = new Set(prev);
          n.delete(id);
          return n;
        });
      }
    }
    setBulkAction('idle');
    setBulkProgress(null);
    setSelectMode(false);
    setSelectedIds(new Set());
    alert(`Synced ${successCount} of ${ids.length} notes to the Brain.`);
  }, [selectedIds, bulkAction, filteredNotes]);

  const handleBulkDeleteConfirm = useCallback(async () => {
    if (selectedIds.size === 0 || bulkAction !== 'idle') return;
    setShowBulkDeleteConfirm(false);
    setBulkAction('deleting');
    setBulkProgress({ current: 0, total: selectedIds.size });

    const ids = Array.from(selectedIds);
    let successCount = 0;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      setBulkProgress({ current: i + 1, total: ids.length });
      try {
        // If the note was synced to the Brain, also remove it from the Brain
        // (cascades Pinecone + Storage + documents row).
        if (syncedNoteIds.has(id)) {
          try {
            await fetch(`/api/brain/documents?filename=${encodeURIComponent(`note-${id}.txt`)}`, {
              method: 'DELETE',
            });
          } catch (err) {
            console.warn('[NotesPanel] failed to clean Brain for', id, err);
          }
          setSyncedNoteIds((prev) => {
            const n = new Set(prev);
            n.delete(id);
            return n;
          });
        }
        await deleteNote(id);
        successCount++;
      } catch (err) {
        console.error('[NotesPanel] bulk delete error for', id, err);
      }
    }
    setBulkAction('idle');
    setBulkProgress(null);
    setSelectMode(false);
    setSelectedIds(new Set());
    alert(`Deleted ${successCount} of ${ids.length} notes.`);
  }, [selectedIds, bulkAction, syncedNoteIds, deleteNote]);

  // Pull-to-refresh support
  const { containerRef: pullRef, pullState, pullDistance } = usePullToRefresh(70, () => {
    window.location.reload();
  });

  const setListRef = useCallback((el: HTMLDivElement | null) => {
    (pullRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
    (notesListRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
  }, [pullRef]);

  useEffect(() => {
    const el = notesListRef.current;
    if (el) {
      (el as any).__scrollToTop = () => { el.scrollTop = 0; };
    }
  }, []);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [filteredNotes.length, sortMode]);

  const loadMore = useCallback(() => {
    setIsLoading(true);
    setTimeout(() => {
      setVisibleCount(prev => Math.min(prev + PAGE_SIZE, filteredNotes.length));
      setIsLoading(false);
    }, 150);
  }, [filteredNotes.length]);

  useEffect(() => {
    if (!loadMoreRef.current) return;
    const observer = new IntersectionObserver(
      entries => {
        if (entries[0].isIntersecting && visibleCount < filteredNotes.length && !isLoading) {
          loadMore();
        }
      },
      { threshold: 0.1 }
    );
    observer.observe(loadMoreRef.current);
    return () => observer.disconnect();
  }, [visibleCount, filteredNotes.length, isLoading, loadMore]);

  const visibleNotes = filteredNotes.slice(0, visibleCount);
  const hasMore = visibleCount < filteredNotes.length;

  // Apply the brain filter on top of filteredNotes. This is a local
  // filter — doesn't touch global state, so tag filters + search still work.
  // 'all' = show everything, 'in' = only synced, 'not-in' = only unsynced.
  const displayNotes = brainFilter === 'all'
    ? filteredNotes
    : brainFilter === 'in'
      ? filteredNotes.filter((n) => syncedNoteIds.has(n.id))
      : filteredNotes.filter((n) => !syncedNoteIds.has(n.id));
  const displayVisibleNotes = displayNotes.slice(0, visibleCount);
  const displayHasMore = visibleCount < displayNotes.length;

  // Select-all helper — uses displayVisibleNotes (respects In Brain filter).
  const selectAllVisible = useCallback(() => {
    setSelectedIds(new Set(displayVisibleNotes.map((n) => n.id)));
  }, [displayVisibleNotes]);

  return (
    <div className="notes-panel">
      <div className="panel-header">
        <span className="panel-title">Notes</span>
        <span className="notes-count" id="listCount">
          {displayNotes.length} note{displayNotes.length !== 1 ? 's' : ''}
          {brainFilter !== 'all' && (
            <span className="notes-count-filter">
              {' '}· {brainFilter === 'in' ? 'in Brain' : 'not in Brain'}
            </span>
          )}
        </span>
        <select
          className="brain-filter-select"
          value={brainFilter}
          onChange={(e) => setBrainFilter(e.target.value as 'all' | 'in' | 'not-in')}
          title="Filter by Brain sync status"
        >
          <option value="all">All notes</option>
          <option value="in">🧠 In Brain</option>
          <option value="not-in">○ Not in Brain</option>
        </select>
        <select
          className="sort-select"
          value={sortMode}
          onChange={e => setSortMode(e.target.value as 'newest' | 'oldest' | 'ticker')}
        >
          <option value="newest">Newest</option>
          <option value="oldest">Oldest</option>
          <option value="ticker">Ticker A–Z</option>
        </select>
        <button
          type="button"
          className={`panel-select-btn ${selectMode ? 'active' : ''}`}
          onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
          disabled={bulkAction !== 'idle'}
          title={selectMode ? 'Exit select mode' : 'Select multiple notes'}
        >
          {selectMode ? '✕' : '☑'}
        </button>
      </div>

      {/* Bulk action bar — only visible in select mode */}
      {selectMode && (
        <div className="bulk-action-bar">
          <div className="bulk-action-left">
            <span className="bulk-count">
              {selectedIds.size} selected
            </span>
            {filteredNotes.length > 0 && (
              <button
                type="button"
                className="bulk-link-btn"
                onClick={selectedIds.size === visibleNotes.length ? clearSelection : selectAllVisible}
                disabled={bulkAction !== 'idle'}
              >
                {selectedIds.size === visibleNotes.length && selectedIds.size > 0
                  ? 'Clear'
                  : 'Select all visible'}
              </button>
            )}
          </div>
          <div className="bulk-action-right">
            {bulkProgress && (
              <span className="bulk-progress">
                {bulkAction === 'syncing' ? 'Syncing' : 'Deleting'} {bulkProgress.current}/{bulkProgress.total}…
              </span>
            )}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={exitSelectMode}
              disabled={bulkAction !== 'idle'}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={handleBulkSync}
              disabled={selectedIds.size === 0 || bulkAction !== 'idle'}
              title="Sync selected notes to the Brain (re-syncs already-synced ones)"
            >
              🧠 Sync ({selectedIds.size})
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                const selectedNotes = displayVisibleNotes.filter(n => selectedIds.has(n.id));
                if (selectedNotes.length > 0) {
                  exportSelectedNotes(selectedNotes);
                }
              }}
              disabled={selectedIds.size === 0 || bulkAction !== 'idle'}
              title="Export selected notes as CSV"
            >
              ⬇ Export ({selectedIds.size})
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={handleBulkRemoveFromBrain}
              disabled={selectedIds.size === 0 || bulkAction !== 'idle'}
              title="Remove selected notes from the Brain (notes are NOT deleted, only removed from Brain)"
            >
              ✕ Brain ({selectedIds.size})
            </button>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              onClick={() => setShowBulkDeleteConfirm(true)}
              disabled={selectedIds.size === 0 || bulkAction !== 'idle'}
            >
              Delete ({selectedIds.size})
            </button>
          </div>
        </div>
      )}

      <div className="notes-list" id="notesList" ref={setListRef} style={{ position: 'relative' }}>
        {/* Pull-to-refresh indicator (mobile only) */}
        <div
          className={`pull-refresh-indicator ${pullState !== 'idle' ? 'visible' : ''} ${pullState === 'ready' ? 'ready' : ''}`}
          style={{ transform: `translateX(-50%) translateY(${Math.max(0, pullDistance.current - 44)}px)` }}
        >
          {pullState === 'refreshing' ? (
            <><span className="spinner" /> Refreshing...</>
          ) : pullState === 'ready' ? (
            'Release to refresh'
          ) : (
            'Pull to refresh'
          )}
        </div>
        {displayNotes.length === 0 ? (
          <div style={{ padding: '2rem 1rem', textAlign: 'center', color: 'var(--muted)', fontSize: '13px', fontFamily: 'Syne, sans-serif' }}>
            {brainFilter === 'in' ? 'No synced notes found. Switch to "All notes" to see everything.' :
             brainFilter === 'not-in' ? 'All notes are synced to the Brain! 🎉' :
             'No notes found'}
          </div>
        ) : (
          <>
            {displayVisibleNotes.map(note => (
              <NoteCard
                key={note.id}
                note={note}
                isActive={note.id === activeId}
                onClick={() => openNote(note.id)}
                synced={syncedNoteIds.has(note.id)}
                syncing={syncingNoteIds.has(note.id)}
                onSyncToBrain={handleSyncToBrain}
                onRemoveFromBrain={removeFromBrain}
                selectMode={selectMode}
                selected={selectedIds.has(note.id)}
                onToggleSelect={() => toggleSelect(note.id)}
                disabled={bulkAction !== 'idle'}
              />
            ))}
            {displayHasMore && (
              <div ref={loadMoreRef} className="load-more-trigger">
                {isLoading && (
                  <div className="load-more-spinner">
                    <span>Loading...</span>
                  </div>
                )}
              </div>
            )}
            {!displayHasMore && displayNotes.length > PAGE_SIZE && (
              <div className="all-loaded-msg">
                All {displayNotes.length} notes loaded
              </div>
            )}
          </>
        )}
      </div>

      {/* Bulk delete confirmation modal */}
      {showBulkDeleteConfirm && (
        <div
          className="modal-overlay show"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowBulkDeleteConfirm(false);
          }}
        >
          <div className="modal-box">
            <div className="modal-title">Delete {selectedIds.size} note{selectedIds.size !== 1 ? 's' : ''}?</div>
            <div className="modal-msg">
              These notes will be permanently deleted. Notes already synced to the Brain will also be removed from the Brain (Pinecone + Storage bucket + documents table).
              This action cannot be undone.
            </div>
            <div className="modal-actions">
              <button
                className="btn btn-ghost"
                onClick={() => setShowBulkDeleteConfirm(false)}
                disabled={bulkAction !== 'idle'}
              >
                Cancel
              </button>
              <button
                className="btn btn-danger"
                onClick={handleBulkDeleteConfirm}
                disabled={bulkAction !== 'idle'}
              >
                Yes, Delete {selectedIds.size}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface NoteCardProps {
  note: Note;
  isActive: boolean;
  onClick: () => void;
  synced: boolean;
  syncing: boolean;
  onSyncToBrain: (note: Note, e: React.MouseEvent) => void;
  onRemoveFromBrain: (note: Note, e: React.MouseEvent) => void;
  selectMode: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  disabled: boolean;
}

function NoteCard({ note, isActive, onClick, synced, syncing, onSyncToBrain, onRemoveFromBrain, selectMode, selected, onToggleSelect, disabled }: NoteCardProps) {
  const { getTag, getTagColor } = useNotes();

  const handleCardClick = (e: React.MouseEvent) => {
    if (selectMode) {
      e.preventDefault();
      e.stopPropagation();
      if (!disabled) onToggleSelect();
      return;
    }
    onClick();
  };

  // ↻ Re-sync button (only shown when already synced) — sits LEFT of the Brain button.
  const handleResync = (e: React.MouseEvent) => {
    e.stopPropagation();
    onSyncToBrain(note, e);  // idempotent — re-embeds if content changed
  };

  // ✓ Brain button — when synced, click removes from Brain (NO confirm dialog).
  // When not synced, click syncs.
  const handleBrainClick = (e: React.MouseEvent) => {
    if (synced) {
      onRemoveFromBrain(note, e);
    } else {
      onSyncToBrain(note, e);
    }
  };

  return (
    <div
      className={`note-card ${isActive ? 'active' : ''} ${selected ? 'selected' : ''} ${selectMode ? 'select-mode' : ''}`}
      onClick={handleCardClick}
    >
      {/* Checkbox in select mode (top-left corner) */}
      {selectMode && (
        <div
          className={`note-checkbox ${selected ? 'checked' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            if (!disabled) onToggleSelect();
          }}
        >
          {selected ? '✓' : ''}
        </div>
      )}
      <div className="note-card-top">
        <span className="note-ticker" style={{ whiteSpace: 'pre-wrap' }}>{note.ticker || '—'}</span>
        <div className="note-card-top-right">
          {synced && <span className="note-brain-badge" title="In Brain">🧠</span>}
          <span className="note-date-small">{relDate(note.created)}</span>
        </div>
      </div>
      <div className="note-preview">
        {note.body || <span style={{ color: 'var(--border)' }}>No content</span>}
      </div>
      <div className="note-tags-row">
        {note.tags.map(tagId => {
          const tag = getTag(tagId);
          if (!tag) return null;
          const c = getTagColor(tagId);
          return (
            <span key={tagId} className="tag-pill" style={{ background: c.bg, color: c.text }}>
              {tag.name}
            </span>
          );
        })}
        {/* Hide per-card buttons in select mode */}
        {!selectMode && (
          <>
            {/* ↻ Re-sync button — LEFT of Brain button, only shown when synced */}
            {synced && (
              <button
                className={`note-resync-btn ${syncing ? 'syncing' : ''}`}
                onClick={handleResync}
                disabled={syncing}
                title="Re-sync to Brain (re-embeds if content changed)"
              >
                {syncing ? '⏳' : '↻'}
              </button>
            )}
            {/* ✓ Brain button — toggles sync/remove */}
            <button
              className={`note-sync-btn ${synced ? 'synced' : ''} ${syncing ? 'syncing' : ''}`}
              onClick={handleBrainClick}
              disabled={syncing}
              title={synced ? 'Click to remove from Brain' : 'Sync to Brain'}
            >
              {syncing ? '⏳' : synced ? '✓ Brain' : '🧠 Sync'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
