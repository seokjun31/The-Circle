import { useState, useCallback } from 'react';

// Global app state shared across pages via localStorage
const STORAGE_KEY = 'ai_interior_state';

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore
  }
}

export function useAppState() {
  const [state, setState] = useState(loadState);

  const update = useCallback((updates) => {
    setState(prev => {
      const next = { ...prev, ...updates };
      saveState(next);
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setState({});
  }, []);

  return { state, update, reset };
}

export default useAppState;
