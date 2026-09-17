'use client';

import { useEffect, useState } from 'react';

interface ToastProps {
  message: string;
  duration?: number;
}

export function Toast({ message, duration = 2200 }: ToastProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (message) {
      setVisible(true);
      const timer = setTimeout(() => setVisible(false), duration);
      return () => clearTimeout(timer);
    }
  }, [message, duration]);

  return (
    <div className={`toast ${visible ? 'show' : ''}`} id="toast">
      {message}
    </div>
  );
}

// Toast manager for showing toasts from anywhere
let showToastFn: ((msg: string) => void) | null = null;

export function showToast(msg: string) {
  if (showToastFn) {
    showToastFn(msg);
  }
}

export function ToastManager() {
  const [message, setMessage] = useState('');

  useEffect(() => {
    showToastFn = (msg: string) => {
      setMessage(msg);
    };
    return () => {
      showToastFn = null;
    };
  }, []);

  return <Toast message={message} />;
}