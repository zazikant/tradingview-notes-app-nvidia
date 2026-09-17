'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { useNotes } from '@/hooks/useNotes';
import { usePullToRefresh } from '@/hooks/usePullToRefresh';
import { PALETTE, Tag } from '@/types';

interface SidebarProps {
  onOpenRenameTag: (tagId: string) => void;
  onOpenDeleteTag: (tagId: string) => void;
  onOpenBrain: () => void;
  brainSyncedCount: number;
}

export function Sidebar({ onOpenRenameTag, onOpenDeleteTag, onOpenBrain, brainSyncedCount }: SidebarProps) {
  const {
    tags,
    activeTagFilters,
    toggleTagFilter,
    clearTagFilters,
    addTag,
  } = useNotes();

  const [showAddTagForm, setShowAddTagForm] = useState(false);
  const [newTagName, setNewTagName] = useState('');
  const [selectedNewColor, setSelectedNewColor] = useState(0);
  const [tagSearch, setTagSearch] = useState('');
  const sidebarRef = useRef<HTMLElement>(null);

  // Pull-to-refresh support
  const { containerRef: pullRef, pullState, pullDistance } = usePullToRefresh(70, () => {
    window.location.reload();
  });

  // Merge pullRef and sidebarRef
  const setSidebarRef = useCallback((el: HTMLElement | null) => {
    (pullRef as React.MutableRefObject<HTMLDivElement | null>).current = el as any;
    (sidebarRef as React.MutableRefObject<HTMLElement | null>).current = el;
  }, [pullRef]);

  // Expose scroll-to-top for parent
  useEffect(() => {
    const el = sidebarRef.current;
    if (el) {
      (el as any).__scrollToTop = () => { el.scrollTop = 0; };
    }
  }, []);

  // Handle adding a new tag
  const handleAddTag = useCallback(() => {
    if (!newTagName.trim()) return;
    if (tags.some(t => t.name.toLowerCase() === newTagName.trim().toLowerCase())) {
      return;
    }
    const id = 'tag_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    addTag({ id, name: newTagName.trim(), color: selectedNewColor });
    setNewTagName('');
    setSelectedNewColor(0);
    setShowAddTagForm(false);
  }, [newTagName, selectedNewColor, tags, addTag]);

  return (
    <aside className="sidebar" ref={setSidebarRef} style={{ position: 'relative' }}>
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

      {/* Chat Brain button — replaces the former Date / Custom-range section */}
      <div className="sidebar-section">
        <div className="sidebar-label">Brain</div>
        <button
          className="filter-btn brain-btn"
          onClick={onOpenBrain}
          title="Open Chat Brain — ask questions over your synced notes"
        >
          <span className="filter-icon">🧠</span> Chat RAG{' '}
          <span className="count">{brainSyncedCount > 0 ? brainSyncedCount : '·'}</span>
        </button>
        <div className="brain-hint">
          Sync notes via the 🧠 button on each note card, then ask questions here.
        </div>
      </div>

      <div className="sidebar-divider"></div>

      {/* Tags */}
      <div className="sidebar-section">
        <div className="sidebar-label">
          Tags
          <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
            <button
              className="sidebar-label-action"
              id="clearTagsBtn"
              onClick={clearTagFilters}
              title="Clear tag selection"
              style={{
                display: activeTagFilters.size > 0 ? 'inline-block' : 'none',
                fontSize: '11px',
                fontFamily: 'Syne, sans-serif',
                fontWeight: 600,
                letterSpacing: '0.04em',
              }}
            >
              Clear
            </button>
            <button
              className="sidebar-label-action"
              onClick={() => setShowAddTagForm(!showAddTagForm)}
              title="Add tag"
            >
              +
            </button>
          </div>
        </div>
      </div>

      {/* Add tag form */}
      <div className={`add-tag-form ${showAddTagForm ? 'open' : ''}`}>
        <div className="add-tag-row">
          <input
            className="add-tag-input"
            placeholder="Tag name…"
            maxLength={20}
            value={newTagName}
            onChange={e => setNewTagName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') handleAddTag();
            }}
          />
        </div>
        <div className="color-swatches">
          {PALETTE.map((color, i) => (
            <span
              key={i}
              className={`swatch ${i === selectedNewColor ? 'selected' : ''}`}
              style={{ background: color.dot }}
              onClick={() => setSelectedNewColor(i)}
            />
          ))}
        </div>
        <div className="add-tag-actions">
          <button className="btn btn-primary btn-sm" onClick={handleAddTag}>
            Add tag
          </button>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => setShowAddTagForm(false)}
          >
            Cancel
          </button>
        </div>
      </div>

      {/* Tag search */}
      <div style={{ padding: '0 1rem 0.5rem' }}>
        <input
          type="text"
          placeholder="Search tags…"
          value={tagSearch}
          onChange={e => setTagSearch(e.target.value)}
          style={{
            width: '100%',
            background: 'var(--surface2)',
            border: '1px solid var(--border)',
            borderRadius: '6px',
            padding: '5px 8px',
            fontFamily: 'var(--font-epilogue), Epilogue, sans-serif',
            fontSize: '12px',
            color: 'var(--text)',
            outline: 'none',
          }}
        />
      </div>

      <div className="tag-list">
        {tags
          .filter(tag => tag.name.toLowerCase().includes(tagSearch.toLowerCase()))
          .map(tag => {
          const c = PALETTE[tag.color] || PALETTE[0];
          const isActive = activeTagFilters.has(tag.id);
          return (
            <button
              key={tag.id}
              className={`tag-filter ${isActive ? 'active-tag' : ''}`}
              onClick={() => toggleTagFilter(tag.id)}
              style={isActive ? { background: c.bg, color: c.text } : {}}
            >
              <span className="tag-filter-dot" style={{ background: c.dot }}></span>
              <span className="tag-filter-name">{tag.name}</span>
              <span className="tag-actions">
                <span
                  className="tag-action-btn"
                  onClick={e => {
                    e.stopPropagation();
                    onOpenRenameTag(tag.id);
                  }}
                  title="Edit"
                >
                  ✎
                </span>
                <span
                  className="tag-action-btn del"
                  onClick={e => {
                    e.stopPropagation();
                    onOpenDeleteTag(tag.id);
                  }}
                  title="Delete"
                >
                  ✕
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}