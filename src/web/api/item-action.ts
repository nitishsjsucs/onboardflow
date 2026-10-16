// Per-item feedback for a mutation. Each row or card that can act calls its own
// mutation hook and wraps it here, so pending, the last error and the last
// success belong to that item: one Retry in flight disables only its own row.
// Keys still come from actionKeys (one per user action, reused on a retry
// after an unknown outcome), because the wrapped hooks use useAction.
import { useRef, useState } from "react";
import { useAnnounce } from "../components/Announcer.tsx";

export type ItemAction<V, R> = {
  /** Runs the action unless this item already has one in flight. Resolves to the result, or undefined on failure. */
  run: (v: V) => Promise<R | undefined>;
  pending: boolean;
  error: unknown;
  success: string | null;
  reset: () => void;
};

export function useItemAction<V, R>(mutation: { mutateAsync: (v: V) => Promise<R> }, success?: (result: R, v: V) => string | null): ItemAction<V, R> {
  const announce = useAnnounce();
  const [state, setState] = useState<{ error: unknown; success: string | null; pending: boolean }>({ error: null, success: null, pending: false });
  const inFlight = useRef(false);
  const run = async (v: V): Promise<R | undefined> => {
    if (inFlight.current) return undefined;
    inFlight.current = true;
    setState((s) => ({ ...s, pending: true }));
    try {
      const r = await mutation.mutateAsync(v);
      const msg = success ? success(r, v) : null;
      setState({ error: null, success: msg, pending: false });
      if (msg) announce(msg);
      return r;
    } catch (e) {
      setState({ error: e, success: null, pending: false });
      return undefined;
    } finally {
      inFlight.current = false;
    }
  };
  return { run, pending: state.pending, error: state.error, success: state.success, reset: () => setState({ error: null, success: null, pending: false }) };
}
