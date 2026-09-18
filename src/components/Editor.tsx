'use client';

import { useRef, useCallback, useState, useEffect } from 'react';
import { useNotes } from '@/hooks/useNotes';
import { usePullToRefresh } from '@/hooks/usePullToRefresh';
import { PALETTE } from '@/types';
import { TagPicker } from '@/components/TagPicker';

interface EditorProps {
  onCopy: () => void;
  onDelete: () => void;
  onSave: () => void;
}

// Module-level store for raw markdown tables (avoids <br> corruption in data attributes)
const tableMarkdownStore = new Map<string, string>();
let tableIdCounter = 0;

/** Apply inline formatting to a string (bold, italic, strikethrough, highlight, links). */
function applyInline(text: string): string {
  let t = text;
  t = t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/__(.+?)__/g, '<strong>$1</strong>');
  t = t.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
  t = t.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, '<em>$1</em>');
  t = t.replace(/~~(.+?)~~/g, '<del>$1</del>');
  t = t.replace(/==(.+?)==/g, '<mark>$1</mark>');
  t = t.replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return t;
}

/** Parse markdown table lines into an HTML table string with a copy button. */
function renderTableBlock(tableLines: string[]): string {
  // A separator row matches: | --- | --- | (dashes and colons only between pipes)
  const isSeparator = (line: string) => /^\|[\s\-:]+\|/.test(line);

  // Split a pipe-delimited line into cell values
  const splitRow = (line: string): string[] => {
    return line.split('|').slice(1, -1).map(cell => cell.trim());
  };

  let headerRow: string[] | null = null;
  const bodyRows: string[][] = [];

  for (const line of tableLines) {
    if (isSeparator(line)) continue; // skip separator
    const cells = splitRow(line);
    if (!headerRow) {
      headerRow = cells;
    } else {
      bodyRows.push(cells);
    }
  }

  if (!headerRow) return ''; // no header found

  const colCount = headerRow.length;
  const escapeCell = (c: string) => c.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  let html = '<table><thead><tr>';
  for (const h of headerRow) {
    html += `<th>${applyInline(escapeCell(h))}</th>`;
  }
  html += '</tr></thead>';

  if (bodyRows.length > 0) {
    html += '<tbody>';
    for (const row of bodyRows) {
      html += '<tr>';
      for (let i = 0; i < colCount; i++) {
        html += `<td>${applyInline(escapeCell(row[i] || ''))}</td>`;
      }
      html += '</tr>';
    }
    html += '</tbody>';
  }

  html += '</table>';

  // Store the raw markdown (with pipes) in a module-level Map so newlines survive the HTML pipeline
  const tableId = `tbl-${++tableIdCounter}`;
  tableMarkdownStore.set(tableId, tableLines.join('\n'));

  // Wrap in a container with a copy button (only store the ID, not the markdown)
  html = `<div class="table-wrapper" data-table-id="${tableId}">` +
    `<button class="table-copy-btn" title="Copy table as markdown">&#128203;</button>` +
    html +
    `</div>`;

  return html;
}

/** Simple markdown → HTML renderer for preview mode
 *  Keeps the raw text layout (numbers, bullets, indentation) exactly as typed.
 *  Applies inline formatting: bold, italic, strikethrough, highlight, links, headings.
 *  Supports markdown tables: | Header | Header | / |---|---| / | Cell | Cell | */
function renderMarkdown(text: string): string {
  // Apply renumber first so preview always shows clean sequential numbers
  const renumbered = renumberLists(text);

  const lines = renumbered.split('\n');
  const output: string[] = [];

  let i = 0;
  while (i < lines.length) {
    const rawLine = lines[i];

    // ── Table block: consecutive lines starting with '|' ──
    if (rawLine.trimStart().startsWith('|')) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].trimStart().startsWith('|')) {
        tableLines.push(lines[i]);
        i++;
      }
      output.push(renderTableBlock(tableLines));
      continue;
    }

    let line = rawLine;
    // Escape HTML
    line = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Headings: # H1, ## H2, ### H3 (replace the whole line)
    const headingMatch = rawLine.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const content = line.replace(/^#{1,3}\s+/, '');
      output.push(`<h${level}>${applyInline(content)}</h${level}>`);
      i++;
      continue;
    }

    // Regular line with inline formatting
    output.push(applyInline(line));
    i++;
  }

  // Join: double newline → paragraph break, single newline → <br>
  let html = output.join('\n');
  html = html.replace(/\n{2,}/g, '</p><p>');
  html = html.replace(/\n/g, '<br>');

  // Wrap in paragraph
  html = '<p>' + html + '</p>';

  // Clean up empty paragraphs
  html = html.replace(/<p>\s*<\/p>/g, '');
  html = html.replace(/<p>\s*(<h[1-3]>)/g, '$1');
  html = html.replace(/(<\/h[1-3]>)\s*<\/p>/g, '$1');
  // Don't wrap tables in <p>
  html = html.replace(/<p>\s*(<div class="table-wrapper")/g, '$1');
  html = html.replace(/(<\/div>)\s*<\/p>/g, '$1');

  return html;
}

