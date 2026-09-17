'use client';

import { useNotes } from '@/hooks/useNotes';

interface MobileEditorFooterProps {
  onCopy: () => void;
  onDelete: () => void;
  onSave: () => void;
}

export function MobileEditorFooter({ onCopy, onDelete, onSave }: MobileEditorFooterProps) {
  const { activeNote } = useNotes();
  const wordCount = activeNote?.body.trim()
    ? activeNote.body.trim().split(/\s+/).length
    : 0;

  if (!activeNote) {
    return null;
  }

  return (
    <div className="mobile-editor-footer">
      <span className="word-count">
        {wordCount} word{wordCount !== 1 ? 's' : ''}
      </span>
      <div className="editor-actions">
        <button className="btn btn-ghost" onClick={onCopy}>
          Copy
        </button>
        <button className="btn btn-danger" onClick={onDelete}>
          Delete
        </button>
        <button className="btn btn-primary" onClick={onSave}>
          Save
        </button>
      </div>
    </div>
  );
}