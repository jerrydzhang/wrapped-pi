---
name: orca-terminals
description: >-
  Drive and verify live TUI sessions through the `orca` CLI — creating
  terminals, sending prompts and raw keys, reading rendered screen frames or
  streamed output, waiting on tui-idle and exit, and closing cleanly. Use when
  developing or testing pi extensions against a real session: checking whether
  execution ran correctly, whether a UI change rendered correctly, or placing a
  terminal in the right workspace. Terminal mechanics only — when a saccade
  tracker owns this repo, the worktree/task lifecycle belongs to `sac start`,
  `sac open`, and `sac clean`, not to `orca worktree`.
---

# Orca terminals for pi sessions

Verified against Orca 1.4.218 and pi 0.87.0 on this machine. Prefer `--json`
for every call and read fields, not prose.

## Ownership boundary

- This skill owns terminal mechanics: create, send, read, wait, close, and
  choosing which workspace a terminal runs in.
- When the repo has a saccade tracker (`.agents/skills/saccade` present), task
  worktrees, their branches, and their cleanup belong to saccade: `sac start`
  establishes the workspace and submits the pinned pi into one Orca terminal;
  `sac clean` tears it down. Never run `orca worktree create` or
  `worktree rm` for task work in that case, and never close a task terminal
  that `sac open` may need to reveal — the record governs, the workspace is a
  cache.
- Without saccade, `orca worktree create --name <n>` and
  `orca worktree rm --worktree <selector> --force` are the lifecycle commands.
  The full worktree id is `<repoId>::<path>` — copy it whole; a bare repo id
  is not a worktree id.

## Canonical loop

```text
orca status --json
orca terminal create --worktree active --title "pi-test" --command "pi --no-session -e ./extensions/foo.ts" --json
orca terminal wait --terminal <handle> --for tui-idle --timeout-ms 30000 --json
orca terminal send --terminal <handle> --text "<prompt>" --enter --json
orca terminal wait --terminal <handle> --for tui-idle --timeout-ms 300000 --json
orca terminal read --terminal <handle> --screen --json
orca terminal close --terminal <handle> --json
```

- Gate on `status`: `result.runtime.state` must be `ready`; otherwise
  `orca open` first.
- `--command` is typed into a shell the host starts; it is not exec'd. A
  finished command leaves the shell alive.
- Always `wait --for tui-idle` before the first send — input typed into a
  starting TUI is lost. Pi is explicitly supported by tui-idle.
- `create` normally lands on a background surface with a discoverability
  warning; that is harmless for driving and reading. Pass `--focus` only to
  reveal it to a human.

## Sending

```text
orca terminal send --terminal <h> --text "continue" --enter --json
orca terminal send --terminal <h> --text "$(printf '\x1b[A')" --json    # arrow up
orca terminal send --terminal <h> --text "$(printf '\x1b')" --json      # Esc
orca terminal send --terminal <h> --interrupt --json                    # cancel a turn
orca terminal send --terminal <h> --text "<prompt>" --enter --wait-submit 10 --json
```

- Raw bytes pass through `--text` verbatim, ESC included (verified end to
  end). There is no named-key API; compose ANSI bytes yourself.
- `accepted: true` proves input acceptance, not a started turn. With
  `--wait-submit <seconds>` a text-plus-Enter prompt gains additive stages:
  `input_accepted`, then `turn_started`. A default send observes 0 s, so a
  receipt stopping at `input_accepted` is unproven, not failed.
- After an ambiguous transport failure, re-run the exact command with the
  reported `--retry-request <id>`; never blind-resend.

## Reading

Two distinct reads:

- Default (stream): accumulated output with escape sequences stripped. TUIs
  come back as stacked fragments — useless for rendering checks. Page with
  `--cursor <nextCursor>` while `limited`; `oldestCursor` marks dropped
  lines. Read before sending, then read `--cursor <prev>` to capture one
  command's response.
- `--screen`: the rendered frame, what a human sees. No history to page —
  `--screen` and `--cursor` are mutually exclusive. Check `source`: `screen`,
  `stream`, or `screen-unavailable` (fell back to accumulated output; treat
  as no render evidence). A `draft` field is composer text, never terminal
  output.

There is no wait-for-text on terminals. To assert UI state, poll
`read --screen` until the expected content appears or a budget expires.

## Waiting

- `--for tui-idle`: the TUI settled; always pass `--timeout-ms`. Read
  `wait.satisfied`, not the fact that something printed.
- `--for exit`: the terminal session (the shell) exiting — not your typed
  command finishing. A run that completed leaves the prompt standing.
- Timeouts surface as `ok: false` with `error.code: "timeout"` and no
  `result`, or as `wait.satisfied: false` — handle both, and treat them as a
  checkpoint, not a failure.
- An exited or closed terminal still answers later waits with
  `status: "exited"`, `exitCode`, and `exitCause.kind`
  (e.g. `operator_close`).

## Handles and cleanup

- Handles come from `create` or `list` and are runtime-scoped. On
  `terminal_handle_stale` (or after an Orca restart), re-run
  `orca terminal list --worktree <selector> --json` and continue with the
  replacement only — never dual-send.
- `close --terminal <h>` closes one terminal; `--tab` closes its whole tab;
  `--worktree <selector> --all` stops everything in a workspace (a bulk
  close that cannot confirm every PTY stopped fails `unverifiable` — do not
  report the processes as exited).
- Useful auxiliaries: `terminal split` (pi in one pane, test runner in
  another), `terminal rename`, `terminal switch`, `terminal show`
  (metadata plus preview).

## Workspace placement

Selectors: `active`/`current` for the enclosing Orca-managed worktree,
`path:<absolutePath>`, `id:<repoId>::<worktreePath>`.
`orca worktree current --json` reveals the enclosing one. Default to
`--worktree active`; this repo is already registered.

## Recipes

Working-tree extension on the installed pi (mutable paths are a dev concern;
the release build must not see them):

```text
orca terminal create --worktree active --command "pi --no-session -e ./extensions/foo.ts" --json
```

Pinned wrapped build (extensions resolved from the Nix store):

```text
orca terminal create --worktree active --command "nix run . -- <pi args>" --json
```

Execution smoke without the TUI (then read the stream, not the screen):

```text
orca terminal create --worktree active --command "pi --no-session -e ./extensions/foo.ts --print '<probe>'" --json
# then: wait tui-idle, read with cursor paging
```

UI verify: baseline `read --screen` → send prompt → wait tui-idle (or
`--interrupt` to cancel) → `read --screen` again → compare against the
expected frame (extension-added lines, status bar, warnings). Session
hygiene: `--no-session`, `--session-dir <dir>`, `--session-id <id>`.

Isolated checkout without saccade: `worktree create --name <n>
[--setup skip]`, place terminals with `--worktree id:<repoId>::<path>`,
remove with `worktree rm --force`.
