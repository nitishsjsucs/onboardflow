# User workflows

How each persona moves through OnboardFlow, as the app works now. All people are synthetic, and HR, IT and Facilities are simulated systems. Roles and permissions are in [`src/shared/roles.ts`](../src/shared/roles.ts); the terms are in [CONTEXT.md](../CONTEXT.md).

Every page follows the same rules:

- An action's result appears inside the row or card where it was started: a short confirmation, or an error that says what happened and what to do next, with the request id. Only that row's button waits while its request is in flight. Confirmations are also announced to screen readers.
- Keyboard focus follows the action. A button whose request is in flight is marked unavailable but keeps focus, so after a failure Enter tries again. When an action removes its button (a decided approval, a task marked done), focus moves to the result or to the next step; Cancel returns focus to the button that opened the step; when an item leaves a list (a resolved blocker), focus moves to the item that took its place.
- A repeated button's accessible name starts with its visible text and then names its subject ("Retry stage: IT provisioning for Avery Abara", "Retry running: ..."), so screen readers say what the button shows and speech input matches it.
- If a request's outcome is unknown (the connection dropped, or the answer could not be read), the message says so, and clicking again is safe: it is sent with the same Idempotency-Key, so the server answers with the stored result instead of acting twice.
- A page that cannot load says why: "No case E999" with a link back, a 403 explained for the role, or the failure with Try again. A failed background refresh keeps the earlier data on screen with a warning.
- Lists keep their filters in the URL (Cases, Queue, Audit, and the Integrations window and case id), so reload, Back and shared links show the same view.
- The first Tab stop is "Skip to content"; after a navigation, focus moves to the page heading, and each page has its own tab title, including a page the role cannot open ("Approvals are handled by managers and People Ops." under the heading Approvals).

## Signing in (everyone)

Local development:

1. Open any page, for example a case link. Signed out, you land on the login page, which remembers where you were going.
2. Choose a persona. You return to the page you asked for, if your role can open it, or to your home page.
3. To act as someone else, use **Switch persona** in the sidebar. It signs you out and clears everything the previous persona loaded.
4. If the session ends while you work, a banner says "Your session ended" with a link that signs you in and returns you to the same page.
5. If OnboardFlow cannot tell who is signed in (a server error or no connection), the page says so with **Try again** and stays on the same URL; only a signed-out answer leads to the login page.

Production (behind Cloudflare Access): Access signs you in with a one-time PIN. **Sign out** is in the sidebar. An Access account that has no OnboardFlow user sees that, and is told to ask an admin. When the Access session ends, Access answers the app's requests with a redirect to its sign-in; the app treats that as an ended session and the banner offers **Reload to sign in**, which goes back through the Access sign-in. The login page behind Access offers the same reload. This path is tested with mocks only, not through a real Access session.

## Employee (new hire)

Home: **My onboarding** (`/me`).

1. Read the stage stepper, the progress bar (stages complete out of 8) and **What is next**, which also says how many tasks are overdue.
2. Read **Updates on your onboarding** if it appears: plain notices such as "Your manager's approval is taking longer than planned. People Operations is following up. Nothing is needed from you." or "We hit a setup problem with IT (a simulated system). The IT team is fixing it."
3. Work the checklist of the current stage: **Mark done** on each task. The task turns done only once the server confirms, and the row says "Marked done: Submit Form W-4"; if it fails, the row says why, the task stays open and the button keeps focus, so Enter tries again as the same action.
4. Tasks of a stage that has not started show **Not open yet** and when they open. Tasks past their due date show **Overdue**.
5. The page updates by itself when the case moves on (the live indicator shows the connection).

## Manager (hiring manager)

Home: **Approvals** (`/approvals`).

