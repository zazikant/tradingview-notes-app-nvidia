'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { Topbar } from '@/components/Topbar';
import { Sidebar } from '@/components/Sidebar';
import { NotesPanel } from '@/components/NotesPanel';
import { Editor } from '@/components/Editor';
import { ToastManager, showToast } from '@/components/Toast';
import { PinLock } from '@/components/PinLock';
import { BrainPanel } from '@/components/BrainPanel';
import { useNotes } from '@/hooks/useNotes';
import { uid, fullDate } from '@/lib/utils';
import { PALETTE } from '@/types';

export default function Home() {
  // PIN lock state — app is hidden until unlocked
  const [isUnlocked, setIsUnlocked] = useState(false);
  // Brain panel open state
  const [showBrain, setShowBrain] = useState(false);
  // Count of synced documents — refreshed when the brain panel closes
  const [brainSyncedCount, setBrainSyncedCount] = useState(0);

  const {
    activeId,
    activeNote,
    createNote,
    deleteNote,
    copyNote,
    setMobilePanel,
    mobilePanel,
    tags,
    updateTag,
    deleteTag,
    getTag,
    saveCurrentNote,
  } = useNotes();

  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showDeleteTagModal, setShowDeleteTagModal] = useState(false);
  const [showRenameTagModal, setShowRenameTagModal] = useState(false);
  const [pendingDeleteTagId, setPendingDeleteTagId] = useState<string | null>(null);
  const [pendingRenameTagId, setPendingRenameTagId] = useState<string | null>(null);
  const [renameTagName, setRenameTagName] = useState('');
  const [renameTagColor, setRenameTagColor] = useState(0);
  const [tickerToDelete, setTickerToDelete] = useState('');

  const sidebarRef = useRef<HTMLElement>(null);
  const notesListRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);

  // Handle new note
  const handleNew = useCallback(() => {
    createNote();
  }, [createNote]);

  // Handle delete note
  const handleDelete = useCallback(() => {
    if (!activeId || !activeNote) {
      showToast('No note selected');
      return;
    }
    setTickerToDelete(activeNote.ticker || 'this note');
    setShowDeleteModal(true);
  }, [activeId, activeNote]);

  // Confirm delete note
  const handleConfirmDelete = useCallback(() => {
    if (activeId) {
      deleteNote(activeId);
      setShowDeleteModal(false);
      showToast('Note deleted');
    }
  }, [activeId, deleteNote]);

  // Handle copy note
  const handleCopy = useCallback(() => {
    if (activeId) {
      copyNote(activeId);
      showToast('Copied to clipboard');
    }
  }, [activeId, copyNote]);

  // Handle save — now just shows confirmation toast (actual save is in Editor via saveCurrentNote)
  const handleSave = useCallback(() => {
    showToast('Note saved');
  }, []);

  // Handle tag delete
  const handleOpenDeleteTag = useCallback((tagId: string) => {
    const tag = getTag(tagId);
    if (!tag) return;
    setPendingDeleteTagId(tagId);
    setShowDeleteTagModal(true);
  }, [getTag]);

  const handleConfirmDeleteTag = useCallback(() => {
    if (pendingDeleteTagId) {
      deleteTag(pendingDeleteTagId);
      setShowDeleteTagModal(false);
      setPendingDeleteTagId(null);
      showToast('Tag deleted');
    }
  }, [pendingDeleteTagId, deleteTag]);

  // Handle tag rename
  const handleOpenRenameTag = useCallback((tagId: string) => {
    const tag = getTag(tagId);
    if (!tag) return;
    setPendingRenameTagId(tagId);
    setRenameTagName(tag.name);
    setRenameTagColor(tag.color);
    setShowRenameTagModal(true);
  }, [getTag]);

  const handleConfirmRenameTag = useCallback(() => {
    if (!pendingRenameTagId || !renameTagName.trim()) return;
    if (tags.some(t => t.id !== pendingRenameTagId && t.name.toLowerCase() === renameTagName.trim().toLowerCase())) {
      showToast('Tag name already exists');
      return;
    }
    const tag = getTag(pendingRenameTagId);
    if (tag) {
      updateTag({ ...tag, name: renameTagName.trim(), color: renameTagColor });
      setShowRenameTagModal(false);
      setPendingRenameTagId(null);
      showToast('Tag updated');
    }
  }, [pendingRenameTagId, renameTagName, renameTagColor, tags, getTag, updateTag]);

  const handleCloseDeleteTagModal = useCallback(() => {
    setShowDeleteTagModal(false);
    setPendingDeleteTagId(null);
  }, []);

  const handleCloseRenameTagModal = useCallback(() => {
    setShowRenameTagModal(false);
    setPendingRenameTagId(null);
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        saveCurrentNote().then(() => handleSave());
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault();
        handleNew();
      }
      if (e.key === 'Escape') {
        setShowDeleteModal(false);
        setShowDeleteTagModal(false);
        setShowRenameTagModal(false);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleNew, handleSave, saveCurrentNote]);

  // Handle resize for mobile state initialization
  useEffect(() => {
    const handleResize = () => {
      if (typeof window !== 'undefined' && window.innerWidth > 768) {
        // Reset mobile panel on desktop
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Mobile back button handler
  const handleMobileBack = useCallback(() => {
    if (mobilePanel === 'editor') {
      setMobilePanel('notes');
    } else if (mobilePanel === 'notes') {
      setMobilePanel('sidebar');
    }
  }, [mobilePanel, setMobilePanel]);

  // Scroll-to-top for the active mobile panel
  // When user taps the already-active nav button, scroll that panel to top
  const handleMobileNav = useCallback((panel: 'sidebar' | 'notes' | 'editor') => {
    if (panel === mobilePanel) {
      // Already on this panel — scroll to top
      const panelEl = document.querySelector(
        panel === 'sidebar' ? '.sidebar' :
        panel === 'notes' ? '.notes-list' :
        '.editor-textarea'
      ) as HTMLElement | null;

      if (panelEl) {
        // Use the __scrollToTop method if available (exposed by usePullToRefresh components)
        if ((panelEl as any).__scrollToTop) {
          (panelEl as any).__scrollToTop();
        } else {
          panelEl.scrollTop = 0;
        }
      }
    } else {
      setMobilePanel(panel);
    }
  }, [mobilePanel, setMobilePanel]);

  // PIN lock handler
  const handleUnlock = useCallback(() => {
    setIsUnlocked(true);
  }, []);

  // Brain panel handlers — also refresh the synced count when it closes
  const handleOpenBrain = useCallback(() => {
    setShowBrain(true);
  }, []);
  const handleCloseBrain = useCallback(() => {
    setShowBrain(false);
    // Refresh the count after a beat so the sidebar badge updates
    setTimeout(() => {
      fetch('/api/brain/documents', { cache: 'no-store' })
        .then((r) => r.ok ? r.json() : null)
        .then((json) => {
          if (json?.documents) setBrainSyncedCount(json.documents.length);
        })
        .catch(() => {});
    }, 300);
  }, []);

  // Load the synced-docs count once on first unlock so the sidebar shows it immediately
  useEffect(() => {
    if (!isUnlocked) return;
    fetch('/api/brain/documents', { cache: 'no-store' })
      .then((r) => r.ok ? r.json() : null)
      .then((json) => {
        if (json?.documents) setBrainSyncedCount(json.documents.length);
      })
      .catch(() => {});
  }, [isUnlocked]);

  // Show PIN lock screen if not yet unlocked
  if (!isUnlocked) {
    return (
      <>
        <PinLock onUnlock={handleUnlock} />
        <ToastManager />
      </>
    );
  }

  return (
    <>
      <Topbar onDelete={handleDelete} onNew={handleNew} />

      <div className="layout" data-panel={mobilePanel}>
        <Sidebar
          onOpenRenameTag={handleOpenRenameTag}
          onOpenDeleteTag={handleOpenDeleteTag}
          onOpenBrain={handleOpenBrain}
          brainSyncedCount={brainSyncedCount}
        />
        <NotesPanel />
        <Editor onCopy={handleCopy} onDelete={handleDelete} onSave={handleSave} />
      </div>

      {showBrain && <BrainPanel onClose={handleCloseBrain} />}

      {/* Mobile Bottom Nav */}
      <nav className="mobile-nav">
        <button
          className={`mobile-nav-btn ${mobilePanel === 'sidebar' ? 'active' : ''}`}
          onClick={() => handleMobileNav('sidebar')}
        >
          <span className="mobile-nav-icon">☰</span>
          Filters
        </button>
        <button
          className={`mobile-nav-btn ${mobilePanel === 'notes' ? 'active' : ''}`}
          onClick={() => handleMobileNav('notes')}
        >
          <span className="mobile-nav-icon">📋</span>
          Notes
        </button>
        <button
          className={`mobile-nav-btn ${mobilePanel === 'editor' ? 'active' : ''}`}
          onClick={() => handleMobileNav('editor')}
        >
          <span className="mobile-nav-icon">✏️</span>
          Editor
        </button>
      </nav>

      <ToastManager />

      {/* Delete note confirm */}
      <div
        className={`modal-overlay ${showDeleteModal ? 'show' : ''}`}
        onClick={e => {
          if (e.target === e.currentTarget) setShowDeleteModal(false);
        }}
      >
        <div className="modal-box modal-delete-box">
          <div className="modal-delete-icon">⚠️</div>
          <div className="modal-title">Delete this note?</div>
          <div className="modal-msg">
            &quot;{tickerToDelete}&quot; will be permanently deleted. This action cannot be undone.
          </div>
          <div className="modal-actions">
            <button className="btn btn-ghost modal-btn-cancel" onClick={() => setShowDeleteModal(false)}>
              Cancel
            </button>
            <button className="btn btn-danger modal-btn-confirm-delete" onClick={handleConfirmDelete}>
              Yes, Delete
            </button>
          </div>
        </div>
      </div>

      {/* Delete tag confirm */}
      <div
        className={`modal-overlay ${showDeleteTagModal ? 'show' : ''}`}
        onClick={e => {
          if (e.target === e.currentTarget) handleCloseDeleteTagModal();
        }}
      >
        <div className="modal-box">
          <div className="modal-title">Delete tag?</div>
          <div className="modal-msg">
            {pendingDeleteTagId && getTag(pendingDeleteTagId)
              ? `"${getTag(pendingDeleteTagId)?.name}" will be removed from notes. This cannot be undone.`
              : 'This cannot be undone.'}
          </div>
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={handleCloseDeleteTagModal}>
              Cancel
            </button>
            <button className="btn btn-danger" onClick={handleConfirmDeleteTag}>
              Delete tag
            </button>
          </div>
        </div>
      </div>

      {/* Rename tag modal */}
      <div
        className={`modal-overlay ${showRenameTagModal ? 'show' : ''}`}
        onClick={e => {
          if (e.target === e.currentTarget) handleCloseRenameTagModal();
        }}
      >
        <div className="modal-box">
          <div className="modal-title">Edit tag</div>
          <input
            className="rename-input"
            maxLength={20}
            placeholder="Tag name…"
            value={renameTagName}
            onChange={e => setRenameTagName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') handleConfirmRenameTag();
            }}
          />
          <div className="modal-color-row">
            <div className="modal-color-label">Color</div>
            <div className="color-swatches">
              {PALETTE.map((c, i) => (
                <span
                  key={i}
                  className={`swatch ${i === renameTagColor ? 'selected' : ''}`}
                  style={{ background: c.dot }}
                  onClick={() => setRenameTagColor(i)}
                />
              ))}
            </div>
          </div>
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={handleCloseRenameTagModal}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={handleConfirmRenameTag}>
              Save
            </button>
          </div>
        </div>
      </div>
    </>
  );
}