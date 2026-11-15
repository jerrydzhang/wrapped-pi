# bash-background

A Pi extension that adds generic background jobs to a session: detached
commands through the `bash` tool, and subagents that relaunch Pi itself on a
task. Both kinds share one lifecycle - a background start returns at once,
and when the job finishes its completion is delivered to the session
automatically: it enters between the model's tool calls while a run is
active, or wakes an idle session. When nothing useful remains to do, `wait`
ends the model's turn while jobs keep running; results arrive either way.

Independently authored; no third-party extension code. Bundled by the
wrapped-pi executable without installing files into Pi's configuration.

## What it adds

- **`bash` with `background: true`** — the only command execution path. Ordinary
  calls (no `background`) delegate to Pi's built-in bash unchanged: same
  errors, streaming, rendering, truncation, cwd, and environment.
- A background call returns at once with a session-local job reference
  (`bg-N`), the pid, and a temporary output-log path. Reading that log (with
  the ordinary `read` tool) is for progress while a job runs; the completion
  itself arrives as its own message — `stop`'s result is the outcome, and
  `wait` ends the turn when nothing useful remains.
- **`subagent { task }`** — launches one child Pi in the same working
  directory with fresh context: the task and ordinary project instructions
  (AGENTS.md and friends), never the parent conversation. The child gets the
  ordinary tool set and extension discovery, plus the bundled extensions the
  wrapper pins (see Configuration), but no `subagent` tool of its own — that
  removal is ordinary recursion prevention, not a security boundary; a child
  can still launch Pi through `bash`. No role definitions, routing, chains,
  sandboxing, or resumable conversations: one task, one final response.