1. Each pending card shows the request (equipment profile, license bundle, privileged access, work mode, site, start date), the SLA ("Due in 5 h", "Due in 3 days", "Overdue by 2 days"), a link to the case, and for a second round the first round's rejection reason and the note People Ops sent with the resubmission.
2. If privileged access was requested, choose **Grant privileged access** or **Approve without privileged access**. Approve stays disabled until one is chosen.
3. **Approve**, or type a reason and **Reject**. The card confirms ("Approved. IT provisioning starts next.") and stays on screen, showing the decided status and no SLA; focus moves to the confirmation.
4. If another tab or person already decided, the card says "Already decided. Nothing more to do." and shows no status or SLA, since the outcome is not known there.
5. The list refreshes when you come back to the window.
6. **My team** (`/cases`) lists your direct reports, with search and status and stage filters; a case page is read-only for you. Opening a case outside your team explains that it is not one of your direct reports.

## People Ops coordinator

Home: **Queue** (`/queue`).

1. The queue lists each open People Ops blocker once, highest severity and oldest first. Each item has a plain title ("Manager approval overdue", "Cost center rejected by HR"), the employee linked to the case, the stage's state ("Blocked after round 2"), the age, and the follow-up task the agents created.
2. Narrow it with the kind chips (kept in the URL, for example `/queue?kind=approval_overdue`). The list refreshes by itself when a case changes.
3. Act on the item, by kind:
   - **Approval rejected**: **Resubmit in Approvals** opens the card, scrolled into view and focused. Write what changed and **Resubmit**; the card confirms "Resubmitted: round 2 sent for approval". The agents close the blocker on resubmit.
   - **Cost center rejected by HR**: the item shows what HR (simulated) rejected and the current value. Type a cost center in the `CC-` plus 4 digits form; **Fix cost center** is enabled only for a valid, different value. After "Saved", focus moves to **Retry Pre-boarding intake now**. Before the fix, Retry is a secondary button that warns it would spend one of the stage's recovery rounds.
   - **HR outage**: **Retry stage**. While the retry runs, the button reads "Retry running" and the item shows the new round. If the retry after an outage hit a rejected value, the agents leave the outage blocker open beside the new data issue; the outage item then offers no Retry, says the stage is blocked on that value, and **Go to the cost center fix** moves focus to the data issue's item (or, when a kind filter hides it, **Fix it on the case page** opens the case).
   - **Manager approval overdue**: waiting on the hiring manager; the case link shows the details.
   - **Sign-off overdue**: **Decide in Approvals** opens that closeout card.
   - **Checklist tasks overdue**: the case link shows which tasks.
