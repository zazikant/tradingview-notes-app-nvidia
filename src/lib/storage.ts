import { Note, Tag, DEFAULT_TAGS } from '@/types';

const NOTES_KEY = 'tvnotes_v2';
const TAGS_KEY = 'tvtags_v2';

export function loadNotes(): Note[] {
  if (typeof window === 'undefined') return [];
  const stored = localStorage.getItem(NOTES_KEY);
  return stored ? JSON.parse(stored) : [];
}

export function saveNotes(notes: Note[]): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(NOTES_KEY, JSON.stringify(notes));
}

export function loadTags(): Tag[] {
  if (typeof window === 'undefined') return DEFAULT_TAGS.map(t => ({ ...t }));
  const stored = localStorage.getItem(TAGS_KEY);
  if (!stored) {
    const defaultTags = DEFAULT_TAGS.map(t => ({ ...t }));
    saveTags(defaultTags);
    return defaultTags;
  }
  return JSON.parse(stored);
}

export function saveTags(tags: Tag[]): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(TAGS_KEY, JSON.stringify(tags));
}

export function createSeedNotes(): Note[] {
  const now = Date.now();
  return [
    {
      id: uid(),
      ticker: 'AAPL',
      body: 'Strong breakout above 180 resistance. Volume confirmed. Watch for retest of breakout level before entering. Target 195, stop below 178.',
      tags: ['bull', 'idea'],
      created: now - 86400000 * 2,
    },
    {
      id: uid(),
      ticker: 'TSLA',
      body: 'Bearish divergence on RSI at 4H. Price rejected at 240 for the third time. Looking for a break below 225 to short. Volume declining on up moves.',
      tags: ['bear'],
      created: now - 86400000,
    },
    {
      id: uid(),
      ticker: 'NVDA',
      body: 'Earnings beat was massive. Holding position through the consolidation. AI tailwinds still strong. Will review after the next earnings cycle.',
      tags: ['bull', 'review'],
      created: now - 3600000 * 5,
    },
    {
      id: uid(),
      ticker: 'SPY',
      body: 'Adding to watchlist ahead of FOMC. Key support at 430. If we hold this level, could see push to 450. Risk-off if we close below 425.',
      tags: ['watch'],
      created: now - 3600000 * 2,
    },
    {
      id: uid(),
      ticker: 'META',
      body: 'Cup and handle formation on the weekly. Breakout target ~340. Fundamentals improving — ad revenue bounce is real. Setting alert at 298.',
      tags: ['bull', 'idea', 'watch'],
      created: now - 1800000,
    },
  ];
}

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}