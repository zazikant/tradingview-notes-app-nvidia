'use client';

import React, { createContext, useContext, useReducer, useEffect, useCallback, useMemo, useRef } from 'react';
import { AppState, AppAction, Note, Tag, PALETTE } from '@/types';
import { loadNotes, loadTags, seedIfEmpty, subscribeToNotes, subscribeToTags, updateNote as sbUpdateNote } from '@/lib/supabase';

const initialState: AppState = {
  notes: [],
  tags: [],
  activeId: null,
  currentFilter: 'all',
  activeTagFilters: new Set(),
  sortMode: 'newest',
  searchQuery: '',
  customFrom: null,
  customTo: null,
  mobilePanel: 'sidebar',
};

function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'SET_NOTES':
      return { ...state, notes: action.payload };
    case 'SET_TAGS':
      return { ...state, tags: action.payload };
    case 'ADD_NOTE':
      return { ...state, notes: [action.payload, ...state.notes], activeId: action.payload.id };
    case 'UPDATE_NOTE':
      return {
        ...state,
        notes: state.notes.map(n => (n.id === action.payload.id ? action.payload : n)),
      };
    case 'DELETE_NOTE': {
      const remaining = state.notes.filter(n => n.id !== action.payload);
      return {
        ...state,
        notes: remaining,
        activeId: remaining.length > 0 ? remaining[0].id : null,
      };
    }
    case 'SET_ACTIVE_ID':
      return { ...state, activeId: action.payload };
    case 'SET_FILTER':
      return { ...state, currentFilter: action.payload };
    case 'SET_CUSTOM_RANGE':
      return { ...state, customFrom: action.payload.from, customTo: action.payload.to };
    case 'TOGGLE_TAG_FILTER': {
      const newFilters = new Set(state.activeTagFilters);
      if (newFilters.has(action.payload)) {
        newFilters.delete(action.payload);
      } else {
        newFilters.add(action.payload);
      }
      return { ...state, activeTagFilters: newFilters };
    }
    case 'CLEAR_TAG_FILTERS':
      return { ...state, activeTagFilters: new Set() };
    case 'SET_SORT_MODE':
      return { ...state, sortMode: action.payload };
    case 'SET_SEARCH_QUERY':
      return { ...state, searchQuery: action.payload };
    case 'SET_MOBILE_PANEL':
      return { ...state, mobilePanel: action.payload };
    case 'ADD_TAG':
      return { ...state, tags: [...state.tags, action.payload] };
    case 'UPDATE_TAG':
      return {
        ...state,
        tags: state.tags.map(t => (t.id === action.payload.id ? action.payload : t)),
      };
    case 'DELETE_TAG':
      return {
        ...state,
        tags: state.tags.filter(t => t.id !== action.payload),
        notes: state.notes.map(n => ({
          ...n,
          tags: n.tags.filter(tagId => tagId !== action.payload),
        })),
        activeTagFilters: (() => {
          const newFilters = new Set(state.activeTagFilters);
          newFilters.delete(action.payload);
          return newFilters;
        })(),
      };
    default:
      return state;
  }
}

interface AppContextValue {
  state: AppState;
  dispatch: React.Dispatch<AppAction>;
  getFilteredNotes: () => Note[];
  getTag: (id: string) => Tag | undefined;
  getTagColor: (id: string) => typeof PALETTE[number];
  countFor: (filter: AppState['currentFilter']) => number;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(appReducer, initialState);
  const initialized = useRef(false);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    let unsubscribeNotes: (() => void) | null = null;
    let unsubscribeTags: (() => void) | null = null;

