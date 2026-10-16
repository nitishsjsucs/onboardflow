import { useEffect } from "react";

/** Sets the tab title to "<page>, OnboardFlow", so each route is distinct in history and for screen readers. */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title ? `${title}, OnboardFlow` : "OnboardFlow";
  }, [title]);
}