- The call returns at once with a job id (`sa-N`). The successful result is
  the child's **final assistant response** — not its tool transcript —
  delivered automatically when the child finishes.
  result is capped at its own byte budget (64 KiB, no line cap; a command
  output's 20-line tail rules do not apply), with the full text kept at the
  result path. Failures report the exit code and a diagnostics tail (the
  child's stderr) without flooding context. While a child runs there is no
  intermediate progress to read: print mode writes the final response only at
  the end.
- **Automatic completion delivery** — a custom message (never user voice)
  delivered with Pi's `steer` carrier: while a run is active it enters at the
  next turn boundary — between the model's tool calls, before its next
  request — and the agent loop cannot end a run with steered messages queued,
  so a completion armed mid-run is always consumed inside that run, never a
  trailing wake; an idle session is woken instead (triggerTurn). Content
  names the job, the outcome, the runtime, a bounded tail, and —
  unconditionally — the full-output path: the completion is the terminal
  carrier of the log path, present on every branch.
- **`wait`** — the conversational yield: when nothing useful remains to do
  while background jobs run, the model calls `wait` alone (no arguments,
  nothing else in the turn) and the turn ends there. The call first arms
  every finished-but-undelivered completion — each exactly once, as its own
  message, which the run then consumes before it ends — and names what is
  still running; jobs keep running and their completions arrive
  automatically later, between tool calls in a future run or waking an idle
  session. Human input also starts a response normally: no cancellation or
  Escape is required to speak through a wait. With no jobs it yields to the
  human the same way, without making another model request. Legacy arguments (`id`,
  `all`, `timeout`) are refused with the current usage — by the strict
  schema and again in execute. The tool is `model-only`: declared to the
  model, never callable from codemode scripts, so a script cannot end a
  run. Pointers ride boundaries — the start message carries the standing
  log path, the completion carries it terminally — and no pull (`wait` or
  `stop`) repeats them.
- **`stop {id}`** — stops a background job this session started (either kind)
  by terminating its process group (SIGTERM, then SIGKILL), and reports the
  observed outcome honestly; it does not claim settlement that did not happen.
  The stop result is the outcome — no completion message follows for a job you
  stopped. Stopping a subagent also cleans up after the child: Pi's print mode
  traps SIGTERM, kills its own detached children, and runs its shutdown hooks
  (including this extension's, so the child's background jobs stop too).
  Because that shutdown escalates against the child's own detached jobs on the
  same TERM-then-KILL ladder, the parent gives a subagent a bounded extra
  grace (5s versus a command's 2s) before SIGKILL, so a child still
  escalating is not killed mid-cleanup — which would orphan the detached
  group it was about to kill (reproduced live and regression-tested). If a
  job survives SIGKILL all the same, the stop says so and the job stays
  running.
- **Footer status** — while any background job is running, the footer carries
  one dim line naming each live job with a timer: `bg-1 34s` for an untimed
  command, `bg-2 10s/1m30s` for one with a `timeout` (elapsed/total),
  `sa-1 12s` for a subagent. It refreshes on the poller's own tick and clears
  the moment nothing is pending, so an idle session with jobs running is
  visibly different from an idle session with nothing pending.
- **`/bg`** — a snapshot card in the transcript listing this session's live
  background jobs, commands and subagents alike (id, elapsed at check,
  elapsed/total when timed, the command or task capped to one 80-char line,
  and the log path in the entry data). Custom entries never enter
  LLM context: the model cannot see the check, and the card stays an honest
  record in scrollback and on disk.
- **`timeout`** (bash only) keeps the bash tool's existing convention: omitted
  means no deadline; a positive value limits total runtime, including time
  spent in the background. A command stopped at its deadline is reported
  through the normal completion message. Subagents take no per-call timeout.

## Subagent configuration

One user-authored file, plus the wrapper's internal launch plumbing. The
wrapper convention holds: nothing is installed into or written under `~/.pi`,
normal Pi configuration (auth included) is inherited untouched by children,
and `wrapped-pi.json` is yours to author.

- **`<agent-dir>/wrapped-pi.json`** (required for `subagent`) — the child's
  model. The agent directory is resolved exactly as Pi resolves it
  (`PI_CODING_AGENT_DIR` respected, default `~/.pi/agent`). One field:
  `{"model": "provider/model-id"}` — any pattern `pi --model` accepts (for
  example `anthropic/claude-haiku-*`); whitespace is trimmed and unknown keys
  are tolerated. The file is read afresh at every launch, so edits apply to
  the next subagent without restarting Pi. The caller does not choose a model
  per invocation, and there is **no silent fallback to the session model**
  and no precedence: with the file missing or unreadable, invalid JSON, or a
  missing, non-string, or blank `model`, the tool refuses and names the file
  and the cause. A pattern that does not resolve makes the child exit
  nonzero; the job reports the failure with the child's diagnostics. A
  settings command is future work — today the file is the whole interface.
- **`WRAPPED_PI_EXTENSIONS`** (exported by the wrapper) — the same
  store-pinned extension list the wrapper passes as `-e`, newline-separated,
  so children load the bundled set including consumer `extraExtensions`.
  Verified against Pi 1.2.0: passing a `-e` path that discovery also finds
  loads that extension once, not twice. Without the variable (plain
  `pi -e bash-background.ts` development use), children start with ordinary
  discovery only.

Children are launched as `pi --print --no-session --model <pattern> [-e
path...] -- <task>` in the session's working directory, inheriting the
process environment minus the parent's `PI_*` session variables (Pi's own
nested-Pi hygiene; the child sets its own). The child marker
(`WRAPPED_PI_CHILD=1`) is set in the child environment and removes the
`subagent` tool there. Context files such as AGENTS.md load regardless of
project trust; protected `.pi` resources follow the user's saved trust
decisions, which in non-interactive mode means skipped when the default
(`ask`) applies — the extension does not pass `--approve` on your behalf.

Credentials are never inspected, copied, or printed by the extension;
children authenticate the way any Pi run does from the inherited
environment and configuration.

## Session lifecycle

- Extension reload (`/reload`) keeps background jobs running (subagents
  included) and reconnects their delivery to the same session. Settlement is
  recovered from child-side evidence: the wrapper shell around each job
  appends a nonce-tagged exit marker, so a reloaded instance recovers a
  subagent's exit code and final response from the result file.
- Quit, `/new`, `/resume` to another session, or `/fork` stops the jobs that
  session started, subagents' descendants included (see `stop` above).
  A replaced session never adopts an old session's jobs.
- **Limitation:** hard process death (crash, SIGKILL) runs no shutdown hooks;
  detached jobs may keep running and their output remains in the log files,
  but no completion is ever delivered. There is no orphan watcher by
  design.

## Loading

Run `nix run .` to launch wrapped-pi with this extension. It preserves normal
Pi configuration and extension discovery; no global installation is needed.
Create `<agent-dir>/wrapped-pi.json` (see [Subagent configuration](#subagent-configuration))
to enable `subagent`.

For source development, load `extensions/bash-background.ts` directly with
plain Pi: `pi -e /path/to/this/repo/extensions/bash-background.ts`.

Pi shows a one-time notice when an extension overrides the built-in `bash`
tool; it is expected and harmless.

## Honest boundaries

- Foreground behavior is the built-in implementation, called directly — not a
  reimplementation.
- Background commands inherit the session process environment (including any
  task/routing variables the launching harness injected) plus the `PI_*`
  session variables Pi's own bash tool sets, reproduced through the public
  extension API. The built-in's internal shell-environment augmentation is
  approximated, so background environment is not claimed bit-for-bit identical.
- Subagents are one detached child process each — no framework: no queue, no
  worker pool, no resumption, no steering. A child that outlives a SIGKILL
  stop is reported, not hunted.
- Output logs are plain temporary files under the OS temp directory, used only
  for result retrieval and mid-run inspection; there are no job records, no
  persistence, no recovery, and no model-facing list/status/output tools
  (`wait` is a conversational turn-yield over jobs the session started, not
  job tooling) — this is not a job platform.
  Human-facing visibility (the footer line and the `/bg` card) is read-only
  over in-memory state.
- No Saccade semantics anywhere: the extension is fully generic.
