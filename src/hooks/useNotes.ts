'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useAppContext } from '@/context/AppContext';
import { Note, Tag, AppState } from '@/types';
import { uid, fullDate, exportNotesToCSV, parseNotesFromCSV, parseCSVRows } from '@/lib/utils';
import { addNote as sbAddNote, updateNote as sbUpdateNote, deleteNote as sbDeleteNote, addTag as sbAddTag, updateTag as sbUpdateTag, deleteTag as sbDeleteTag } from '@/lib/supabase';

export function useNotes() {
  const { state, dispatch, getFilteredNotes, getTag, getTagColor, countFor } = useAppContext();
  const autoSaveTimer = useRef<NodeJS.Timeout | null>(null);
  const isDirty = useRef(false);
  const lastSavedNote = useRef<string>('');

  // Always-fresh mirror of state.notes. The save handlers below are invoked
  // synchronously right after a dispatch (e.g. Save button → updateCurrentNote
  // → saveCurrentNote), and React's `state.notes` in the useCallback closure
  // is still stale at that point. Reading from this ref avoids clobbering the
  // freshly-typed body with an older snapshot — which was the cause of large
  // pasted text disappearing on Save.
  const latestNotesRef = useRef<Note[]>(state.notes);
  useEffect(() => {
    latestNotesRef.current = state.notes;
  }, [state.notes]);

  const activeNote = state.notes.find(n => n.id === state.activeId) || null;

  // Check if the current note has unsaved changes
  const getIsDirty = useCallback((): boolean => {
    return isDirty.current;
  }, []);

  const createNote = useCallback(async () => {
    const newNote: Note = {
      id: uid(),
      ticker: '',
      body: '',
      tags: [],
      created: Date.now(),
    };
    dispatch({ type: 'ADD_NOTE', payload: newNote });
    await sbAddNote(newNote);
    isDirty.current = false;
    lastSavedNote.current = JSON.stringify(newNote);
    if (typeof window !== 'undefined' && window.innerWidth <= 768) {
      dispatch({ type: 'SET_MOBILE_PANEL', payload: 'editor' });
    }
    return newNote;
  }, [dispatch]);

  const openNote = useCallback(
    (id: string) => {
      // Reset dirty state when switching notes
      isDirty.current = false;
      const note = state.notes.find(n => n.id === id);
      if (note) {
        lastSavedNote.current = JSON.stringify(note);
      }
      dispatch({ type: 'SET_ACTIVE_ID', payload: id });
      if (typeof window !== 'undefined' && window.innerWidth <= 768) {
        dispatch({ type: 'SET_MOBILE_PANEL', payload: 'editor' });
      }
    },
    [state.notes, dispatch]
  );

  // Update local state ONLY — does NOT persist to Supabase
  const updateCurrentNote = useCallback(
    (updates: Partial<Pick<Note, 'ticker' | 'body' | 'tags'>>) => {
      if (!state.activeId) return;
      // Read from the ref so we always merge onto the freshest note, even
      // when called multiple times in the same tick (e.g. when the Save
      // button dispatches a renumbered body and immediately calls
      // saveCurrentNote).
      const note = latestNotesRef.current.find(n => n.id === state.activeId);
      if (!note) return;

      const updated: Note = {
        ...note,
        ...updates,
        ticker: updates.ticker !== undefined ? updates.ticker : note.ticker,
      };

      // Mark as dirty since we changed local state without persisting
      isDirty.current = true;

      // Keep the ref in sync immediately so a subsequent saveCurrentNote()
      // in the same tick sees the updated note.
      latestNotesRef.current = latestNotesRef.current.map(n =>
        n.id === updated.id ? updated : n
      );

      dispatch({ type: 'UPDATE_NOTE', payload: updated });
    },
    [state.activeId, dispatch]
  );

  // Explicitly save the current note to Supabase.
  // `overrides` (optional) is merged onto the freshest note before saving —
  // use this when the caller has computed a final body (e.g. renumbered)
  // and wants to persist it in the same tick without waiting for a re-render.
  const saveCurrentNote = useCallback(async (
    overrides?: Partial<Pick<Note, 'ticker' | 'body' | 'tags'>>
  ) => {
    if (!state.activeId) return;
    const note = latestNotesRef.current.find(n => n.id === state.activeId);
    if (!note) return;

    // Clear any pending auto-save
    if (autoSaveTimer.current) {
      clearTimeout(autoSaveTimer.current);
      autoSaveTimer.current = null;
    }

    // Apply overrides (if any) onto the freshest note BEFORE stamping/persist.
    const merged: Note = overrides
      ? { ...note, ...overrides, ticker: overrides.ticker !== undefined ? overrides.ticker : note.ticker }
      : note;

    // Stamp `updated` on local state BEFORE persisting so the list re-sorts
    // immediately (newest = most-recently-edited first).
    const now = Date.now();
    const stamped = { ...merged, updated: now };

    // Keep the ref in sync immediately so any subsequent read (e.g. a second
    // saveCurrentNote in the same tick) sees the stamped note.
    latestNotesRef.current = latestNotesRef.current.map(n =>
      n.id === stamped.id ? stamped : n
    );

    dispatch({ type: 'UPDATE_NOTE', payload: stamped });

    await sbUpdateNote(stamped);
    isDirty.current = false;
    lastSavedNote.current = JSON.stringify(stamped);
  }, [state.activeId]);

  // Schedule a debounced auto-save — only persists if dirty
  const scheduleAutoSave = useCallback(() => {
    if (autoSaveTimer.current) {
      clearTimeout(autoSaveTimer.current);
    }
    autoSaveTimer.current = setTimeout(async () => {
      if (state.activeId && isDirty.current) {
        // Read from the ref so we persist the freshest note, not the stale
        // closure snapshot from when scheduleAutoSave was created.
        const note = latestNotesRef.current.find(n => n.id === state.activeId);
        if (note) {
          // Stamp `updated` locally before persisting so the list re-sorts.
          const now = Date.now();
          const stamped = { ...note, updated: now };

          latestNotesRef.current = latestNotesRef.current.map(n =>
            n.id === stamped.id ? stamped : n
          );

          dispatch({ type: 'UPDATE_NOTE', payload: stamped });
          await sbUpdateNote(stamped);
          isDirty.current = false;
          lastSavedNote.current = JSON.stringify(stamped);
        }
      }
    }, 2000); // 2 second debounce — longer than before to let user type freely
  }, [state.activeId]);

  // Discard unsaved changes — revert to last saved state
  const discardChanges = useCallback(() => {
    if (!state.activeId) return;

    // Clear any pending auto-save
    if (autoSaveTimer.current) {
      clearTimeout(autoSaveTimer.current);
      autoSaveTimer.current = null;
    }

    try {
      const saved = JSON.parse(lastSavedNote.current) as Note;
      if (saved && saved.id === state.activeId) {
        // Keep the ref in sync so subsequent saves see the reverted note.
        latestNotesRef.current = latestNotesRef.current.map(n =>
          n.id === saved.id ? saved : n
        );
        dispatch({ type: 'UPDATE_NOTE', payload: saved });
        isDirty.current = false;
      }
    } catch {
      // If we can't parse the saved state, just mark as clean
      isDirty.current = false;
    }
  }, [state.activeId, dispatch]);

  const deleteNote = useCallback(
    async (id: string) => {
      dispatch({ type: 'DELETE_NOTE', payload: id });
      await sbDeleteNote(id);
      isDirty.current = false;
    },
    [dispatch]
  );

  const copyNote = useCallback(
    (id: string) => {
      const note = state.notes.find(n => n.id === id);
      if (!note) return;

      const tagNames = note.tags.map(t => getTag(t)?.name).filter(Boolean).join(', ');
      const text = `${note.ticker}\n${fullDate(note.created)}${tagNames ? `\nTags: ${tagNames}` : ''}\n\n${note.body}`;
      navigator.clipboard.writeText(text);
    },
    [state.notes, getTag]
  );

  const toggleEditorTag = useCallback(
    async (tagId: string) => {
      if (!state.activeId) return;
      const note = latestNotesRef.current.find(n => n.id === state.activeId);
      if (!note) return;

      const newTags = note.tags.includes(tagId)
        ? note.tags.filter(t => t !== tagId)
        : [...note.tags, tagId];

      // Tag toggles persist immediately (considered a deliberate action).
      // Stamp `updated` so the note floats to the top of the newest-sorted list.
      const now = Date.now();
      const updated = { ...note, tags: newTags, updated: now };

      latestNotesRef.current = latestNotesRef.current.map(n =>
        n.id === updated.id ? updated : n
      );

      dispatch({ type: 'UPDATE_NOTE', payload: updated });
      await sbUpdateNote(updated);
      isDirty.current = false;
      lastSavedNote.current = JSON.stringify(updated);
    },
    [state.activeId, dispatch]
  );

  const exportAllNotes = useCallback(() => {
    exportNotesToCSV(state.notes, state.tags);
  }, [state.notes, state.tags]);

  // Export only the given subset of notes (used by NotesPanel select mode).
  const exportSelectedNotes = useCallback((notesToExport: Note[]) => {
    if (notesToExport.length === 0) return;
    exportNotesToCSV(notesToExport, state.tags);
  }, [state.tags]);

  const importNotesFromCSV = useCallback(async (csv: string): Promise<number> => {
    const { notes: newNotes, newTags, skipped } = parseNotesFromCSV(csv, state.tags, state.notes);
    // Add new tags first
    for (const tag of newTags) {
      dispatch({ type: 'ADD_TAG', payload: tag });
      await sbAddTag(tag);
    }
    // Import notes, stripping any orphaned tag references
    const validTagIds = new Set([...state.tags, ...newTags].map(t => t.id));
    for (const note of newNotes) {
      const cleaned = { ...note, tags: note.tags.filter(id => validTagIds.has(id)) };
      dispatch({ type: 'ADD_NOTE', payload: cleaned });
      await sbAddNote(cleaned);
    }
    // Also sync imported notes to the Brain so they're immediately searchable.
    // This is non-blocking — if Brain sync fails, the notes are still imported.
    // We do this after all notes are added so the UI doesn't hang.
    if (newNotes.length > 0) {
      (async () => {
        for (const note of newNotes) {
          const cleaned = note; // already cleaned above
          try {
            await fetch('/api/brain/sync', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                noteId: cleaned.id,
                ticker: cleaned.ticker || '',
                body: cleaned.body || '',
              }),
            });
          } catch (err) {
            console.warn('[importNotesFromCSV] brain sync failed for', cleaned.id, err);
          }
        }
      })();
    }
    return skipped;
  }, [state.tags, state.notes, dispatch]);

  const deleteMatchingNotes = useCallback(async (csv: string): Promise<number> => {
    const rows = parseCSVRows(csv);
    if (rows.length < 2) return 0;

    // Detect column layout from header
    const header = rows[0].map(h => h.trim().toLowerCase());
    const tickerIdx = header.indexOf('ticker');
    const tIdx = tickerIdx >= 0 ? tickerIdx : 0;

    const tickersToDelete = new Set<string>();
    for (let i = 1; i < rows.length; i++) {
      const parts = rows[i];
      if (parts.every(p => !p.trim())) continue;
      const ticker = (parts[tIdx] || '').replace(/""/g, '"').trim();
      if (ticker) tickersToDelete.add(ticker.toLowerCase());
    }

    const toDelete = state.notes.filter(n => tickersToDelete.has(n.ticker.trim().toLowerCase()));
    for (const note of toDelete) {
      dispatch({ type: 'DELETE_NOTE', payload: note.id });
      await sbDeleteNote(note.id);
    }
    return toDelete.length;
  }, [state.notes, dispatch]);

  return {
    notes: state.notes,
    tags: state.tags,
    activeId: state.activeId,
    activeNote,
    currentFilter: state.currentFilter,
    activeTagFilters: state.activeTagFilters,
    sortMode: state.sortMode,
    searchQuery: state.searchQuery,
    customFrom: state.customFrom,
    customTo: state.customTo,
    mobilePanel: state.mobilePanel,
    filteredNotes: getFilteredNotes(),
    getTag,
    getTagColor,
    isDirty: getIsDirty,
    createNote,
    openNote,
    updateCurrentNote,
    saveCurrentNote,
    scheduleAutoSave,
    discardChanges,
    deleteNote,
    copyNote,
    toggleEditorTag,
    setFilter: (filter: AppState['currentFilter']) =>
      dispatch({ type: 'SET_FILTER', payload: filter }),
    setCustomRange: (from: number | null, to: number | null) =>
      dispatch({ type: 'SET_CUSTOM_RANGE', payload: { from, to } }),
    toggleTagFilter: (tagId: string) =>
      dispatch({ type: 'TOGGLE_TAG_FILTER', payload: tagId }),
    clearTagFilters: () => dispatch({ type: 'CLEAR_TAG_FILTERS' }),
    setSortMode: (mode: AppState['sortMode']) =>
      dispatch({ type: 'SET_SORT_MODE', payload: mode }),
    setSearchQuery: (query: string) =>
      dispatch({ type: 'SET_SEARCH_QUERY', payload: query }),
    setMobilePanel: (panel: AppState['mobilePanel']) =>
      dispatch({ type: 'SET_MOBILE_PANEL', payload: panel }),
    addTag: async (tag: Tag) => {
      dispatch({ type: 'ADD_TAG', payload: tag });
      try {
        await sbAddTag(tag);
      } catch {
        // Rollback optimistic update if Supabase insert fails
        dispatch({ type: 'DELETE_TAG', payload: tag.id });
      }
    },
    updateTag: async (tag: Tag) => {
      dispatch({ type: 'UPDATE_TAG', payload: tag });
      await sbUpdateTag(tag);
    },
    deleteTag: async (tagId: string) => {
      // Find all notes that reference this tag before deleting
      const affectedNotes = state.notes.filter(n => n.tags.includes(tagId));
      dispatch({ type: 'DELETE_TAG', payload: tagId });
      await sbDeleteTag(tagId);
      // Persist tag removal from notes to Supabase
      for (const note of affectedNotes) {
        const updated = { ...note, tags: note.tags.filter(t => t !== tagId) };
        await sbUpdateNote(updated);
      }
    },
    exportAllNotes,
    exportSelectedNotes,
    importNotesFromCSV,
    deleteMatchingNotes,
    countFor,
  };
}