/** Renumber top-level numbered items sequentially within each list block.
 *  A "list block" is a consecutive run of numbered items, sub-bullets, and
 *  blank lines. When a non-blank, non-numbered, non-sub-bullet line is
 *  encountered, the counter resets — starting a new list at 1.
 *  Sub-bullet lines (indented `- ` or `* `) are left unchanged. */
function renumberLists(text: string): string {
  const lines = text.split('\n');
  let counter = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\d+)\.\s+/);
    const isSubBullet = /^\s+[-*]\s+/.test(lines[i]);

    if (m) {
      counter++;
      lines[i] = lines[i].replace(/^\d+\.\s+/, `${counter}. `);
    } else if (!isSubBullet && lines[i].trim() !== '') {
      // Non-numbered, non-sub-bullet, non-blank line → this is a text break
      // that separates distinct lists, so reset the counter
      counter = 0;
    }
    // Blank lines and sub-bullets do NOT reset the counter — they're part of
    // the current list block (standard markdown: blank line within a list is ok)
  }
  return lines.join('\n');
}

export function Editor({ onCopy, onDelete, onSave }: EditorProps) {
  const {
    activeNote,
    tags,
    updateCurrentNote,
    scheduleAutoSave,
    toggleEditorTag,
    isDirty,
    saveCurrentNote,
    discardChanges,
  } = useNotes();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const tickerRef = useRef<HTMLTextAreaElement>(null);
  const editorBodyRef = useRef<HTMLDivElement>(null);
  // Default: view/read mode. Must explicitly click Edit to enable editing.
  const [isEditing, setIsEditing] = useState(false);
  // Mobile-only: collapse the editor header (ticker, tags, toolbar) to give
  // the textarea full screen space. Desktop is unaffected (button is hidden).
  const [headerCollapsed, setHeaderCollapsed] = useState(false);

  // Pull-to-refresh support on the editor body
  const { containerRef: pullRef, pullState, pullDistance } = usePullToRefresh(70, () => {
    window.location.reload();
  });

  // Merge pullRef and editorBodyRef so the hook can attach touch listeners
  const setEditorBodyRef = useCallback((el: HTMLDivElement | null) => {
    (pullRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
    (editorBodyRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
  }, [pullRef]);

  // Auto-grow ticker on mount and when activeNote changes
  useEffect(() => {
    const el = tickerRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = el.scrollHeight + 'px';
    }
  }, [activeNote?.id]);

  // Handle "copy table as markdown" clicks in preview mode
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.classList.contains('table-copy-btn')) return;
      const wrapper = target.closest('.table-wrapper') as HTMLElement | null;
      if (!wrapper) return;
      const tableId = wrapper.getAttribute('data-table-id');
      if (!tableId) return;
      // Retrieve the raw markdown from the module-level store (newlines are preserved)
      const markdown = tableMarkdownStore.get(tableId);
      if (!markdown) return;
      navigator.clipboard.writeText(markdown).then(() => {
        // Visual feedback: briefly change the button text
        const btn = target as HTMLButtonElement;
        const original = btn.innerHTML;
        btn.innerHTML = '&#10003;'; // checkmark
        btn.classList.add('copied');
        setTimeout(() => {
          btn.innerHTML = original;
          btn.classList.remove('copied');
        }, 1200);
      });
    };
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, []);

  // Scroll the textarea so the cursor is visible above the bottom mobile nav
  const scrollCursorIntoView = useCallback((ta?: HTMLTextAreaElement | null) => {
    const target = ta || textareaRef.current;
    if (!target) return;
    requestAnimationFrame(() => {
      const cursorPos = target.selectionStart;
      const textBeforeCursor = target.value.substring(0, cursorPos);
      const linesBeforeCursor = textBeforeCursor.split('\n').length;
      const lineHeight = parseFloat(getComputedStyle(target).lineHeight) || 24;
      const paddingTop = parseFloat(getComputedStyle(target).paddingTop) || 16;
      const cursorY = paddingTop + (linesBeforeCursor - 1) * lineHeight;
      const visibleHeight = target.clientHeight;
      const bottomBuffer = 80;
      const maxScrollTop = cursorY - visibleHeight + bottomBuffer;
      if (target.scrollTop < maxScrollTop) {
        target.scrollTop = maxScrollTop;
      }
    });
  }, []);

  const applyBold = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = ta.value.substring(start, end);
    const newText = ta.value.substring(0, start) + '**' + selected + '**' + ta.value.substring(end);
    updateCurrentNote({ body: newText });
    scheduleAutoSave();
    setTimeout(() => {
      ta.setSelectionRange(start + 2, end + 2);
      ta.focus();
    }, 0);
  }, [updateCurrentNote, scheduleAutoSave]);

  const applyItalic = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = ta.value.substring(start, end);
    const newText = ta.value.substring(0, start) + '_' + selected + '_' + ta.value.substring(end);
    updateCurrentNote({ body: newText });
    scheduleAutoSave();
    setTimeout(() => {
      ta.setSelectionRange(start + 1, end + 1);
      ta.focus();
    }, 0);
  }, [updateCurrentNote, scheduleAutoSave]);

  const applyStrikethrough = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = ta.value.substring(start, end);
    const newText = ta.value.substring(0, start) + '~~' + selected + '~~' + ta.value.substring(end);
    updateCurrentNote({ body: newText });
    scheduleAutoSave();
    setTimeout(() => {
      ta.setSelectionRange(start + 2, end + 2);
      ta.focus();
    }, 0);
  }, [updateCurrentNote, scheduleAutoSave]);

  const applyHeading = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const value = ta.value;
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    const lineEnd = value.indexOf('\n', end);
    const fullLineEnd = lineEnd === -1 ? value.length : lineEnd;
    const currentLine = value.substring(lineStart, fullLineEnd);
    const h3Match = currentLine.match(/^###\s+/);
    const h2Match = currentLine.match(/^##\s+(?!#)/);
    const h1Match = currentLine.match(/^#\s+(?!#)/);
    let newLine: string;
    if (h3Match) {
      newLine = currentLine.replace(/^###\s+/, '');
    } else if (h2Match) {
      newLine = currentLine.replace(/^##\s+/, '### ');
    } else if (h1Match) {
      newLine = currentLine.replace(/^#\s+/, '## ');
    } else {
      newLine = '# ' + currentLine;
    }
    const newText = value.substring(0, lineStart) + newLine + value.substring(fullLineEnd);
    updateCurrentNote({ body: newText });
    scheduleAutoSave();
    setTimeout(() => {
      ta.setSelectionRange(lineStart, lineStart + newLine.length);
      ta.focus();
    }, 0);
  }, [updateCurrentNote, scheduleAutoSave]);

  const applyHighlight = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = ta.value.substring(start, end);
    const newText = ta.value.substring(0, start) + '==' + selected + '==' + ta.value.substring(end);
    updateCurrentNote({ body: newText });
    scheduleAutoSave();
    setTimeout(() => {
      ta.setSelectionRange(start + 2, end + 2);
      ta.focus();
    }, 0);
  }, [updateCurrentNote, scheduleAutoSave]);

  const applyLink = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = ta.value.substring(start, end);
    // If text is selected, use it as link text and prompt for URL
    // If no text selected, insert placeholder
    const linkText = selected || 'link text';
    const url = prompt('Enter URL:', 'https://');
    if (!url) return; // cancelled
    const insertion = `[${linkText}](${url})`;
    const newText = ta.value.substring(0, start) + insertion + ta.value.substring(end);
    updateCurrentNote({ body: newText });
    scheduleAutoSave();
    setTimeout(() => {
      // Select the link text portion so user can type over it
      ta.setSelectionRange(start + 1, start + 1 + linkText.length);
      ta.focus();
    }, 0);
  }, [updateCurrentNote, scheduleAutoSave]);

  const applyTable = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const colsStr = prompt('Number of columns:', '3');
    if (!colsStr) return;
    const cols = Math.max(2, Math.min(parseInt(colsStr, 10) || 3, 10));
    const rowsStr = prompt('Number of rows (excluding header):', '2');
    if (!rowsStr) return;
    const rows = Math.max(1, Math.min(parseInt(rowsStr, 10) || 2, 20));
    // Build markdown table
    const header = '| ' + Array.from({ length: cols }, (_, i) => `Col ${i + 1}`).join(' | ') + ' |';
    const separator = '| ' + Array.from({ length: cols }, () => '---').join(' | ') + ' |';
    const bodyLines = Array.from({ length: rows }, () =>
      '| ' + Array.from({ length: cols }, () => '').join(' | ') + ' |'
    );
    const table = [header, separator, ...bodyLines].join('\n');
    const newText = ta.value.substring(0, start) + table + ta.value.substring(start);
    updateCurrentNote({ body: newText });
    scheduleAutoSave();
    setTimeout(() => {
      // Place cursor at first empty cell
      const firstCellPos = start + header.length + 1 + separator.length + 1 + '| '.length;
      ta.setSelectionRange(firstCellPos, firstCellPos);
      ta.focus();
    }, 0);
  }, [updateCurrentNote, scheduleAutoSave]);

  const applyList = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = ta.value.substring(start, end);
    const lines = selected.split('\n');
    const numbered = lines.map((line, i) => `${i + 1}. ${line}`).join('\n');
    const newText = ta.value.substring(0, start) + numbered + ta.value.substring(end);
    updateCurrentNote({ body: newText });
    scheduleAutoSave();
    setTimeout(() => {
      ta.setSelectionRange(start, start + numbered.length);
      ta.focus();
    }, 0);
  }, [updateCurrentNote, scheduleAutoSave]);

  const applyBulletList = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = ta.value.substring(start, end);
    const lines = selected.split('\n');
    const bulleted = lines.map(line => `- ${line}`).join('\n');
    const newText = ta.value.substring(0, start) + bulleted + ta.value.substring(end);
    updateCurrentNote({ body: newText });
    scheduleAutoSave();
    setTimeout(() => {
      ta.setSelectionRange(start, start + bulleted.length);
      ta.focus();
    }, 0);
  }, [updateCurrentNote, scheduleAutoSave]);

  const handleEditorKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const target = textareaRef.current;

    // ── Enter key: auto-continue lists ──
    if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.altKey && target) {
      const value = target.value;
      const cursorPos = target.selectionStart;
      const lineStart = value.lastIndexOf('\n', cursorPos - 1) + 1;
      const currentLine = value.substring(lineStart, cursorPos);

      // Match numbered list: e.g. "1. " or "12. "
      const numberedMatch = currentLine.match(/^(\d+)\.\s+/);
      if (numberedMatch) {
        const prefix = numberedMatch[0];
        if (currentLine.trim() === prefix.trim()) {
          e.preventDefault();
          const before = value.substring(0, lineStart);
          const after = value.substring(cursorPos);
          const newText = before + '\n' + after;
          updateCurrentNote({ body: newText });
          scheduleAutoSave();
          setTimeout(() => {
            target.selectionStart = target.selectionEnd = before.length + 1;
            scrollCursorIntoView(target);
          }, 0);
          return;
        }
        const nextNum = parseInt(numberedMatch[1], 10) + 1;
        const nextPrefix = `${nextNum}. `;
        e.preventDefault();
        const before = value.substring(0, cursorPos);
        const after = value.substring(cursorPos);
        const newText = before + '\n' + nextPrefix + after;
        updateCurrentNote({ body: newText });
        scheduleAutoSave();
        setTimeout(() => {
          const newPos = before.length + 1 + nextPrefix.length;
          target.selectionStart = target.selectionEnd = newPos;
          scrollCursorIntoView(target);
        }, 0);
        return;
      }

      // Match indented sub-bullet list
      const subBulletMatch = currentLine.match(/^(\s+)([-*])\s+/);
      if (subBulletMatch) {
        const bulletChar = subBulletMatch[2];
        if (currentLine.trim() === `${bulletChar} ` || currentLine.trim() === `${bulletChar}`) {
          e.preventDefault();
          const before = value.substring(0, lineStart);
          const after = value.substring(cursorPos);
          const newText = before + '\n' + after;
          updateCurrentNote({ body: newText });
          scheduleAutoSave();
          setTimeout(() => {
            target.selectionStart = target.selectionEnd = before.length + 1;
            scrollCursorIntoView(target);
          }, 0);
          return;
        }
        e.preventDefault();
        const textBeforeLine = value.substring(0, lineStart);
        const prevLines = textBeforeLine.split('\n');
        let lastNumber = 0;
        for (let i = prevLines.length - 1; i >= 0; i--) {
          const nm = prevLines[i].match(/^(\d+)\.\s+/);
          if (nm) { lastNumber = parseInt(nm[1], 10); break; }
        }
        const nextPrefix = `${lastNumber + 1}. `;
        const before = value.substring(0, cursorPos);
        const after = value.substring(cursorPos);
        const newText = before + '\n' + nextPrefix + after;
        updateCurrentNote({ body: renumberLists(newText) });
        scheduleAutoSave();
        setTimeout(() => {
          const newLineStart = before.length + 1;
          const updatedLine = target.value.substring(newLineStart, newLineStart + 20);
          const updatedNumMatch = updatedLine.match(/^(\d+)\.\s+/);
          if (updatedNumMatch) {
            target.selectionStart = target.selectionEnd = newLineStart + updatedNumMatch[0].length;
          } else {
            target.selectionStart = target.selectionEnd = newLineStart + nextPrefix.length;
          }
          scrollCursorIntoView(target);
        }, 0);
        return;
      }

      // Match top-level bullet list
      const bulletMatch = currentLine.match(/^[-*]\s+/);
      if (bulletMatch) {
        const prefix = bulletMatch[0];
        if (currentLine.trim() === prefix.trim()) {
          e.preventDefault();
          const before = value.substring(0, lineStart);
          const after = value.substring(cursorPos);
          const newText = before + '\n' + after;
          updateCurrentNote({ body: newText });
          scheduleAutoSave();
          setTimeout(() => {
            target.selectionStart = target.selectionEnd = before.length + 1;
            scrollCursorIntoView(target);
          }, 0);
          return;
        }
        e.preventDefault();
        const before = value.substring(0, cursorPos);
        const after = value.substring(cursorPos);
        const newText = before + '\n' + prefix + after;
        updateCurrentNote({ body: newText });
        scheduleAutoSave();
        setTimeout(() => {
          const newPos = before.length + 1 + prefix.length;
          target.selectionStart = target.selectionEnd = newPos;
          scrollCursorIntoView(target);
        }, 0);
        return;
      }

      setTimeout(() => { scrollCursorIntoView(target); }, 0);
    }

    // Keyboard shortcuts
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'B') { e.preventDefault(); e.stopPropagation(); applyBold(); return; }
    if ((e.metaKey || e.ctrlKey) && e.key === 'b') { e.preventDefault(); e.stopPropagation(); applyBold(); return; }
    if ((e.metaKey || e.ctrlKey) && e.key === 'i') { e.preventDefault(); e.stopPropagation(); applyItalic(); return; }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'X') { e.preventDefault(); e.stopPropagation(); applyStrikethrough(); return; }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'H') { e.preventDefault(); e.stopPropagation(); applyHighlight(); return; }
    if ((e.metaKey || e.ctrlKey) && e.key === 'h') { e.preventDefault(); e.stopPropagation(); applyHeading(); return; }
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); e.stopPropagation(); applyLink(); return; }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'L') { e.preventDefault(); e.stopPropagation(); applyList(); return; }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'U') { e.preventDefault(); e.stopPropagation(); applyBulletList(); return; }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'T') { e.preventDefault(); e.stopPropagation(); applyTable(); return; }
  }, [applyBold, applyItalic, applyStrikethrough, applyHeading, applyHighlight, applyLink, applyTable, applyList, applyBulletList, updateCurrentNote, scheduleAutoSave, scrollCursorIntoView]);



  // Word count
  const wordCount = activeNote?.body.trim()
    ? activeNote.body.trim().split(/\s+/).length
    : 0;

  if (!activeNote) {
    return (
      <div className="editor-panel">
        <div className="empty-state">
          <div className="empty-icon">📝</div>
          <div className="empty-msg">Select a note or create a new one</div>
        </div>
      </div>
    );
  }

  return (
    <div className="editor-panel">
      {/* Mobile collapse toggle — hidden on desktop */}
      <button
        className="editor-collapse-toggle"
        onClick={() => setHeaderCollapsed(c => !c)}
        title={headerCollapsed ? 'Show header' : 'Hide header (maximize editing space)'}
      >
        {headerCollapsed ? '▼' : '▲'}
      </button>
      <div className={`editor-header-wrap ${headerCollapsed ? 'collapsed' : ''}`}>
      <div className="editor-topbar">
        <textarea
          ref={tickerRef}
          className={`editor-ticker-input ${!isEditing ? 'editor-ticker-readonly' : ''}`}
          placeholder="TICKER / TITLE"
          value={activeNote.ticker}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          rows={1}
          readOnly={!isEditing}
          onKeyDown={e => {
            if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'n' || e.key === 'b' || e.key === 'i' || e.key === 'h' || e.key === 'k' || (e.shiftKey && (e.key === 'L' || e.key === 'U' || e.key === 'X' || e.key === 'H')))) {
              e.stopPropagation();
            }
          }}
          onChange={e => {
            updateCurrentNote({ ticker: e.target.value });
            scheduleAutoSave();
            requestAnimationFrame(() => {
              const el = tickerRef.current;
              if (el) {
                el.style.height = 'auto';
                el.style.height = el.scrollHeight + 'px';
              }
            });
          }}
        />
        <div className="editor-date">
          {new Date(activeNote.created).toLocaleDateString('en-GB', {
            weekday: 'short',
            day: 'numeric',
            month: 'long',
            year: 'numeric',
            timeZone: 'Asia/Kolkata',
          })}
        </div>
      </div>
      {/* Tags bar: simple buttons for ≤10 tags, searchable picker for >10 */}
      {tags.length <= 10 ? (
        <div className="editor-tags-bar">
          <span className="tags-label">Tags</span>
          {tags.map(tag => {
            const c = PALETTE[tag.color] || PALETTE[0];
            const isOn = activeNote.tags.includes(tag.id);
            return (
              <button
                key={tag.id}
                className={`editor-tag-btn ${isOn ? 'on' : ''}`}
                onClick={() => toggleEditorTag(tag.id)}
                style={
                  isOn
                    ? { background: c.bg, color: c.text, borderColor: c.border }
                    : {}
                }
              >
                <span className="etag-dot" style={{ background: c.dot }}></span>
                {tag.name}
              </button>
            );
          })}
        </div>
      ) : (
        <TagPicker
          tags={tags}
          activeTagIds={activeNote.tags}
          onToggleTag={toggleEditorTag}
        />
      )}
      {/* Toolbar: format buttons + action buttons all in one bar */}
      <div className="editor-toolbar">
        <div className="editor-toolbar-left">
          {isEditing && (<>
            <button
              className="fmt-btn"
              title="Bold (Ctrl+B)"
              onMouseDown={e => e.preventDefault()}
              onClick={() => applyBold()}
            >
              <strong>B</strong>
            </button>
            <button
              className="fmt-btn"
              title="Italic (Ctrl+I)"
              onMouseDown={e => e.preventDefault()}
              onClick={() => applyItalic()}
            >
              <em>I</em>
            </button>
            <button
              className="fmt-btn"
              title="Strikethrough (Ctrl+Shift+X)"
              onMouseDown={e => e.preventDefault()}
              onClick={() => applyStrikethrough()}
            >
              <span style={{ fontFamily: 'monospace', textDecoration: 'line-through' }}>S</span>
            </button>
            <button
              className="fmt-btn"
              title="Highlight (Ctrl+Shift+H)"
              onMouseDown={e => e.preventDefault()}
              onClick={() => applyHighlight()}
            >
              <span className="fmt-highlight-icon">H</span>
            </button>
            <button
              className="fmt-btn"
              title="Link (Ctrl+K)"
              onMouseDown={e => e.preventDefault()}
              onClick={() => applyLink()}
            >
              <span style={{ fontFamily: 'monospace', fontWeight: 700, textDecoration: 'underline', color: '#2563eb' }}>🔗</span>
            </button>
            <button
              className="fmt-btn"
              title="Heading (Ctrl+H)"
              onMouseDown={e => e.preventDefault()}
              onClick={() => applyHeading()}
            >
              <span style={{ fontFamily: 'monospace', fontWeight: 900 }}>H#</span>
            </button>
            <button
              className="fmt-btn"
              title="Numbered list (Ctrl+Shift+L)"
              onMouseDown={e => e.preventDefault()}
              onClick={() => applyList()}
            >
              <span style={{ fontFamily: 'monospace' }}>1.</span>
            </button>
            <button
              className="fmt-btn"
              title="Bullet list (Ctrl+Shift+U)"
              onMouseDown={e => e.preventDefault()}
              onClick={() => applyBulletList()}
            >
              <span style={{ fontFamily: 'monospace' }}>&#8226;</span>
            </button>
            <button
              className="fmt-btn"
              title="Table (Ctrl+Shift+T)"
              onMouseDown={e => e.preventDefault()}
              onClick={() => applyTable()}
            >
              <span style={{ fontFamily: 'monospace', fontSize: '13px' }}>&#9638;&#9638;</span>
            </button>
            <div className="fmt-separator" />
          </>)}
          {/* Edit / Done toggle button — always visible */}
          <button
            className={`fmt-btn ${isEditing ? 'fmt-btn-active' : 'fmt-btn-edit-primary'}`}
            title={isEditing ? 'Done editing' : 'Edit this note'}
            onMouseDown={e => e.preventDefault()}
            onClick={() => {
              if (isEditing) {
                // Compute renumbered body from the CURRENT note and pass it as
                // an override to saveCurrentNote, which will merge it onto the
                // freshest note and persist in the same tick. This avoids the
                // previous dispatch-then-save race where saveCurrentNote read
                // a stale `state.notes` and clobbered the freshly-typed body.
                const renumbered = renumberLists(activeNote.body);
                saveCurrentNote({ body: renumbered });
                onSave();
              }
              setIsEditing(!isEditing);
            }}
          >
            {isEditing ? '✓ Done' : '✎ Edit'}
          </button>
        </div>
        <div className="editor-toolbar-right">
          <span className="toolbar-word-count">{wordCount}w</span>
          {isDirty() && <button className="fmt-btn fmt-btn-discard" title="Discard unsaved changes" onClick={discardChanges}>Discard</button>}
          <button className="fmt-btn fmt-btn-action" title="Download note as text file" onClick={() => {
            if (!activeNote) return;
            const content = `${activeNote.ticker}\n\n${activeNote.body}`;
            const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${activeNote.ticker || 'note'}.txt`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
          }}>Download</button>
          <button className="fmt-btn fmt-btn-action" title="Copy note" onClick={onCopy}>Copy</button>
          <button className="fmt-btn fmt-btn-danger" title="Delete note" onClick={onDelete}>Delete</button>
          <button className={`fmt-btn fmt-btn-save ${isDirty() ? 'fmt-btn-dirty' : ''}`} title="Save note (Ctrl+S)" onClick={async () => { const renumbered = renumberLists(activeNote.body); await saveCurrentNote({ body: renumbered }); onSave(); }}>{isDirty() ? 'Save •' : 'Saved'}</button>
        </div>
      </div>
      </div>{/* end editor-header-wrap */}
      <div className="editor-body" ref={setEditorBodyRef}>
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
        {isEditing ? (
          <textarea
            ref={textareaRef}
            className="editor-textarea"
            placeholder="Write your analysis, observations, trade rationale…&#10;&#10;Formatting: **bold**, _italic_, ~~strikethrough~~, ==highlight==, [link](url)&#10;Tables: | Header | Header | / |---|---| / | Cell | Cell |&#10;1. or - then Enter = auto-continue list&#10;Ctrl+B Bold | Ctrl+I Italic | Ctrl+H Heading | Ctrl+K Link | Ctrl+Shift+H Highlight | Ctrl+Shift+T Table"
            value={activeNote.body}
            onChange={e => {
              updateCurrentNote({ body: e.target.value });
              scheduleAutoSave();
              scrollCursorIntoView();
            }}
            onKeyDown={handleEditorKeyDown}
          />
        ) : (
          <div
            className="editor-preview editor-preview-readonly"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(activeNote.body) }}
          />
        )}
      </div>

    </div>
  );
}
