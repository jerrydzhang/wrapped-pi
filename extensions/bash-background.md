# bash-background

Generic background bash jobs and conversational Pi workers, with shared
visibility, automatic delivery, stop, and cleanup. Independently authored;
no third-party subagent framework and no Saccade-specific runtime semantics.

## Tools

### `bash { command, background?: true, timeout? }`

Foreground calls delegate to Pi's built-in bash: same streaming, rendering,
errors, working directory, truncation, and timeout behavior. Background calls
return immediately with a session-local `bg-N`, pid, and private temporary log.
The result arrives automatically as an extension-authored message between tool
calls, or wakes an idle parent. Read the log for useful progress inspection,
not repeated status polling. Completion includes a bounded tail and the full
log path; `stop` reports its own outcome instead of sending another completion.

A positive `timeout` limits total command runtime, including time in the
background. Omitted means no deadline. This does not impose a worker deadline.

### `wait {}`

**When nothing useful remains to do, call wait alone.** It is a conversational
yield, not a blocking job barrier: Pi ends the run without requesting another
model response. Human messages, worker messages/replies, and command completions
resume the parent through ordinary input and automatic delivery. No Escape or
cancellation is needed to speak to a waiting agent.

- Jobs and worker conversations stay alive.
- Already-pending results are delivered before yielding. Consumed history is
  never replayed to release a future wait.
- With no background work, yield to the human the same way.
- Explicit queued follow-ups keep Pi's normal end-of-run semantics.
- Call wait in its own tool batch. A nonterminating sibling tool prevents Pi
  from ending the run; ordinary foreground tools are not made interruptible.
- The old `id`, `all`, and `timeout` arguments are deliberately removed and
  refused. Dependencies belong in the agent's reasoning, not wake-up filters.
- Wait is `model-only`, not callable from codemode scripts. Internally it uses
  Pi's native `terminate: true` tool-result contract, without timers, waiter
  promises, or input interception. Other extensions can still request their
  own continuation at Pi's normal boundaries.

### `subagent { task }`

Launches one addressable worker in the same working directory, returning a
stable `sa-N`, its configured model, and transcript/diagnostic paths. Initial
context is the task plus ordinary project instructions, **never the parent
conversation**. Children retain ordinary tools and bundled extensions, but
cannot use `subagent` recursively. This is recursion prevention, not a security
boundary: a child can still launch programs through bash.

A worker is one long-lived Pi RPC subprocess with an in-memory conversation.
After completing a run it remains addressable, not destroyed. A run ending is
not proof that the assigned task is complete. Natural text replies arrive as
**Reply from worker**; use `message` with the same id for follow-up work or
answers. A failed or interrupted run reports its reason explicitly and can
receive a follow-up if its process remains alive. Explicit `stop` terminates and forgets
it: the worker cannot be messaged or resumed and disappears from `/bg`.
There is no pause-without-termination option, per-call model override, or task
timeout.

### `message { id, message }`

- In the parent, `id` is an existing `sa-N`. Send instructions, follow-up work,
  or answers. Busy workers receive messages at supported Pi turn boundaries;
  idle workers start a new turn in the **same conversation**. A non-agent busy
  boundary (for example manual compaction from another extension) can refuse
  explicitly without submitting; resubmit after that operation settles.
- In a child, the only destination is `id: "parent"`. Send progress, questions,
  or blockers before finishing, then continue useful work or call wait alone.
  Sibling messaging is not supported.
- Messages are explicitly attributed. Parent/human messages reach a child as
  custom messages, not fabricated human chat; child reports reach the parent
  as extension-authored messages identifying the worker and whether it was
  responding to parent or direct human input.
- Success means submission, not proof of reading, agreement, or completion.
  Text is limited to 16 KiB; put longer details in a file and send its path.

Worker replies have a 64 KiB byte budget, without bash's 20-line tail cap.
The full structured event transcript is always available at its log path.
Tool transcripts are available to the human inspector, not automatically
injected into parent model context. A worker finishing a run and its process
exiting are distinct events.

### Worker waiting and replies

- **Waiting on background work:** the footer and `/bg` show the worker's pending
  child-job ids and that it resumes automatically. These ids belong to that
  worker, not the parent's `bg-N` namespace; parent `stop` cannot address them.
  This is quiet status, not a parent notification. Tests or commit hooks can run in the background while the
  child's Pi run is idle; their results resume the child normally. Do not send
  `continue` nudges or poll its worktree because it is waiting.
- **Questions, blockers, and progress sent with `message`:** delivered immediately.
  If the worker then waits without background work, its status is **waiting for
  input after message**. There is no redundant yield notification. This describes
  its lifecycle, not a semantic classification of the message: a worker can also
  send a completed report via `message` and then wait.
- **Replies:** a natural assistant text response without tool calls is delivered
  as a reply, not a task-completion assertion. Text accompanying a tool call
  (including `wait`) remains progress in the inspector, never a final reply.
  Explicit progress notifications should use `message`.
- **Unexplained stop:** if a worker ends without a reply, pending background work,
  or a message to the parent, the parent receives an explicit status notice:
  `Worker ended its turn without a reply. No background work is pending; it will
  not resume automatically.` The extension does not silently restart it.
- **Interruptions and errors:** notify the parent with structured reason metadata
  (`interrupted` or `error`), even if a message was already sent or jobs remain.
  No automatic continuation is promised for that interrupted/failed run. Existing
  background jobs keep their normal delivery behavior; they are not cancelled.

Reply/status notice details include the settlement `reason`. A reply resumed by
an automatic background result identifies that trigger rather than claiming a
new parent message started it. Parent Escape continues to interrupt only the
parent run, not its workers. No extra model calls or automatic nudges are added.

### `stop { id }`