    const init = async () => {
      await seedIfEmpty();

      let [notes, tags] = await Promise.all([loadNotes(), loadTags()]);

      // ── Startup cleanup: fix orphaned references ──
      const validTagIds = new Set(tags.map(t => t.id));

      // 1. Strip orphaned tag IDs from notes
      let notesNeedCleanup = false;
      const cleanedNotes = notes.map(n => {
        if (n.tags.some(id => !validTagIds.has(id))) {
          notesNeedCleanup = true;
          return { ...n, tags: n.tags.filter(id => validTagIds.has(id)) };
        }
        return n;
      });

      // Persist cleaned notes to Supabase.
      // Use a Map keyed by note id for O(1) lookup instead of `notes.find()`
      // inside the loop — at 50k notes the previous O(n²) lookup was a
      // multi-second startup freeze.
      if (notesNeedCleanup) {
        const originalById = new Map(notes.map(n => [n.id, n]));
        for (const note of cleanedNotes) {
          const original = originalById.get(note.id);
          if (original && original.tags.length !== note.tags.length) {
            await sbUpdateNote(note);
          }
        }
      }

      // NOTE: We intentionally do NOT delete tags that have zero notes referencing them.
      // Previously, the "stale tag cleanup" would permanently delete unused tags from
      // Supabase on every page load, causing newly created tags to vanish if they
      // weren't immediately assigned to a note. Tags should persist until the user
      // explicitly deletes them.

      notes = cleanedNotes;
      // ── End cleanup ──

      dispatch({ type: 'SET_NOTES', payload: notes });
      dispatch({ type: 'SET_TAGS', payload: tags });

      unsubscribeNotes = subscribeToNotes((notes) => {
        dispatch({ type: 'SET_NOTES', payload: notes });
      });

      unsubscribeTags = subscribeToTags((tags) => {
        dispatch({ type: 'SET_TAGS', payload: tags });
      });
    };

    init();

    return () => {
      if (unsubscribeNotes) unsubscribeNotes();
      if (unsubscribeTags) unsubscribeTags();
    };
  }, []);

  // Memoize filtered notes — recalculates only when dependencies change, not on every render
  const filteredNotes = useMemo((): Note[] => {
    const { notes, currentFilter, activeTagFilters, sortMode, searchQuery, customFrom, customTo } = state;

    let filtered = [...notes];

    if (currentFilter === 'custom' && (customFrom || customTo)) {
      // customFrom / customTo are already IST day-boundaries stamped by the
      // Sidebar's date inputs (T00:00:00+05:30 / T23:59:59.999+05:30), so we
      // can compare `created` directly against them without any TZ conversion.
      filtered = filtered.filter(n => {
        if (customFrom && n.created < customFrom) return false;
        if (customTo && n.created > customTo) return false;
        return true;
      });
    }

    if (activeTagFilters.size > 0) {
      filtered = filtered.filter(n =>
        [...activeTagFilters].some(tagId => n.tags.includes(tagId))
      );
    }

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter(n =>
        n.ticker.toLowerCase().includes(q) || n.body.toLowerCase().includes(q)
      );
    }

    if (sortMode === 'newest') {
      // Most-recently-edited first: fall back to `created` for legacy rows
      // that haven't been written since the `updated` column was added.
      filtered.sort((a, b) => (b.updated ?? b.created) - (a.updated ?? a.created));
    } else if (sortMode === 'oldest') {
      filtered.sort((a, b) => a.created - b.created);
    } else {
      filtered.sort((a, b) => a.ticker.localeCompare(b.ticker));
    }

    return filtered;
  }, [state.notes, state.currentFilter, state.activeTagFilters, state.sortMode, state.searchQuery, state.customFrom, state.customTo]);

  // getFilteredNotes returns the memoized result (no re-computation on every render)
  const getFilteredNotes = useCallback((): Note[] => filteredNotes, [filteredNotes]);

  const getTag = useCallback(
    (id: string): Tag | undefined => {
      return state.tags.find(t => t.id === id);
    },
    [state.tags]
  );

  const getTagColor = useCallback(
    (id: string) => {
      const tag = getTag(id);
      return PALETTE[tag?.color ?? 0] || PALETTE[0];
    },
    [getTag]
  );

  // Consolidate countFor: reuse memoized filteredNotes instead of re-running filter logic
  const countFor = useCallback(
    (filter: AppState['currentFilter']): number => {
      if (filter === state.currentFilter) {
        // Same filter as currently displayed — return memoized count
        return filteredNotes.length;
      }
      // Different filter — compute only for that specific filter
      const { notes, customFrom, customTo } = state;
      let filtered = [...notes];

      if (filter === 'custom' && (customFrom || customTo)) {
        filtered = filtered.filter(n => {
          if (customFrom && n.created < customFrom) return false;
          if (customTo && n.created > customTo) return false;
          return true;
        });
      }

      return filtered.length;
    },
    [state, filteredNotes]
  );

  return (
    <AppContext.Provider value={{ state, dispatch, getFilteredNotes, getTag, getTagColor, countFor }}>
      {children}
    </AppContext.Provider>
  );
}

export function useAppContext() {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useAppContext must be used within AppProvider');
  }
  return context;
}