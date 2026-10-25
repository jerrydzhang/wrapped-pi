# Errors and degraded mode

Read this when a command fails. Failures exit 1 with a named variant on
stderr (`--json` emits `{"error": "<variant>", "detail": "..."}`). If
resolving an error requires violating any law of this skill, that is a
finding - name it on the thread before proceeding.

- `human_only` - you attempted a judgment act (cancel, reopen). Stop;
  escalate.
- `identity_fallback` - a write with no terminal on stdin, stdout, or
  stderr and no `SACCADE_ACTOR` refuses before any write lands (`--actor`
  rides the terminal arm); export `SACCADE_ACTOR=<name>`.
- `invalid_task_id` - no such task; ids are exact
  `t-N` tokens, not searches.
- `invalid_comment_id` - the `c-N` target names no comment; a task birth
  is addressed `t-N`.
- `not_an_offer` - the `c-N` you accepted, rejected, or bound names a
  comment that is not an offer.
- `not_current_offer` - that offer is not the task's standing one (it
  was superseded or consumed). To replace an account, reject it while
  it stands, then offer anew. A bind selects the source task's current
  offered or concluded account; a superseded account is not selectable.
- `self_reliance` - the use names its own task as source: reliance
  runs between different undertakings.
- `self_acceptance` - your declared task scope covers the offered task:
  an agent scoped to the task cannot accept its own conclusion.
  Acceptance is an outside consumer's act.
- `invalid_state_transition` - read the log; the task's state says
  otherwise (a second offer while one stands, a decision on a concluded
  or open task, revising or withdrawing a bodyless or withdrawn
  comment, supplying a title to a kind that carries none, cancel or
  reopen from a state that does not admit it).
- `invalid_incarnation_id` - a claim names an incarnation the record
  never birthed, or a historical establishment bound to another task;
  a native incarnation is task-free. The reference is `i-N`, the
  fold's dense incarnation number.
- `workspace_branch_exists` - provisioning would take a branch name
  the repo already holds; generated names carry a uniqueness suffix,
  so this names a real collision.
- `workspace_path_occupied` - the workspace's worktree path is already
  occupied on disk.
- `workspace_label_invalid` - the descriptive label of a
  `sac workspace new` name is not a safe single path and ref
  component; name it again.
- `workspace_entropy_unavailable` - the OS entropy source failed, so
  no unique workspace name exists. This is infrastructure, not bad
  input; retry, and report it if it persists.
- `workspace_dir_create_failed` - the OS refused to create the
  workspace directory. Infrastructure, not bad input.
- `workspace_path_invalid` - the target of a workspace change is not
  an absolute path.
- `workspace_path_missing` - the target of a workspace change does
  not exist; a change selects an existing directory and creates
  nothing.
- `saved_session_missing` - the saved session file a change or resume
  names does not exist; only the exact recorded association resolves.
- `saved_session_mismatch` - the saved session file carries another
  session's id; a reused native id never rebinds to other history.
- `saved_session_unreadable` - the saved session exists but its
  header cannot be read or validated; nothing was moved.
- `session_live` - the session's launch guard is held by a live
  process; exit that session first. Workspace switching moves stopped
  sessions only.
- `session_quiescence_unknown` - the launch guard could not be
  probed, so liveness is unknown; nothing was moved.
- `session_activation_in_flight` - another activation holds the
  session's lock; try again when it settles.
- `session_lock_unavailable` - the session's activation lock file
  could not be opened. Infrastructure; nothing was moved.
- `storage` - the database refused a write. Where an effect (a
  provisioned workspace, a moved session header) already happened, the
  detail discloses what stands - the effect is not rolled back.
- `workspace_effect` - a git effect failed; the detail carries git's
  own stderr.
- `workspace_no_repo` - the serving edge resolved no repo root at boot,
  so it cannot run workspace effects.
- `invalid_actor` - the actor name is empty or carries edge whitespace.
- `reason_required` - the prose is empty or whitespace; names, titles,
  bodies, grounds, reasons, and explanations need words - and a
  revision names at least one field to repair.
- `degraded` - a newer binary wrote events this one can't understand.
  Writes and `list` refuse; `sac log` still works. Report it; upgrading
  fixes it.
- `database_error` - includes missing file (reads) and corruption (loud,
  named). A pre-0.10 log (old model) is refused loudly, not folded
  into nonsense - this build starts a fresh record. A 0.10 log holding
  the pre-establishment workspace events degrades (unknown kind): the
  record's workspace lineage was born in no released world, so those
  logs are not migrated. A 0.12.0/schema-2 log refuses as predating
  this binary.
- `server_undiscovered` - no address hint beside the resolved
  database, so no server of that tracker was ever published; start one
  beside it (`sac serve`) or name a destination explicitly.
- `server_required` - an address existed but nothing answered there;
  the hint is stale (stale files are never cleaned - start the server
  or fix the destination).
- `server_mismatch` - a server answered at the discovered address but
  serves a different database than the one the hint sits beside.
- `usage` - the command line itself is wrong; both explicit
  destinations (`--db` with `--server`) refuse here, as does the
  server-only `launch` aimed at a local `--db`.

When the tracker misbehaves or a refusal needs reproducing, read
`diagnosing.md` beside this file: the attempts log reconstructs the
conditions.
