import type { LiveStatus } from "../live/status.ts";

const TEXT: Record<LiveStatus, string> = { connecting: "Connecting", connected: "Live", reconnecting: "Reconnecting", offline: "Offline" };

export function LiveIndicator({ status }: { status: LiveStatus }) {
  return (
    <span className={`live ${status}`} role="status" aria-label={`live updates: ${TEXT[status]}`}>
      <span className="dot" />
      {TEXT[status]}
    </span>
  );
}
