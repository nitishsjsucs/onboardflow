// Focus that follows the user's action. After a navigation the shell moves
// focus to the page heading; inside a page, an action often removes the
// control that had focus (a decided card's buttons, a resolved queue item,
// a confirm step that closed), and the browser then drops focus to <body>:
// a screen reader announces nothing and the keyboard user starts again from
// the top. These hooks put focus somewhere meaningful instead.
import { type FocusEvent, useEffect, useRef, useState } from "react";

/** Keyboard focus fell back to the page: on <body>, on nothing, or on an element that was removed. */
export function focusLost(): boolean {
  const a = document.activeElement;
  return !a || a === document.body || !a.isConnected;
}

type FocusRequest = { n: number; onlyIfLost: boolean; target: (() => HTMLElement | null | undefined) | null };

/**
 * Moves focus after the next commit, so the element is rendered by then. `request()` from an event handler
 * or after an awaited action focuses the element behind `ref` (or `target()`). With `onlyIfLost`, it does so
 * only when focus fell back to the page, so a control that kept focus (a failed action's button) keeps it.
 */
export function useFocusRequest<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [req, setReq] = useState<FocusRequest>({ n: 0, onlyIfLost: false, target: null });
  useEffect(() => {
    if (req.n === 0 || (req.onlyIfLost && !focusLost())) return;
    (req.target ? req.target() : ref.current)?.focus();
  }, [req]);
  const request = (opts: { onlyIfLost?: boolean; target?: () => HTMLElement | null | undefined } = {}) =>
    setReq((r) => ({ n: r.n + 1, onlyIfLost: opts.onlyIfLost ?? false, target: opts.target ?? null }));
  return { ref, request };
}

/**
 * Keeps focus in a list when the item that held it goes away (resolved, retried, completed by the agents):
 * mark each item with data-focus-item={id}, spread the returned handlers on the list's container, and after
 * a commit where the focused item is gone and focus fell back to <body>, `pick(index)` says where it goes
 * (index is where the item was, clamped to the new list, so usually the next item; -1 when the list is empty).
 */
export function useFocusRescue(ids: readonly string[], pick: (index: number) => HTMLElement | null | undefined) {
  const last = useRef<{ id: string; index: number } | null>(null);
  const key = ids.join("\n");
  useEffect(() => {
    const l = last.current;
    if (!l || ids.includes(l.id)) return;
    last.current = null;
    if (focusLost()) pick(Math.min(l.index, ids.length - 1))?.focus();
    // `key` stands for `ids`; `pick` reads the DOM after this commit
  }, [key]);
  return {
    onFocus: (e: FocusEvent<HTMLElement>) => {
      const id = (e.target as HTMLElement).closest<HTMLElement>("[data-focus-item]")?.dataset.focusItem;
      last.current = id ? { id, index: ids.indexOf(id) } : null;
    },
    onBlur: (e: FocusEvent<HTMLElement>) => {
      // focus left for nothing while the control is still there (a click on the page's background):
      // the user moved away, so a later removal of that item is not theirs to follow
      if (e.relatedTarget) return;
      const t = e.target as HTMLElement;
      setTimeout(() => {
        if (t.isConnected && !t.matches(":disabled") && focusLost()) last.current = null;
      }, 0);
    },
  };
}
