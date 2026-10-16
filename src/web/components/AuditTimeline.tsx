import { useRef } from "react";
import type { AuditEventView } from "../../shared/api.ts";
import { useFocusRequest } from "../hooks/useFocus.ts";
import { ActionButton } from "./ActionButton.tsx";
import { EmptyState } from "./EmptyState.tsx";

/** The visible audit trail: who did what to which entity, when. `onMore` returns the fetch, so focus can follow it. */
export function AuditTimeline({ events, hasMore, onMore, loadingMore }: { events: AuditEventView[]; hasMore?: boolean; onMore?: () => unknown; loadingMore?: boolean }) {
  const list = useRef<HTMLOListElement>(null);
  const more = useFocusRequest<HTMLElement>();
  if (events.length === 0) return <EmptyState>No audit events yet.</EmptyState>;
  return (
    <>
      <ol className="timeline" aria-label="audit trail" ref={list}>
        {events.map((e) => (
          <li key={e.seq} data-testid="audit-event" tabIndex={-1}>
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
        <ActionButton
          busy={loadingMore}
          style={{ marginTop: 8 }}
          onClick={async () => {
            const first = events.length;
            await onMore();
            // Load more goes away after the last page: continue at the first new event
            more.request({ onlyIfLost: true, target: () => list.current?.children[first] as HTMLElement | undefined });
          }}
        >
          {loadingMore ? "Loading..." : "Load more"}
        </ActionButton>
      ) : null}
    </>
  );
}
