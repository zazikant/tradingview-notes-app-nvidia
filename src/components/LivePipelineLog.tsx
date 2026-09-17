'use client';

import { useEffect, useRef } from 'react';

export interface LiveEvent {
  ts: number;
  type: string;
  line?: string;
  text?: string;
  stage?: string;
  ok?: boolean;
  elapsedMs?: number;
  summary?: string;
  message?: string;
}

function formatTime(ts: number): string {
  const t = new Date(ts);
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}.${pad(t.getMilliseconds(), 3)}`;
}

function renderEvent(ev: LiveEvent, i: number) {
  const ts = formatTime(ev.ts);
  if (ev.type === 'stage-start') {
    return (
      <div key={i} className="brain-log-stage-start">
        <span className="brain-log-ts">{ts}</span>{' '}
        <span className="brain-log-marker">▶</span> stage-start{' '}
        <span className="brain-log-stage">{ev.stage}</span>
      </div>
    );
  }
  if (ev.type === 'log' && ev.line) {
    const isErr = ev.line.includes('TIMEOUT') || ev.line.includes('ERROR') || ev.line.includes('failed');
    const isRetry = ev.line.includes('retry');
    const isDone = ev.line.includes('done');
    const isPipeline = ev.line.startsWith('[pipeline]');
    const cls = isErr
      ? 'brain-log-err'
      : isRetry
        ? 'brain-log-retry'
        : isDone
          ? 'brain-log-done'
          : isPipeline
            ? 'brain-log-pipeline'
            : 'brain-log-default';
    return (
      <div key={i} className={`brain-log-line ${cls}`}>
        <span className="brain-log-ts">{ts}</span> {ev.line}
      </div>
    );
  }
  if (ev.type === 'chunk') {
    return null; // hidden — live text panel shows chunks
  }
  if (ev.type === 'stage-end') {
    return (
      <div key={i} className={`brain-log-stage-end ${ev.ok ? 'ok' : 'fail'}`}>
        <span className="brain-log-ts">{ts}</span>{' '}
        <span className="brain-log-marker">{ev.ok ? '■' : '✗'}</span>{' '}
        stage-end{' '}
        <span className={`brain-log-stage ${ev.ok ? 'ok' : 'fail'}`}>{ev.stage}</span>{' '}
        {ev.elapsedMs}ms {ev.ok ? '✓' : '✗'} {ev.summary}
      </div>
    );
  }
  if (ev.type === 'error') {
    return (
      <div key={i} className="brain-log-error">
        <span className="brain-log-ts">{ts}</span>{' '}
        <span className="brain-log-marker">✗</span> ERROR: {ev.message}
      </div>
    );
  }
  return (
    <div key={i} className="brain-log-default">
      <span className="brain-log-ts">{ts}</span> {ev.type}
    </div>
  );
}

interface LivePipelineLogProps {
  events: LiveEvent[];
  visible: boolean;
  onClose: () => void;
}

export function LivePipelineLog({ events, visible, onClose }: LivePipelineLogProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [events.length]);

  if (events.length === 0) return null;

  return (
    <div className="brain-log">
      <div className="brain-log-header">
        <span className="brain-log-title">
          live pipeline log ({events.length} events)
        </span>
        <button
          type="button"
          onClick={onClose}
          className="brain-log-toggle"
        >
          {visible ? 'hide' : 'show'}
        </button>
      </div>
      {visible && (
        <div ref={containerRef} className="brain-log-body">
          {events.map((ev, i) => renderEvent(ev, i))}
        </div>
      )}
    </div>
  );
}
