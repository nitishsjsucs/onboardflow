// Live, read-only subscription to the OpsHubAgent (/agents/ops-hub-agent/global).
import { useQueryClient } from "@tanstack/react-query";
import { useAgent } from "agents/react";
import { useState } from "react";
import type { HubState } from "../../shared/agent-state.ts";
import { keys } from "../api/queries.ts";
import type { LiveStatus } from "./status.ts";

export function useHubLive(): { state: HubState | null; status: LiveStatus } {
  const qc = useQueryClient();
  const [state, setState] = useState<HubState | null>(null);
  const [status, setStatus] = useState<LiveStatus>("connecting");
  useAgent<HubState>({
    agent: "ops-hub-agent",
    name: "global",
    onStateUpdate: (s) => {
      setState(s);
      void qc.invalidateQueries({ queryKey: keys.dashboard });
    },
    onOpen: () => setStatus("connected"),
    onClose: () => setStatus((prev) => (prev === "connected" ? "reconnecting" : "offline")),
    onError: () => setStatus("offline"),
  });
  return { state, status };
}
