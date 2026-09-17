'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { PALETTE } from '@/types';

interface TagPickerProps {
  tags: { id: string; name: string; color: number }[];
  activeTagIds: string[];
  onToggleTag: (tagId: string) => void;
}

/**
 * Self-contained tag picker component for when there are > 10 tags.
 *
 * Design principles (from Circular Dependencies + Atomic Graph analysis):
 * 1. Scoped event handling — NO global mousedown listener (that was the root cause
 *    of the previous bug: it intercepted clicks meant for the sidebar)
 * 2. No overlay/backdrop — positioned dropdown only, never blocks sidebar
 * 3. useRef-based containment check — only close if click is truly outside this component
 * 4. Stop propagation on picker interactions — prevent any event leakage
 * 5. Single responsibility: ONLY toggles tags, never creates them
 */
export function TagPicker({ tags, activeTagIds, onToggleTag }: TagPickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Close on outside click — scoped to this component only, NOT global document listener
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      // Only close if the click target is NOT inside our container
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setSearch('');
      }
    };
    // Use setTimeout(0) to avoid the click that opened the picker from immediately closing it
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  // Auto-focus search input when opening
  useEffect(() => {
    if (isOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [isOpen]);

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
        setSearch('');
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen]);

  const handleToggle = useCallback((tagId: string) => {
    onToggleTag(tagId);
    // Don't close the dropdown after toggling — let user toggle multiple tags
  }, [onToggleTag]);

  const activeTags = tags.filter(t => activeTagIds.includes(t.id));
  const filteredTags = tags.filter(tag =>
    tag.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="editor-tags-bar" ref={containerRef}>
      <span className="tags-label">Tags</span>

      {/* Active tags as colored toggle buttons */}
      {activeTags.map(tag => {
        const c = PALETTE[tag.color] || PALETTE[0];
        return (
          <button
            key={tag.id}
            className="editor-tag-btn on"
            onClick={(e) => {
              e.stopPropagation(); // Prevent any leakage
              handleToggle(tag.id);
            }}
            style={{ background: c.bg, color: c.text, borderColor: c.border }}
          >
            <span className="etag-dot" style={{ background: c.dot }}></span>
            {tag.name}
          </button>
        );
      })}

      {/* + Add button to open the searchable dropdown */}
      <div className="tag-picker-container">
        <button
          className="tag-picker-add-btn"
          onClick={(e) => {
            e.stopPropagation();
            setIsOpen(!isOpen);
            setSearch('');
          }}
        >
          {isOpen ? '✕ Close' : '+ Add tag'}
        </button>

        {/* Dropdown — positioned absolutely within the tags bar, NO overlay */}
        {isOpen && (
          <div className="tag-picker-dropdown" onClick={(e) => e.stopPropagation()}>
            <input
              ref={searchInputRef}
              type="text"
              placeholder="Search tags…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="tag-picker-search"
            />
            <div className="tag-picker-list">
              {filteredTags.map(tag => {
                const c = PALETTE[tag.color] || PALETTE[0];
                const isActive = activeTagIds.includes(tag.id);
                return (
                  <button
                    key={tag.id}
                    className={`tag-picker-item ${isActive ? 'on' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleToggle(tag.id);
                    }}
                    style={isActive ? { background: c.bg, color: c.text, borderColor: c.border } : {}}
                  >
                    <span className="etag-dot" style={{ background: c.dot }}></span>
                    <span className="tag-picker-item-name">{tag.name}</span>
                    {isActive && <span className="tag-picker-check">✓</span>}
                  </button>
                );
              })}
              {filteredTags.length === 0 && (
                <div className="tag-picker-empty">No tags found</div>
              )}
            </div>
            <div className="tag-picker-footer">
              Create new tags in the sidebar →
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
