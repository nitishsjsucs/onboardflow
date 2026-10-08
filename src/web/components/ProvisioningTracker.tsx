import type { CaseDetail } from "../../shared/api.ts";
import { SYSTEM_IDS } from "../../shared/domain.ts";
import { EmptyState } from "./EmptyState.tsx";
import { label, StatusBadge } from "./StatusBadge.tsx";

const NAMES = { hr: "HR", it: "IT", facilities: "Facilities" } as const;

/** Provisioning per (simulated) system: resource, status, external id, polls. */
export function ProvisioningTracker({ items }: { items: CaseDetail["provisioning"] }) {
  if (items.length === 0) return <EmptyState>Nothing provisioned yet.</EmptyState>;
  return (
    <div className="grid two">
      {SYSTEM_IDS.map((sys) => (
        <div key={sys}>
          <h3>
            {NAMES[sys]} <span className="simulated">simulated</span>
          </h3>
          <ul className="tasks">
            {items
              .filter((i) => i.system === sys)
              .map((i) => (
                <li key={i.resource}>
                  <div>
                    <div className="title">{label(i.resource)}</div>
                    <div className="muted mono">
                      {i.externalId ?? "pending"}
                      {i.polls > 0 ? `, ${i.polls} polls` : ""}
                    </div>
                  </div>
                  <StatusBadge status={i.status} />
                </li>
              ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