Stops a bash job or a working/idle worker by id. A worker's stdin is closed for
orderly shutdown; the shared process-group TERM-then-KILL ladder provides a
bounded backstop. Workers receive 5 seconds of TERM grace versus bash's 2
seconds, allowing their own detached-job cleanup to escalate before the parent
kills them. Surviving or unsignalable groups are reported honestly, not falsely
claimed stopped. A successful explicit stop suppresses further automatic replies;
its result is the outcome.

A successfully stopped worker is removed from the session registry, `/bg`,
and parent memory rather than retained as a closed conversation. Stopping an
already-ended worker also discards its entry. If the process group may still
be alive, the entry remains visible instead of hiding an unresolved stop.
A failed stop does not mute subsequent replies, errors, or eventual process-exit
notices. Its transport may already be closing, so a further message can still
fail explicitly rather than claiming submission.
Private temporary diagnostic/event logs are not deleted; they are not saved,
resumable Pi sessions. Natural turn completion, unlike stop, keeps the worker
idle and reusable.

## Human observability

The footer shows running bash jobs with elapsed time (and total when timed),
plus worker phases such as `sa-2 working 12s`, `sa-2 idle`, and
`sa-2 waiting on background work: bg-3; resumes automatically`. Waiting-for-input,
unexplained, and interrupted states stay distinct and visible. All live workers,
including those with a failed/interrupted run, remain messageable and stoppable.

**`/bg`** opens the live job/worker inspector. **`/bg sa-N`** opens that worker's
conversation directly. Bash jobs appear alongside workers.

- List: arrows select, Enter opens, Escape or `q` closes.
- Conversation: live assistant text, tool activity/results, messages, state,
  model, elapsed time, and the full event-log path.
- Arrows/PageUp/PageDown scroll; Home goes to the top, End follows the live
  tail again. `m` composes a direct human message to a worker; `x` confirms
  termination and removal of a worker. Removing the selected worker returns
  to the list. Previously ended workers offer `x` to remove their entry.
  Escape returns to the list; `q` closes.
- Inspection and direct human messages do not add transcript dumps to the
  parent's model context. The worker can still reply/report back normally.

This opens and controls the **actual live worker conversation** through the
parent's single RPC connection. It does not launch a second Pi session, copy a
saved conversation, or attach a second terminal driver. It is an inspector,
not the complete native child Pi TUI. Non-TUI `/bg` retains a read-only snapshot
entry; custom terminal UI is not available over RPC.

The inspector retains a bounded 128 KiB finalized transcript window plus a
bounded live response, wraps by terminal columns, sanitizes terminal controls,
and limits the wrapped view to 4000 lines.
The complete JSONL event log remains on disk. Closed/reloaded inspectors stop
their refresh timers.

## Configuration and loading

Create **`<agent-dir>/wrapped-pi.json`** with:

```json
{"model": "provider/model-id"}
```

Pi's agent-directory convention applies (`PI_CODING_AGENT_DIR`, otherwise
`~/.pi/agent`). Any model pattern accepted by `pi --model` is allowed. The file
is read afresh on every launch; whitespace is trimmed and unknown keys are
tolerated. Missing/unreadable/invalid JSON or a missing/non-string/blank model
refuses explicitly, naming the file. There is **no silent fallback** to the
parent model and no per-invocation model selection. Unresolvable models and
startup failures report diagnostics; partially started children are cleaned up.

The wrapper exports **`WRAPPED_PI_EXTENSIONS`**, its newline-separated,
store-pinned `-e` list, including consumer `extraExtensions`. Workers inherit
that list and always load this extension for their inbox and message tool.
Plain `pi -e ./extensions/bash-background.ts` development therefore works too.
The child marker `WRAPPED_PI_CHILD=1` removes recursive subagent access.

Run `nix run .` for the bundled wrapper, or develop with:

```sh
pi --no-session -e ./extensions/bash-background.ts
```

Children use the same Pi interpreter/CLI entry as their parent, with
`--mode rpc --no-session --model <configured-pattern>`, in the parent cwd.
Task text travels through RPC, not shell interpolation. Normal configuration,
authentication, and discovery are inherited; parent `PI_*` session variables
are removed so the child sets its own. No credentials are inspected, copied,
or printed, and the wrapper installs nothing into `~/.pi`.

Project instructions load normally. Protected project resources follow Pi's
saved trust decisions; no `--approve` is supplied. Headless child extension
permission/auth/question dialogs are **declined**, never auto-approved, with
an attributed notice to the parent. Workers should use `message` for questions.

## Lifecycle and limits

- Parent `/reload` keeps jobs and worker conversations alive. One RPC transport
  and stdout reader survive in process-global state; the replacement extension
  rebinds observation/delivery without respawning the child or adding a driver.
  Bash exit status is recovered from the existing nonce-tagged log marker.
- Quit, `/new`, changing sessions, and `/fork` stop that session's jobs,
  including idle workers and worker-owned background descendants. Replacement
  sessions never adopt old workers.
- There is no cross-restart worker persistence, resumption framework, worker
  pool, roles, routing, chains, schedules, automatic worktrees, or peer network.
- Logs are private temporary files (0600); the complete event log can grow on
  disk like a bash output log. RPC frames are bounded in memory, and malformed
  protocol closes the child input and triggers shared cleanup. Excessive
  undelivered worker mail produces an explicit error and stops the worker;
  additional content remains in the event log rather than growing parent RAM.
- Hard parent process death cannot run cleanup hooks. Bash jobs may survive;
  RPC pipe closure requests orderly child shutdown but is not an orphan-reaping
  guarantee. There is no separate watcher or supervisor.
- Foreground bash is the built-in implementation. Background shell environment
  reproduces Pi's public session variables but is not claimed bit-for-bit
  identical to every internal shell augmentation.
