// The outcome of an action, rendered inside the row or card that started it:
// an error (role=alert, with what to do next and the request id) or a short
// success line. A new success on the same item replaces the error.
import { describeError, type ErrorContext } from "../api/errors.ts";

export function ActionMessage({ error, success, context }: { error?: unknown; success?: string | null; context?: ErrorContext }) {
  if (error) {
    const d = describeError(error, context ?? { action: "do this" });
    return (
      <div role="alert" className="action-msg error">
        {d.message}
        {d.next ? ` ${d.next}` : ""}
        {d.requestId ? <span className="request-id mono"> Request id {d.requestId}</span> : null}
      </div>
    );
  }
  if (success) return <div className="action-msg ok">{success}</div>;
  return null;
}
