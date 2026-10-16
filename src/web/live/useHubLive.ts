// Live, read-only subscription to the OpsHubAgent (/agents/ops-hub-agent/global).
// `onVersion` runs when a later frame carries a new hub version (not for the
// first frame), so a page such as the queue can refetch its own lists without
// polling. Coordinators and admins hold subscribe_hub.
import { useQueryClient } from "@tanstack/react-query";
import { useAgent } from "agents/react";
import { useRef, useState } from "react";
import type { HubState } from "../../shared/agent-state.ts";
import { keys } from "../api/queries.ts";
import type { LiveStatus } from "./status.ts";

export function useHubLive(opts: { onVersion?: (version: number) => void } = {}): { state: HubState | null; status: LiveStatus } {
  const qc = useQueryClient();
  const [state, setState] = useState<HubState | null>(null);
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const onVersion = useRef(opts.onVersion);
  onVersion.current = opts.onVersion;
  const lastVersion = useRef<number | null>(null);
  useAgent<HubState>({
    agent: "ops-hub-agent",
    name: "global",
    onStateUpdate: (s) => {
      setState(s);
      void qc.invalidateQueries({ queryKey: keys.dashboard });
      const previous = lastVersion.current;
      lastVersion.current = s.version;
      if (previous !== null && s.version !== previous) onVersion.current?.(s.version);
    },
    onOpen: () => setStatus("connected"),
    onClose: () => setStatus((prev) => (prev === "connected" ? "reconnecting" : "offline")),
    onError: () => setStatus("offline"),
  });
  return { state, status };
}
