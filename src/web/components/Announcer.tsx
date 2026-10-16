// One visually hidden polite live region for the app, plus announce() for
// success messages ("Retry requested for IT provisioning: round 3 running").
// Errors are not announced here: they render inline with role=alert where the
// user acted. A nested provider reuses the outer region, so the shell and the
// test harness can both wrap pages without creating two regions.
import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";

type Announce = (text: string) => void;
const AnnounceContext = createContext<Announce | null>(null);

export function AnnouncerProvider({ children }: { children: ReactNode }) {
  const outer = useContext(AnnounceContext);
  if (outer) return <>{children}</>;
  return <LiveRegion>{children}</LiveRegion>;
}

function LiveRegion({ children }: { children: ReactNode }) {
  const [text, setText] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  // Clear first, then set: a screen reader announces the same sentence again when it repeats.
  const announce = useCallback((t: string) => {
    if (timer.current) clearTimeout(timer.current);
    setText("");
    timer.current = setTimeout(() => setText(t), 30);
  }, []);
  return (
    <AnnounceContext.Provider value={announce}>
      {children}
      <div className="visually-hidden" aria-live="polite" aria-atomic="true" data-testid="announcer">
        {text}
      </div>
    </AnnounceContext.Provider>
  );
}

export function useAnnounce(): Announce {
  return useContext(AnnounceContext) ?? noop;
}

function noop() {}
