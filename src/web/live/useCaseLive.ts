// Live, read-only subscription to one CaseAgent (/agents/case-agent/<id>).
// State frames update React state and invalidate the matching queries.
import { useQueryClient } from "@tanstack/react-query";
import { useAgent } from "agents/react";
import { useState } from "react";
import type { CaseState } from "../../shared/agent-state.ts";
import { keys } from "../api/queries.ts";
import type { LiveStatus } from "./status.ts";

export function useCaseLive(employeeId: string): { state: CaseState | null; status: LiveStatus } {
  const qc = useQueryClient();
  const [state, setState] = useState<CaseState | null>(null);
  const [status, setStatus] = useState<LiveStatus>("connecting");
  useAgent<CaseState>({
    agent: "case-agent",
    name: employeeId,
    onStateUpdate: (s) => {
      setState(s);
      void qc.invalidateQueries({ queryKey: keys.case(employeeId) });
      void qc.invalidateQueries({ queryKey: keys.checklist });
    },
    onOpen: () => setStatus("connected"),
    onClose: () => setStatus((prev) => (prev === "connected" ? "reconnecting" : "offline")),
    onError: () => setStatus("offline"),
  });
  return { state, status };
}
