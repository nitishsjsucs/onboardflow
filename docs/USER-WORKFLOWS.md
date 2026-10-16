# User workflows

How each persona moves through OnboardFlow, as the app works now. All people are synthetic, and HR, IT and Facilities are simulated systems. Roles and permissions are in [`src/shared/roles.ts`](../src/shared/roles.ts); the terms are in [CONTEXT.md](../CONTEXT.md).

Every page follows the same rules:

- An action's result appears inside the row or card where it was started: a short confirmation, or an error that says what happened and what to do next, with the request id. Only that row's button waits while its request is in flight. Confirmations are also announced to screen readers.
- If a request's outcome is unknown (the connection dropped, or the answer could not be read), the message says so, and clicking again is safe: it is sent with the same Idempotency-Key, so the server answers with the stored result instead of acting twice.
- A page that cannot load says why: "No case E999" with a link back, a 403 explained for the role, or the failure with Try again. A failed background refresh keeps the earlier data on screen with a warning.
- Lists keep their filters in the URL, so reload, Back and shared links show the same view.
- The first Tab stop is "Skip to content"; after a navigation, focus moves to the page heading, and each page has its own tab title.

## Signing in (everyone)

Local development:

1. Open any page, for example a case link. Signed out, you land on the login page, which remembers where you were going.
2. Choose a persona. You return to the page you asked for, if your role can open it, or to your home page.
3. To act as someone else, use **Switch persona** in the sidebar. It signs you out and clears everything the previous persona loaded.
4. If the session ends while you work, a banner says "Your session ended" with a link that signs you in and returns you to the same page.

Production (behind Cloudflare Access): Access signs you in with a one-time PIN. **Sign out** is in the sidebar. An Access account that has no OnboardFlow user sees that, and is told to ask an admin. When the Access session ends, the page offers a reload, which goes back through the Access sign-in.

## Employee (new hire)

Home: **My onboarding** (`/me`).

1. Read the stage stepper, the progress bar (stages complete out of 8) and **What is next**, which also says how many tasks are overdue.
2. Read **Updates on your onboarding** if it appears: plain notices such as "Your manager's approval is taking longer than planned. People Operations is following up. Nothing is needed from you." or "We hit a setup problem with IT (a simulated system). The IT team is fixing it."
3. Work the checklist of the current stage: **Mark done** on each task. The row confirms "Marked done: Submit Form W-4"; if it fails, the row says why and the task stays open.
4. Tasks of a stage that has not started show **Not open yet** and when they open. Tasks past their due date show **Overdue**.
5. The page updates by itself when the case moves on (the live indicator shows the connection).

## Manager (hiring manager)

Home: **Approvals** (`/approvals`).

1. Each pending card shows the request (equipment profile, license bundle, privileged access, work mode, site, start date), the SLA ("Due in 5 h", "Due in 3 days", "Overdue by 2 days"), a link to the case, and for a second round the first round's rejection reason and the note People Ops sent with the resubmission.
2. If privileged access was requested, choose **Grant privileged access** or **Approve without privileged access**. Approve stays disabled until one is chosen.
3. **Approve**, or type a reason and **Reject**. The card confirms ("Approved. IT provisioning starts next.") and stays on screen.
4. If another tab or person already decided, the card says "Already decided. Nothing more to do."
5. The list refreshes when you come back to the window.
6. **My team** (`/cases`) lists your direct reports, with search and status and stage filters; a case page is read-only for you. Opening a case outside your team explains that it is not one of your direct reports.

## People Ops coordinator

Home: **Queue** (`/queue`).

1. The queue lists each open People Ops blocker once, highest severity and oldest first. Each item has a plain title ("Manager approval overdue", "Cost center rejected by HR"), the employee linked to the case, the stage's state ("Blocked after round 2"), the age, and the follow-up task the agents created.
2. Narrow it with the kind chips (kept in the URL, for example `/queue?kind=approval_overdue`). The list refreshes by itself when a case changes.
3. Act on the item, by kind:
   - **Approval rejected**: **Resubmit in Approvals** opens the card, scrolled into view and focused. Write what changed and **Resubmit**; the card confirms "Resubmitted: round 2 sent for approval". The agents close the blocker on resubmit.
   - **Cost center rejected by HR**: the item shows what HR (simulated) rejected and the current value. Type a cost center in the `CC-` plus 4 digits form; **Fix cost center** is enabled only for a valid, different value. After "Saved", use **Retry Pre-boarding intake now**. Before the fix, Retry is a secondary button that warns it would spend one of the stage's recovery rounds.
   - **HR outage**: **Retry stage**. While the retry runs, the button reads "Retry running" and the item shows the new round.
   - **Manager approval overdue**: waiting on the hiring manager; the case link shows the details.
   - **Sign-off overdue**: **Decide in Approvals** opens that closeout card.
   - **Checklist tasks overdue**: the case link shows which tasks.
