'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

const CORRECT_PIN = '19081992';
const ADMIN_EMAIL = 'zazikant@gmail.com';
const SESSION_KEY = 'tv-notes-auth';

interface PinLockProps {
  onUnlock: () => void;
}

export function PinLock({ onUnlock }: PinLockProps) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [shake, setShake] = useState(false);
  const [showPin, setShowPin] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Check if already authenticated in this session
  useEffect(() => {
    const auth = sessionStorage.getItem(SESSION_KEY);
    if (auth === 'true') {
      onUnlock();
    } else {
      setTimeout(() => inputRef.current?.focus(), 150);
    }
  }, [onUnlock]);

  const handleSubmit = useCallback((e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (pin.length < 8) return;
    if (pin === CORRECT_PIN) {
      sessionStorage.setItem(SESSION_KEY, 'true');
      onUnlock();
    } else {
      setError('Incorrect PIN. Try again.');
      setShake(true);
      setTimeout(() => {
        setShake(false);
        setPin('');
        setError('');
        inputRef.current?.focus();
      }, 800);
    }
  }, [pin, onUnlock]);

  // Auto-submit when 8 digits entered
  useEffect(() => {
    if (pin.length === 8) {
      handleSubmit();
    }
  }, [pin, handleSubmit]);

  const handlePinChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value.replace(/\D/g, '').slice(0, 8);
    setPin(val);
    setError('');
  }, []);

  const focusInput = useCallback(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="pin-lock-overlay" onClick={focusInput}>
      <div className={`pin-lock-card ${shake ? 'pin-shake' : ''}`} onClick={e => e.stopPropagation()}>
        {/* Logo / Brand */}
        <div className="pin-lock-brand">
          <div className="pin-lock-logo">
            <span className="pin-lock-logo-dot" />
            TV Notes
          </div>
        </div>

        {/* Lock icon */}
        <div className="pin-lock-icon">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
        </div>

        <h1 className="pin-lock-title">Enter PIN to unlock</h1>
        <p className="pin-lock-subtitle">This app is access-protected</p>

        {/* PIN dots display — clickable to focus input */}
        <div className="pin-dots" onClick={focusInput}>
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className={`pin-dot ${i < pin.length ? 'filled' : ''} ${i === pin.length ? 'active' : ''}`}
            >
              {showPin && i < pin.length ? pin[i] : ''}
            </div>
          ))}
        </div>

        {/* Hidden input for capturing keystrokes */}
        <form onSubmit={handleSubmit} className="pin-form">
          <input
            ref={inputRef}
            type={showPin ? 'text' : 'password'}
            inputMode="numeric"
            className="pin-hidden-input"
            value={pin}
            onChange={handlePinChange}
            autoFocus
            autoComplete="off"
          />
          <button type="submit" className="pin-submit-btn" disabled={pin.length < 8}>
            Unlock
          </button>
        </form>

        {/* Show/hide PIN toggle */}
        <button
          className="pin-toggle-visibility"
          onClick={() => { setShowPin(!showPin); setTimeout(focusInput, 0); }}
          type="button"
        >
          {showPin ? 'Hide' : 'Show'} PIN
        </button>

        {/* Error message */}
        {error && <div className="pin-error">{error}</div>}

        {/* Admin info */}
        <div className="pin-admin-info">
          Admin: {ADMIN_EMAIL}
        </div>
      </div>
    </div>
  );
}
