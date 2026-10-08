import type { AuditEventView } from "../../shared/api.ts";
import { EmptyState } from "./EmptyState.tsx";

/** The visible audit trail: who did what to which entity, when. */
export function AuditTimeline({ events, hasMore, onMore, loadingMore }: { events: AuditEventView[]; hasMore?: boolean; onMore?: () => void; loadingMore?: boolean }) {
  if (events.length === 0) return <EmptyState>No audit events yet.</EmptyState>;
  return (
    <>
      <ol className="timeline" aria-label="audit trail">
        {events.map((e) => (
          <li key={e.seq} data-testid="audit-event">
            <time dateTime={e.occurredAt} className="muted">
              {new Date(e.occurredAt).toLocaleString()}
            </time>
            <div>
              <strong>{e.action}</strong> on <span className="mono">{e.entityType}:{e.entityId}</span>
              <div className="muted">
                by {e.actorType} {e.actorId}
                {e.actorRole ? ` (${e.actorRole})` : ""}
                {e.runNo ? `, run ${e.runNo}` : ""}
                {e.round ? `, round ${e.round}` : ""}
              </div>
            </div>
          </li>
        ))}
      </ol>
      {hasMore && onMore ? (
        <button type="button" onClick={onMore} disabled={loadingMore} style={{ marginTop: 8 }}>
          {loadingMore ? "Loading..." : "Load more"}
        </button>
      ) : null}
    </>
  );
}