4. **Resolve...** closes a blocker by hand: it asks for a reason and warns that the agents reopen a blocker whose condition still holds.
5. **Mark follow-up done** completes the follow-up task; it does not unblock the stage.
6. Start onboarding from **Cases**: find the employee (search waits until you stop typing; filters stay in the URL; **Load more** shows the next 100) and click **Start onboarding for <name>**.
7. **Approvals**: decide closeout sign-offs, and resubmit rejected requests under **Revision requested**.
8. **Dashboard**: the tiles, stage rows and blocker rows link to the matching cases or queue. If live updates pause, the page says since when and offers **Refresh**.

## IT coordinator

Home: **Queue**, showing IT's blockers.

1. **IT outage** (for example the simulated IT system could not create the account): **Retry stage**, then watch the item move to "Retry running, round N".
2. **License bundle rejected by IT**: choose a bundle from the list, which offers only the bundles IT (simulated) accepts for the employee's employment type, then **Fix license bundle** and **Retry IT provisioning now**.
3. **Device order stalled**: **Retry stage**.
4. On a case page, a blocked IT stage shows the same guided fix and Retry.
5. **Integrations** shows each simulated system's health over a time window, and a case's call log (every attempt, outcome, latency and key). An unknown case id says "No case E999".
6. Approvals are not an IT task; opening `/approvals` says "Approvals are handled by managers and People Ops."

## Facilities coordinator

Home: **Queue**, showing Facilities' blockers.

1. **Facilities outage** (workspace or badge): **Retry stage**.
2. **Badge photo missing**: **Mark photo on file**, which then reads "Photo on file", and **Retry Facilities setup now**.
3. Cases, Dashboard and Integrations work as for IT.

## Admin

Home: **Dashboard**.

1. Read the totals and the stage funnel; click a number to open the matching cases or queue (department rows link to that department's queue).
2. **Queue** covers every department; the department select narrows it (kept in the URL). An overdue manager approval offers **Decide on behalf**.
3. **Approvals**: every card says on whose behalf the admin decides ("on behalf of the hiring manager (M01)" or "of People Ops"); the decision is audited.
4. On a case page, **Admin controls** restart or terminate the workflow: type a reason of at least 10 characters, click the button, and confirm in the step that names the employee and the effect. Terminate is offered only for a started case that has not ended; otherwise the page says why. The result ("Restarted: run 2") appears in place and the reason clears.
5. **Audit** lists every user, agent and workflow action, filterable by action, actor and case.

## Changed on 2026-10-15

What this round improved, and why:

1. **Feedback where the user acted.** Errors used to stack at the bottom of each page, a plain-text 500 surfaced as a JSON parser error, and one Retry in flight disabled every row. Each row and card now owns its action: pending, the error (with a next step and the request id) and the confirmation stay in that item, and successes are announced. A dropped connection or an unreadable answer counts as an unknown outcome, so the next click reuses the Idempotency-Key instead of risking a second execution. Repeated buttons name their subject ("Start onboarding for Wren Abara").
2. **Guided data-issue fix.** A free-text field accepted any value next to a primary Retry, and every wrong value plus Retry spent one of the stage's recovery rounds (the workflow fails the case when they run out). The fix now shows what was rejected and the current value, accepts only values the simulated system takes, and offers Retry as the main action only after the fix. The API is unchanged, so eval scenario R09 still sends an invalid cost center over the API.
3. **The queue as one item per blocker.** Blockers and their follow-ups were two unlinked lists, so each blocker showed up twice, titled by raw ids, with no case link, a Resolve that sent a fixed reason, and no refresh. Each blocker is now one item with its follow-up, a plain title, a case link, the stage's state and the right next action, with filters in the URL, Load more, a Resolve that asks for a reason, and a refresh when the ops hub publishes a new version.
4. **Page-level loading and errors.** A 403 or 404 was retried three times (about 7 s of "Loading case...") and then shown as "Could not load this case."; a failed list showed an empty table. 4xx answers are no longer retried, and each page explains 404, 403 and failures with Try again.
5. **Sign-in, sessions and the shell.** Signing in always went to the home page, there was no sign-out or persona switch, an expired session showed up only as failing actions, and the shell had no skip link, page titles or focus handling. All of these now exist, and the `next` parameter accepts only safe same-site paths.
6. **Phone layouts.** The main column grew to the width of the widest table, so pages scrolled sideways at 375 px, and the funnel's labels rendered at about 6 px. The layout now fits a 375 px screen: lists stack, the cases table becomes cards, wide tables scroll inside their card, and the funnel is HTML with real text.
7. **Approval cards.** Approving without noticing the privileged-access checkbox silently declined it. The choice is now explicit, and cards show readable fields, the SLA in days, round history, a case link, the admin's on-behalf line and their own outcome.
8. **Employee portal in plain language.** New hires saw the staff blocker list ("Subject: apr:E003:manager_approval:1"). They now see plain notices, overdue tasks are marked and counted, and tasks of a stage that has not started say "Not open yet".
9. **Cases and dashboard.** Employees after the first 100 were reachable only by search, filters were lost on reload, and every keystroke sent a request. Cases now page with Load more, keep filters in the URL and wait for typing to stop. The dashboard's numbers link to the lists behind them, and a paused live connection is explained, with a manual Refresh instead of polling.
10. **Safer restart and terminate.** Terminate ran in one click with any reason, including on cases the server would refuse. Both now need a 10-character reason and a confirm step, are offered only where the server would accept them, and confirm the result.
