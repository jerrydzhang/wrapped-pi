# bash-background

A Pi extension that adds generic background command execution to the `bash`
tool: `background: true` runs a command detached, returns immediately, and
delivers the result to the session as an automatic follow-up message when the
command finishes.

Independently authored; no third-party extension code. Bundled by the
wrapped-pi executable without installing files into Pi's configuration.

## What it adds

- **`bash` with `background: true`** — the only command execution path. Ordinary
  calls (no `background`) delegate to Pi's built-in bash unchanged: same
  errors, streaming, rendering, truncation, cwd, and environment.
- A background call returns at once with a session-local job reference
  (`bg-N`), the pid, and a temporary output-log path. Reading that log at any
  time (with the ordinary `read` tool) never consumes or suppresses the
  completion.
- **Automatic completion delivery** — a custom message (never user voice)
  delivered with Pi's `followUp` carrier: it never interrupts a running turn,
  and it wakes an idle session. Content names the job, the exit code or
  signal, the runtime, a bounded output tail, and the full-output path when
  the tail was cut.
- **`bash_stop {id}`** — stops a background command this session started by
  terminating its process group (SIGTERM, then SIGKILL), and reports the
  observed outcome honestly; it does not claim settlement that did not happen.
- **`timeout`** keeps the bash tool's existing convention: omitted means no
  deadline; a positive value limits total runtime, including time spent in the
  background. A command stopped at its deadline is reported through the
  normal completion message.

## Session lifecycle

- Extension reload (`/reload`) keeps background commands running and
  reconnects their delivery to the same session.
- Quit, `/new`, `/resume` to another session, or `/fork` stops the commands
  that session started. A replaced session never adopts an old session's jobs.
- **Limitation:** hard process death (crash, SIGKILL) runs no shutdown hooks;
  detached commands may keep running and their output remains in the log
  files, but no completion is ever delivered. There is no orphan watcher by
  design.

## Loading

Run `nix run .` to launch wrapped-pi with this extension. It preserves normal
Pi configuration and extension discovery; no global installation is needed.

For source development, load `extensions/bash-background.ts` directly with
plain Pi: `pi -e /path/to/this/repo/extensions/bash-background.ts`.

Pi shows a one-time notice when an extension overrides the built-in `bash`
tool; it is expected and harmless.

## Honest boundaries

- Foreground behavior is the built-in implementation, called directly — not a
  reimplementation.
- Background children inherit the session process environment (including any
  task/routing variables the launching harness injected) plus the `PI_*`
  session variables Pi's own bash tool sets, reproduced through the public
  extension API. The built-in's internal shell-environment augmentation is
  approximated, so background environment is not claimed bit-for-bit identical.
- Output logs are plain temporary files under the OS temp directory, used only
  for result retrieval and mid-run inspection; there are no job records, no
  persistence, no recovery, no list/status/output tools — this is not a job
  platform.
- No Saccade semantics anywhere: the extension is fully generic.
