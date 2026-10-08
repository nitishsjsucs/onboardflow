# OnboardFlow domain glossary

Terms used in the code, the tests and the docs. All people are synthetic; HR, IT and Facilities are simulated systems.

| Term | Meaning |
|---|---|
| Case | One employee's onboarding, keyed by employee id (E001 to E150). Status: not_started, in_progress, blocked, awaiting_approval, complete, failed. |
| Stage | One of eight ordered steps of a case: intake, paperwork, manager_approval, it_provisioning, facilities_setup, provisioning_verification, orientation, closeout (`src/shared/stages.ts`). |
| Gate | A D1 predicate the workflow checks before every wait and after every wake-up or bounded timeout: tasks done, approval decided, resubmitted, retried (ADR 0002). |
| Wake-up | A `wake_<stage>` workflow event sent by the CaseAgent after a command commits, or by the scan's nudge rule. It only makes the workflow re-check its gate; it never carries a decision. |
| Checkpoint | A human approval inside the workflow: manager_approval (the employee's manager) and closeout (People Ops). Admins may decide on behalf, which is audited. |
| Round | The attempt counter of a stage: approval rounds at checkpoints (at most 3), recovery rounds at operation stages. Retry and resubmit advance it. |
| Blocker | A rule-detected obstacle with a kind (integration_outage, data_issue, provisioning_stalled, approval_overdue, employee_task_overdue, approval_rejected), an owner department and a severity. At most one open blocker per dedupe key. |
| Follow-up | The task created with each blocker for the owning department. Completing it does not unblock anything by itself; blockers auto-resolve only when their condition clears. |
| Provisioning item | A resource in a simulated system tracked for the case (HR worker, documents, orientation; IT account, licenses, device; Facilities workspace, badge) with status and poll count. |
| Simulated system | The HR, IT or Facilities stand-in under `/sim/*`, with real HTTP semantics, idempotency keys, async resources and injectable faults. Not a real integration. |
| Integration call | One HTTP attempt from a workflow step to a simulated system, logged in `integration_calls` with an `integration.call` audit row. |
| Guarded mutation | A state change written as one stamped `UPDATE ... WHERE <guard>` with its audit and stored response in the same batch (ADR 0008). |

## Roles

Four roles: employee, manager, coordinator (with a department: people_ops, it or facilities) and admin. Department is an attribute of a coordinator, not a fifth role. The capability matrix is in `src/shared/roles.ts`.

## License bundle policy

Which bundles the simulated IT system accepts per employment type (a bundle outside this table is a genuine 422):

| Employment type | Allowed bundles | Seed default |
|---|---|---|
| full_time | ft-standard, ft-engineering | ft-engineering in Engineering, ft-standard elsewhere |
| contractor | contractor-basic | contractor-basic |
| intern | intern-basic | intern-basic |

Cost centers must match `CC-####`; the seed uses one per org unit.
