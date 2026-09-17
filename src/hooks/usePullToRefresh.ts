'use client';

import { useRef, useCallback, useEffect, useState } from 'react';

/**
 * Custom pull-to-refresh hook for scrollable containers on mobile.
 *
 * When the user overscrolls (pulls down past the top of the scrollable element),
 * a refresh indicator appears and follows the finger. If they pull far enough
 * (threshold px) and release, the onRefresh callback fires (defaults to window.location.reload()).
 *
 * Returns: { containerRef, pullState, pullDistance } where pullState is 'idle' | 'pulling' | 'ready' | 'refreshing'
 */
export function usePullToRefresh(threshold = 70, onRefresh?: () => void) {
  const containerRef = useRef<HTMLDivElement>(null);
  const startY = useRef(0);
  const [pullState, setPullState] = useState<'idle' | 'pulling' | 'ready' | 'refreshing'>('idle');
  const pullDistance = useRef(0);

  const doRefresh = useCallback(() => {
    setPullState('refreshing');
    pullDistance.current = 0;
    if (onRefresh) {
      onRefresh();
      // Give callback 1.5s, then reset
      setTimeout(() => setPullState('idle'), 1500);
    } else {
      // Default: reload page
      window.location.reload();
    }
  }, [onRefresh]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // Only activate on touch devices
    const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    if (!isTouchDevice) return;

    let pulling = false;
    let currentPull = 0;

    const handleTouchStart = (e: TouchEvent) => {
      // Only start tracking if we're at the very top of the scroll container
      if (el.scrollTop <= 0) {
        startY.current = e.touches[0].clientY;
        pulling = true;
        currentPull = 0;
        pullDistance.current = 0;
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (!pulling) return;

      const diff = e.touches[0].clientY - startY.current;

      // Only care about downward pulls
      if (diff <= 0) {
        currentPull = 0;
        pullDistance.current = 0;
        setPullState('idle');
        return;
      }

      // If the container has scrollable content and is not at top, don't intercept
      if (el.scrollTop > 0) {
        currentPull = 0;
        pullDistance.current = 0;
        setPullState('idle');
        pulling = false;
        return;
      }

      // Prevent the browser's native overscroll/pull-to-refresh while we handle it
      e.preventDefault();

      // Apply rubber-band resistance (diminishing returns as you pull further)
      currentPull = diff * 0.4;
      pullDistance.current = currentPull;

      if (currentPull >= threshold) {
        setPullState('ready');
      } else if (currentPull > 10) {
        setPullState('pulling');
      }
    };

    const handleTouchEnd = () => {
      if (!pulling) return;
      pulling = false;

      if (currentPull >= threshold) {
        doRefresh();
      } else {
        pullDistance.current = 0;
        setPullState('idle');
      }
      currentPull = 0;
    };

    // touchstart and touchend can be passive (no preventDefault needed)
    el.addEventListener('touchstart', handleTouchStart, { passive: true });
    // touchmove MUST be non-passive so we can call preventDefault()
    // to stop the browser's native pull-to-refresh from interfering
    el.addEventListener('touchmove', handleTouchMove, { passive: false });
    el.addEventListener('touchend', handleTouchEnd, { passive: true });

    return () => {
      el.removeEventListener('touchstart', handleTouchStart);
      el.removeEventListener('touchmove', handleTouchMove);
      el.removeEventListener('touchend', handleTouchEnd);
    };
  }, [threshold, doRefresh]);

  return { containerRef, pullState, pullDistance };
}
