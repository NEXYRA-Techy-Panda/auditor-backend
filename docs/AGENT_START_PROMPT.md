# AGENT_START_PROMPT — auditor-backend

Copy everything below the line into a new agent session working on
**auditor-backend** only. Replace the bracketed assigned-layer block with
the approved layer prompt.

---

You are working on the NEXYRA **auditor-backend** repository.

## Repository identity

- Sibling folder: `auditor-backend/` (portable: `../auditor-backend`).
- Remote: `https://github.com/NEXYRA-Techy-Panda/auditor-backend.git`
- Planned stack: Node.js, Express, TypeScript, SQLite.
- Role: validate/persist CSV/JSON imports, serve analytics/report data, call
  the private Python service server-side. Owns its own SQLite DB.
- Owner (foundation + long-term): Mohan.

## Mandatory first steps

1. Read applicable `AGENTS.md` instructions (parent + this repo; if absent,
   record that and continue).
2. Read `docs/PROJECT_CONTEXT.md`, `docs/WORKSPACE_MAP.md`, and
   `docs/HANDOFF.md` in THIS repository.
3. Inspect the branch (`git branch --show-current`), working tree
   (`git status --short`), recent commits (`git log --oneline -10`), and
   relevant source (`package.json`, `src/`, migrations). Verify the state
   claimed in `HANDOFF.md`.
4. Understand role/boundaries/ownership. Respect: private SQLite (never open
   the simulator DB); UTC + Asia/Kolkata + kWh invariants; fault-label
   exclusion; Python called server-side only; upload-only in MVP1.

## Execution rules

- Implement **only** the assigned layer below.
- Respect the shared contract (F1 defines it).
- Preserve existing changes: no destructive git operations without instruction.
- Avoid deferred features (live mode, advanced tariffs, sensor/BMS, pricing).
- Distinguish Planned vs Implemented vs Verified; never invent evidence.
- No `.env` secrets or DB files in commits; do not commit/push unless authorised.

## After the layer

- Update `docs/HANDOFF.md` (§§2–3/7–11): date, branch/HEAD, changed files,
  actual commands/results, blockers, contract notes.

## Return

- Changed files; commands + results; limitations/blockers; contract proposals.

## Continuity protocol (mandatory, F0.1+)

BEFORE WORK:

- Read applicable `AGENTS.md` (parent + this repo; if missing, record that).
- Read `docs/PROJECT_CONTEXT.md`, `docs/WORKSPACE_MAP.md`, `docs/HANDOFF.md`,
  `docs/ACTIVE_TASK.md`, and relevant recent `docs/PROGRESS_LOG.md` entries.
- Inspect actual source, branch (`git branch --show-current`) and working-tree
  changes (`git status --short`, `git log --oneline -10`).
- Reconcile documentation with code; verify the HANDOFF state claim.
- If an unfinished task exists in ACTIVE_TASK.md, report its relationship to
  the new assignment. Resume it when the new assignment is its continuation;
  otherwise preserve it and explicitly record any superseding instruction.
- Do not automatically restart completed work.

AT TASK START:

- Write/update `docs/ACTIVE_TASK.md` with scope, status (`in_progress`),
  review status, and planned checks.
- If starting a different task, ensure the previous task's outcome is preserved
  in `docs/PROGRESS_LOG.md` first (append an entry; never rewrite history).

DURING WORK:

- Save a checkpoint after each meaningful edit group, migration, integration,
  or verification: update `docs/ACTIVE_TASK.md` (timestamp with timezone,
  completed steps, files changed, exact next action).
- Checkpoint before a long-running command; record its invocation and output
  location. After the command, record its actual result.
- Do not wait until the final response to save context.
- Record the exact next action and any incomplete files.

AT COMPLETION OR INTERRUPTION:

- Update `docs/HANDOFF.md` (date, branch/HEAD, changed files, actual
  commands/results, blockers, contract notes).
- Append to `docs/PROGRESS_LOG.md` (timestamp, layer, changes, decisions,
  commands/results, unresolved items, next action, review status, commits if any).
- Update `docs/ACTIVE_TASK.md` (status `completed`/`blocked`, review status,
  exact next action).
- Separate implementation completion from review approval. Never self-assign
  architecture acceptance.
- Report uncommitted changes and cross-repository dependencies. Update affected
  sibling-repository handoffs only when those repositories are in the assigned
  scope; otherwise report the required follow-up.
- Save documentation even when commits are not authorised.
- Do not commit or push unless the layer prompt authorises it. From F1 onward,
  the owner-approved policy is: commit reviewed completed-layer work and push
  to the correct origin when the layer prompt authorises it (the F0/F0.1
  no-push rule is historical only). Never force-push; verify the push result
  and remote branch hash.

If context files are missing, reconstruct them from inspected evidence,
identify unknowns, and avoid inventing history.

## ASSIGNED LAYER AND TASK: [paste the approved layer prompt here]

(F1–F6 are NOT complete until their prompts run.)
