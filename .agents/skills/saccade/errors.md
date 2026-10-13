# Errors and degraded mode

Read this when a command fails. Failures exit 1 with a named variant on
stderr (`--json` emits `{"error": "<variant>", "detail": "…"}`). If
resolving an error requires violating any law of this skill, that is a
finding — name it on the thread before proceeding.

- `human_only` — you attempted a judgment act (cancel, reopen). Stop;
  escalate.
- `identity_fallback` — a write with no terminal on stdin, stdout, or
  stderr and no `SACCADE_ACTOR` refuses before any write lands (`--actor`
  rides the terminal arm); export `SACCADE_ACTOR=<name>`.
- `invalid_task_id` — no such task; ids are exact
  `t-N` tokens, not searches.
- `invalid_comment_id` — the `c-N` target names no comment; a task birth
  is addressed `t-N`.
- `not_an_offer` — the `c-N` you accepted, rejected, or used names a
  comment that is not an offer.
- `not_current_offer` — that offer is not the task's standing one (it
  was superseded or consumed). To replace an account, reject it while
  it stands, then offer anew. A use names the source task's standing
  Offered or Concluded account; a superseded source is not usable for
  new reliance.
- `self_reliance` — the use names its own task's conclusion: use
  records reliance between different internal undertakings.
- `self_acceptance` — your declared task scope covers the offered task:
  a task-bound producer cannot accept its own conclusion. Acceptance
  is an outside consumer's act.
- `invalid_state_transition` — read the log; the task's state says
  otherwise (a second offer while one stands, a decision on a concluded
  or open task, revising or withdrawing a bodyless or withdrawn
  comment, cancel or reopen from a state that does not admit it).
- `invalid_incarnation_id` — a claim names an incarnation the record
  never birthed, or one bound to another task; the reference is `i-N`,
  the establishment birth's record position.
- `workspace_already_exists` — the task already holds a workspace
  lineage; one per task.
- `workspace_missing` — the task has no recorded workspace; `sac start`
  and `sac open` establish one, `sac exec` does not.
- `checkpoint_rewind` — the branch tip sits behind the recorded
  checkpoint; a checkpoint advances, never rewinds.
- `workspace_branch_exists` — start would take a branch name the repo
  already holds; the branch scheme is `saccade/t-<n>`, one lineage per
  task.
- `workspace_branch_missing` — the recorded branch no longer exists in
  the repo, so the checkout cannot be recreated; recovery of a missing
  branch is not built.
- `workspace_path_occupied` — the workspace's worktree path is already
  occupied on disk.
- `workspace_dirty` — the workspace's checkout carries staged,
  unstaged, or untracked work; clean refuses before anything
  destructive runs. Commit or remove the work first; ignored files
  don't count.
- `workspace_effect` — a git effect failed; the detail carries git's
  own stderr.
- `workspace_no_repo` — the serving edge resolved no repo root at boot,
  so it cannot run workspace effects.
- `invalid_actor` — the actor name is empty or carries edge whitespace.
- `reason_required` — the prose is empty or whitespace; names, bodies,
  grounds, reasons, and explanations need words.
- `degraded` — a newer binary wrote events this one can't understand.
  Writes and `list` refuse; `sac log` still works. Report it; upgrading
  fixes it.
- `database_error` — includes missing file (reads) and corruption (loud,
  named). A pre-0.10 log (old model) is refused loudly, not folded
  into nonsense — this build starts a fresh record. A 0.10 log holding
  the pre-establishment workspace events degrades (unknown kind): the
  record's workspace lineage was born in no released world, so those
  logs are not migrated. A 0.12.0/schema-2 log refuses as predating
  this binary.
- `server_undiscovered` — no address hint beside the resolved
  database, so no server of that tracker was ever published; start one
  beside it (`sac serve`) or name a destination explicitly.
- `server_required` — an address existed but nothing answered there;
  the hint is stale (stale files are never cleaned — start the server
  or fix the destination).
- `server_mismatch` — a server answered at the discovered address but
  serves a different database than the one the hint sits beside.
- `usage` — the command line itself is wrong; both explicit
  destinations (`--db` with `--server`) refuse here, as do server-only
  verbs (`start`, `open`) aimed at a local `--db`.

When the tracker misbehaves or a refusal needs reproducing, read
`diagnosing.md` beside this file: the attempts log reconstructs the
conditions.
