'use client';

import { useState } from 'react';
import { PALETTE, Tag } from '@/types';

interface ModalsProps {
  onDeleteNote: () => void;
  onDeleteTag: (tagId: string) => void;
  onRenameTag: (tagId: string, name: string, color: number) => void;
  onConfirmDeleteTag: () => void;
  onCloseDeleteTag: () => void;
  onCloseRenameTag: () => void;
  pendingDeleteTagId: string | null;
  pendingRenameTagId: string | null;
  tickerToDelete: string;
}

export function Modals({
  onDeleteNote,
  onDeleteTag,
  onRenameTag,
  onConfirmDeleteTag,
  onCloseDeleteTag,
  onCloseRenameTag,
  pendingDeleteTagId,
  pendingRenameTagId,
  tickerToDelete,
}: ModalsProps) {
  const [confirmVisible, setConfirmVisible] = useState(false);
  const [deleteTagVisible, setDeleteTagVisible] = useState(false);
  const [renameTagVisible, setRenameTagVisible] = useState(false);
  const [renameTagName, setRenameTagName] = useState('');
  const [renameTagColor, setRenameTagColor] = useState(0);

  // Delete note modal
  const openDeleteNoteModal = () => setConfirmVisible(true);
  const closeDeleteNoteModal = () => setConfirmVisible(false);
  const handleConfirmDelete = () => {
    onDeleteNote();
    closeDeleteNoteModal();
  };

  // Delete tag modal
  const openDeleteTagModal = (tagId: string) => {
    onDeleteTag(tagId);
    setDeleteTagVisible(true);
  };
  const closeDeleteTagModal = () => {
    setDeleteTagVisible(false);
    onCloseDeleteTag();
  };
  const handleConfirmDeleteTag = () => {
    onConfirmDeleteTag();
    closeDeleteTagModal();
  };

  // Rename tag modal
  const openRenameTagModal = (tag: Tag) => {
    setRenameTagName(tag.name);
    setRenameTagColor(tag.color);
    setRenameTagVisible(true);
  };
  const closeRenameTagModal = () => {
    setRenameTagVisible(false);
    onCloseRenameTag();
  };
  const handleConfirmRenameTag = () => {
    if (pendingRenameTagId) {
      onRenameTag(pendingRenameTagId, renameTagName, renameTagColor);
    }
    closeRenameTagModal();
  };

  return (
    <>
      {/* Delete note confirm */}
      <div
        className={`modal-overlay ${confirmVisible ? 'show' : ''}`}
        id="confirmOverlay"
        onClick={e => {
          if (e.target === e.currentTarget) closeDeleteNoteModal();
        }}
      >
        <div className="modal-box">
          <div className="modal-title">Delete this note?</div>
          <div className="modal-msg" id="confirmMsg">
            &quot;{tickerToDelete}&quot; will be permanently deleted. This cannot be undone.
          </div>
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={closeDeleteNoteModal}>
              Cancel
            </button>
            <button className="btn btn-danger" onClick={handleConfirmDelete}>
              Delete
            </button>
          </div>
        </div>
      </div>

      {/* Delete tag confirm */}
      <div
        className={`modal-overlay ${deleteTagVisible ? 'show' : ''}`}
        id="deleteTagOverlay"
        onClick={e => {
          if (e.target === e.currentTarget) closeDeleteTagModal();
        }}
      >
        <div className="modal-box">
          <div className="modal-title">Delete tag?</div>
          <div className="modal-msg" id="deleteTagMsg"></div>
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={closeDeleteTagModal}>
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
        className={`modal-overlay ${renameTagVisible ? 'show' : ''}`}
        id="renameTagOverlay"
        onClick={e => {
          if (e.target === e.currentTarget) closeRenameTagModal();
        }}
      >
        <div className="modal-box">
          <div className="modal-title">Edit tag</div>
          <input
            className="rename-input"
            id="renameTagInput"
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
            <div className="color-swatches" id="renameColorSwatches">
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
            <button className="btn btn-ghost" onClick={closeRenameTagModal}>
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