4. **Resolve...** closes a blocker by hand: it asks for a reason and warns that the agents reopen a blocker whose condition still holds. Cancel returns focus to **Resolve...**; once the blocker resolves, its item leaves the list and focus moves to the next item.
5. **Mark follow-up done** completes the follow-up task; it does not unblock the stage. The follow-up line and its confirmation stay in the item.
6. Start onboarding from **Cases**: find the employee (search waits until you stop typing; filters stay in the URL; **Load more** shows the next 100) and click **Start onboarding for <name>**. The status filter also offers **Open (started, not finished)**.
7. **Approvals**: decide closeout sign-offs, and resubmit rejected requests under **Revision requested**.
8. **Dashboard**: the tiles and stage rows link to the matching cases (a stage row opens that stage's open cases, so the list matches its "in stage" count; a completed case keeps its last stage). Blocker counts cover every department, and the table says so: a coordinator's kind rows link to their queue only for kinds that are all their department's (for People Ops, the approval and checklist kinds). If live updates pause, the page says since when and offers **Refresh**.

## IT coordinator

Home: **Queue**, showing IT's blockers.

1. **IT outage** (for example the simulated IT system could not create the account): **Retry stage**, then watch the item move to "Retry running, round N".
2. **License bundle rejected by IT**: choose a bundle from the list, which offers only the bundles IT (simulated) accepts for the employee's employment type, then **Fix license bundle**; the choice clears and focus moves to **Retry IT provisioning now**. An IT outage item on the same stage points to this fix instead of offering Retry.
3. **Device order stalled**: **Retry stage**.
4. On a case page, a blocked IT stage shows the same guided fix and Retry.
5. **Integrations** shows each simulated system's health over a time window, and a case's call log (every attempt, outcome, latency and key); the window and the case id stay in the URL. An unknown case id says "No case E999".
6. Approvals are not an IT task; opening `/approvals` shows the heading Approvals and says "Approvals are handled by managers and People Ops."

## Facilities coordinator

Home: **Queue**, showing Facilities' blockers.

1. **Facilities outage** (workspace or badge): **Retry stage**.
2. **Badge photo missing**: **Mark photo on file**, which then reads "Photo on file" and moves focus to **Retry Facilities setup now**. A Facilities outage item on the same stage points to this fix instead of offering Retry.
3. Cases, Dashboard and Integrations work as for IT.

## Admin

Home: **Dashboard**.

1. Read the totals and the stage funnel; click a number to open the matching cases or queue (department and kind rows link to the queue with that filter).
2. **Queue** covers every department; the department select narrows it (kept in the URL). An overdue manager approval offers **Decide on behalf**.
3. **Approvals**: every card says on whose behalf the admin decides ("on behalf of the hiring manager (M01)" or "of People Ops"); the decision is audited.
4. On a case page, **Admin controls** restart or terminate the workflow: type a reason of at least 10 characters, click the button, and confirm in the step that names the employee, the effect and the reason ("Restart Avery Abara's workflow as run 2? Reason: ..."). Focus moves to that prompt; while it is open the reason is read-only ("Cancel to change it"), and Cancel returns focus to the button. Terminate is offered only for a started case that has not ended; otherwise the page says why. The step stays open until the server answers; then the result ("Restarted: run 2") appears in place with focus, and the reason clears.
5. **Audit** lists every user, agent and workflow action, filterable by action, actor and case (kept in the URL; the typed filters wait until you stop typing).

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

## Changed on 2026-10-16

A review of the 2026-10-15 round found places where the workflows above were not yet true. What changed, and why:

1. **No Retry on an outage that now waits on a data fix.** When the retry after an outage hit a rejected value, the agents left the outage blocker open beside the new data issue, and the queue showed that stale item with a primary Retry stage, with no warning. Each click spent a recovery round on the unfixed value, so two could fail the case. The outage item now points to the data issue's guided fix instead, as the case page already did.
2. **Focus follows the action.** Focus moved only on navigation; pressing Approve, Mark done, Cancel or a confirm step's buttons left it on `<body>` (Chromium moves focus there when a focused button turns disabled). Buttons stay focusable while their request runs, results and next steps take focus, Cancel returns it, and focus moves on when an item leaves a list. Mark done no longer changes the row before the server answers, so a failure leaves the same button focused for Enter.
3. **Accessible names start with the visible text.** "Retry stage" and "Retry running" had the same name, so screen readers never said a retry was running, and speech-input users could not say the visible label.
4. **A failed `/api/me` no longer signs the user out.** One 503 or dropped connection sent a signed-in user to the login page, which behind Access had no button and no reason. The page now explains and offers Try again.
5. **Decided approval cards show the decision.** The card kept on screen still said "pending" and "Overdue by 6 days" above "Approved."
6. **The admin confirm step holds what it confirms.** The reason stayed editable while the step was open, so Confirm could send a 1-character reason; the restart prompt did not name the employee.
7. **Dashboard numbers open lists that match them.** The sign-off funnel row (24) opened a list of 66 that included every completed case, and an IT coordinator's "approval overdue 48" opened an empty queue. The employees list gained a read-only `status=open` filter for the funnel's links.
8. **Smaller fixes.** The license bundle choice clears after a save (it could be sent again); stacked phone cards keep ids and second lines in the value column, and badges keep their width; a data issue's rejection reads once and in words; Audit and Integrations keep their filters in the URL; a page a role cannot open has its own heading and tab title; an Access redirect counts as an ended session.
