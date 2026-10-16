// The outcome of an action, rendered inside the row or card that started it:
// an error (role=alert, with what to do next and the request id) or a short
// success line. A new success on the same item replaces the error. It can take
// focus (tabIndex -1) when the action removed the control that had it.
import type { Ref } from "react";
import { describeError, type ErrorContext } from "../api/errors.ts";

export function ActionMessage({ error, success, context, ref }: { error?: unknown; success?: string | null; context?: ErrorContext; ref?: Ref<HTMLDivElement> }) {
  if (error) {
    const d = describeError(error, context ?? { action: "do this" });
    return (
      <div role="alert" className="action-msg error" tabIndex={-1} ref={ref}>
        {d.message}
        {d.next ? ` ${d.next}` : ""}
        {d.requestId ? <span className="request-id mono"> Request id {d.requestId}</span> : null}
      </div>
    );
  }
  if (success)
    return (
      <div className="action-msg ok" tabIndex={-1} ref={ref}>
        {success}
      </div>
    );
  return null;
}
