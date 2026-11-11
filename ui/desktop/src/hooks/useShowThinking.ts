import { useSyncExternalStore } from 'react';
import { AppEvents } from '../constants/events';
import type { ShowThinking } from '../utils/settings';

// The "Show Thinking" setting, read once and shared: a long turn lists a thinking step per
// model call, so each step asking the main process for it would be hundreds of round trips.
// The value is kept between chats, so opening one does not flash thinking in or out.
let current: ShowThinking | null = null;
const listeners = new Set<() => void>();

function load() {
  window.electron.getSetting('showThinking').then((value) => {
    if (value === current) return;
    current = value;
    listeners.forEach((listener) => listener());
  });
}

function subscribe(listener: () => void) {
  if (listeners.size === 0) {
    // Catches a change made while nothing on screen was listening.
    load();
    window.addEventListener(AppEvents.SHOW_THINKING_CHANGED, load);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.removeEventListener(AppEvents.SHOW_THINKING_CHANGED, load);
    }
  };
}

const getSnapshot = () => current;

/** The "Show Thinking" setting, or null until it has been read for the first time. */
export function useShowThinking(): ShowThinking | null {
  return useSyncExternalStore(subscribe, getSnapshot);
}
