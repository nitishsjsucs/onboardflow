import { useCallback, useEffect, useRef } from "react";

/**
 * Runs `fn` at most once per `ms`. The window starts at mount (the page just fetched), and a call inside
 * the window is not dropped: it runs once when the window ends, so the last change always shows.
 */
export function useThrottledCallback(fn: () => void, ms: number): () => void {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const last = useRef(Date.now());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return useCallback(() => {
    const wait = last.current + ms - Date.now();
    if (wait <= 0) {
      last.current = Date.now();
      fnRef.current();
      return;
    }
    timer.current ??= setTimeout(() => {
      timer.current = null;
      last.current = Date.now();
      fnRef.current();
    }, wait);
  }, [ms]);
}
