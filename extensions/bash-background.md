# bash-background

A Pi extension that adds generic background jobs to a session: detached
commands through the `bash` tool, and subagents that relaunch Pi itself on a
task. Both kinds share one lifecycle - a background start returns at once, the
result reaches the session either as an automatic follow-up message when the
job finishes, or in-turn through `wait` when the model needs it before ending
its turn.

Independently authored; no third-party extension code. Bundled by the
wrapped-pi executable without installing files into Pi's configuration.

## What it adds

- **`bash` with `background: true`** — the only command execution path. Ordinary
  calls (no `background`) delegate to Pi's built-in bash unchanged: same
  errors, streaming, rendering, truncation, cwd, and environment.
- A background call returns at once with a session-local job reference
  (`bg-N`), the pid, and a temporary output-log path. Reading that log (with
  the ordinary `read` tool) is for progress while a job runs; the completion
  itself has named owners — the automatic follow-up, `wait`, or `stop`.
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
  delivered automatically as a follow-up, or returned in-turn by `wait`. The
  result is capped at its own byte budget (64 KiB, no line cap; a command
  output's 20-line tail rules do not apply), with the full text kept at the
  result path. Failures report the exit code and a diagnostics tail (the
  child's stderr) without flooding context. While a child runs there is no
  intermediate progress to read: print mode writes the final response only at
  the end.
- **Automatic completion delivery** — a custom message (never user voice)
  delivered with Pi's `followUp` carrier: it never interrupts a running turn,
  and it wakes an idle session. Content names the job, the outcome, the
  runtime, and a bounded tail with the full-output path.
- **`wait {id}` / `{all: true, timeout?}`** — synchronization, not polling:
  waits for background job(s) this session started (either kind) and returns
  the result in this turn. The completion text the follow-up would have
  carried comes back from the call instead — no follow-up fires for a job
  `wait` returns. A job whose result was already delivered gets a one-line
  pointer (outcome and log path), never a second copy of the tail. `all: true`
  resolves when nothing is still running, headed per job — bash and subagent
  jobs mix freely. `timeout` bounds the wait in seconds; on expiry each
  still-running job reports one line with its elapsed time and log path, never
  an output tail — progress inspection stays a deliberate log read. Aborting
  the call ends the wait only; the job keeps running.
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

Two environment variables, read by the extension at call time — the wrapper
convention: nothing is installed into `~/.pi`, and normal Pi configuration
(auth included) is inherited untouched by children.

- **`WRAPPED_PI_SUBAGENT_MODEL`** (required for `subagent`) — the child's
  model, one user-configured pattern accepted by `pi --model` (for example
  `anthropic/claude-haiku-*`). The caller does not choose a model per
  invocation, and there is **no silent fallback to the session model**: with
  the variable unset or blank the tool refuses and names it; with a pattern
  that does not resolve, the child exits nonzero and the job reports the
  failure with the child's diagnostics.
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
Set `WRAPPED_PI_SUBAGENT_MODEL` in the environment where you launch it to
enable `subagent`.

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
  (`wait` is synchronization over jobs the session started — it returns
  completions, it is not job tooling) — this is not a job platform.
  Human-facing visibility (the footer line and the `/bg` card) is read-only
  over in-memory state.
- No Saccade semantics anywhere: the extension is fully generic.
