export interface Tag {
  id: string;
  name: string;
  color: number;
}

export interface Note {
  id: string;
  ticker: string;
  body: string;
  tags: string[];
  created: number;
  // Timestamp of the most recent edit. Falls back to `created` for legacy rows.
  updated?: number;
}

export interface DateFilter {
  type: 'all' | 'custom';
}

export interface AppState {
  notes: Note[];
  tags: Tag[];
  activeId: string | null;
  currentFilter: DateFilter['type'];
  activeTagFilters: Set<string>;
  sortMode: 'newest' | 'oldest' | 'ticker';
  searchQuery: string;
  customFrom: number | null;
  customTo: number | null;
  mobilePanel: 'sidebar' | 'notes' | 'editor';
}

export type AppAction =
  | { type: 'SET_NOTES'; payload: Note[] }
  | { type: 'SET_TAGS'; payload: Tag[] }
  | { type: 'ADD_NOTE'; payload: Note }
  | { type: 'UPDATE_NOTE'; payload: Note }
  | { type: 'DELETE_NOTE'; payload: string }
  | { type: 'SET_ACTIVE_ID'; payload: string | null }
  | { type: 'SET_FILTER'; payload: DateFilter['type'] }
  | { type: 'SET_CUSTOM_RANGE'; payload: { from: number | null; to: number | null } }
  | { type: 'TOGGLE_TAG_FILTER'; payload: string }
  | { type: 'CLEAR_TAG_FILTERS' }
  | { type: 'SET_SORT_MODE'; payload: AppState['sortMode'] }
  | { type: 'SET_SEARCH_QUERY'; payload: string }
  | { type: 'SET_MOBILE_PANEL'; payload: AppState['mobilePanel'] }
  | { type: 'ADD_TAG'; payload: Tag }
  | { type: 'UPDATE_TAG'; payload: Tag }
  | { type: 'DELETE_TAG'; payload: string };

export const PALETTE = [
  { bg: '#e8f4e8', text: '#1e5c1e', dot: '#2e7d2e', border: '#b8d8b8' },
  { bg: '#faeaea', text: '#8b1a1a', dot: '#c0392b', border: '#e8b8b8' },
  { bg: '#fef3e2', text: '#7a4500', dot: '#e67e22', border: '#e8d0a8' },
  { bg: '#eef2ff', text: '#2d3a8c', dot: '#3b5bdb', border: '#b8c8f8' },
  { bg: '#f5f0ff', text: '#5b2d8c', dot: '#7950f2', border: '#d0b8f8' },
  { bg: '#fde8f4', text: '#7a1a4a', dot: '#c0396e', border: '#e8b8d4' },
  { bg: '#e8f8f5', text: '#0e5a48', dot: '#1abc9c', border: '#a8ddd4' },
  { bg: '#fff0e8', text: '#7a3010', dot: '#d35400', border: '#e8c8b0' },
  { bg: '#f0f4f8', text: '#2d3748', dot: '#4a5568', border: '#c0ccd8' },
  { bg: '#fefce8', text: '#7a6a00', dot: '#d4ac00', border: '#e8dca0' },
] as const;

export const DEFAULT_TAGS: Tag[] = [
  { id: 'bull', name: 'Bullish', color: 0 },
  { id: 'bear', name: 'Bearish', color: 1 },
  { id: 'watch', name: 'Watchlist', color: 2 },
  { id: 'idea', name: 'Trade idea', color: 3 },
  { id: 'review', name: 'Review', color: 4 },
];