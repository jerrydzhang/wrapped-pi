---
name: saccade
description: Use when running the `sac` CLI — working tasks, claiming ownership, offering and reviewing conclusions, or any question about the tracker's events, task states, tiers, or comments.
  - ".agents/**"
x-saccade-version: 0.13.0
---

# Saccade (`sac`)

One binary over an append-only event log; the world is a fold of that log.
The record is the reasoning cache: conclusions live on threads so the next
reader — often you, after a context loss — never re-derives them. There is
no managed execution in this build: the tracker records undertakings,
accounts, and decisions — it holds no waits and supervises nothing
(waiting is the caller's temporary read), and launching asks the host for
a terminal, never manages the session.

## Identity

Tier is **possessed, never passed**. `SACCADE_ACTOR` set means agent tier;
unset means human tier. There is no tier argument, and actor names never
carry authority. Mutating commands record your identity from possession;
reads need none.

Before your first tracker write, run `sac identity`. Preserve an injected
`SACCADE_ACTOR` and task scope on ordinary writes: do not override them with
`--actor`, environment assignments, or names copied from the requester or
thread. An agent establishes its own actor label only when `SACCADE_ACTOR`
is absent; then set it and check `sac identity` before writing.

A session's environment may declare a **scope**: `SACCADE_TASK` (its task
binding, `t-N`) anchors it, `SACCADE_INCARNATION` (an `i-N` birth reference)
and `SACCADE_WORKSPACE` (an absolute path) ride with it. The scope is
disclosure riding every record you write — never proof, never ownership.
It feeds exactly one gate: an agent whose declared scope covers a task
cannot **accept** that task's offer (`self_acceptance`). Humans are never
scope-gated.

An unpossessed write is guarded: with `SACCADE_ACTOR` unset, a mutation
with a terminal attached to any of stdin, stdout, or stderr proceeds on
one notice line (a named `--actor` passes silently), and the same
mutation with no terminal anywhere refuses (`identity_fallback`),
`--actor` notwithstanding — export `SACCADE_ACTOR=<name>`, as `--actor`
rides the terminal arm.

## The record is the reasoning cache

These are behaviors, not suggestions — every one exists because an agent
that skips it burns its reasoning on re-derivation or acts on guesses.

1. **Reason lightly, retrieve, then reason deeply — in that order.**
   Before any deep reasoning, frame what you would need to know, then read
   the context around it: the thread, `sac log`, the code the record names.
   Deep reasoning comes last and only on what retrieval didn't answer.
   Deep-first reasoning is the failure mode, not a style.
2. **Park conclusions at altitude** as they form (`sac comment t-N "…"`) —
   parking is durability: an unparked conclusion dies with your context, a
   parked one survives reboot, handoff, and the next session. Park each
   conclusion when it forms, never batched at delivery — a crash between
   formation and park loses it. A cache entry is semantic content that
   survives rewording: the verdict, the why, the dead end, the deviation.
   What a maintainer would need to re-derive is a conclusion; code comments
   and commit messages are not the record. Narration of the next ten lines
   is not a conclusion; a write that cannot name its next reader doesn't
   earn bytes.
3. **Disagreement is a finding.** When the record, the skill, and the
   code disagree — with each other or with what you observe — stop and
   name the conflict on the thread and route it to your asker — the
   asker carries it to the skill's author. Never resolve it silently.
   Hidden staleness poisons the cache for every later reader.

## The model

Tasks are named undertakings: `open → offered → concluded`, with
`cancelled` as the human's stop. Ownership is separate from state — a
claim records whole-task responsibility (human, task-bound incarnation,
or named external agent), transfers freely, and never gates anything.

Work concludes through accounts and decisions, all of them comments:

- **Offer** — the whole-task closing account. Moves `open → offered`.
  Any tier may offer; offering is not owner-gated.
- **Accept** — names the offer (`c-N`), no prose. Moves `offered →
  concluded`. Accept when the work is actually relied on, not when it
  is merely finished. A task-bound producer cannot accept its own
  task's offer.
- **Reject** — names the offer with required grounds. Moves `offered →
  open`, asking reconsideration; it does not establish wrongness. Any
  participant may reject, including the producer. To replace an
  account, reject it while it stands, then offer anew — there is no
  separate withdrawal door, and a second offer on an offered task
  refuses.
- **Use** — lives on the consuming task, names a source offer and a
  reason. Records reliance between internal tasks; creates no
  acceptance, and acceptance creates no use.
- **Request** — prose seeking response, recording why work happened.
  Never reopens anything by itself.
- **Note** — everything else that parks on a thread or replies to a
  record.

Older offers stay addressable; decisions naming a superseded offer
refuse (`not_current_offer`). A concluded task never reopens — later
faults belong in new tasks. Human cancellation of an unfinished task
requires an explanation; human reopening of a cancelled one does too.
`offered` is a normal persistent state, not a queue to clear.

Revision repairs presentation only: the prose-carrying variants
(note, request, offer, grounds, reason) can be revised — the fold
presents the latest and names a reviser; the bodyless accept refuses
the door, references never change, and a substantive change is a
reject and a fresh offer. Withdrawal is the note's standing-error
repair alone: the body leaves the fold, a tombstone stays.

## Working a task

There is no runner in this build. You arrive at a task through whatever
launched you — a human, a coordinating agent, `sac start` — working in a
workspace the record names. The tracker's part of the loop:

1. **Retrieve first** (the protocol above): read your thread whole —
   the spec, prior verdicts, dead ends, parked working state — then the
   code and record it names.
2. **Claim if you own it** (`sac claim t-N`): whole-task
   responsibility, recorded on the ledger, transferring on the next
   claim. A task-scoped helper can contribute without claiming; a
   claim without an incarnation reference is a named external agent's
   claim.
3. **Work and park** conclusions as comments as they form. Deviate
   openly: if the spec cannot be followed as written, say so on the
   thread with evidence.
4. **Offer** the whole-task account (`sac offer t-N "…"`): outcome,
   evidence — what changed, which tests ran with counts, which
   commands were exercised, which files were touched, omissions and
   deviations. The offer is what a consumer reviews.
5. **The consumer decides.** A reviewer accepts (`sac accept c-N`) or
   rejects with grounds (`sac reject c-N --grounds "…"`); the producer
   may reject its own offer to reopen for a fix. Failure honestly
   reported is success.

Human judgment acts: cancellation (`sac cancel t-N --explanation "…"`)
and reopening (`sac reopen t-N --explanation "…"`).

## Commands

| Command | Who | Notes |
|---|---|---|
| `sac create task "name"` | any tier | the reply names what was born |
| `sac claim t-N` | any tier | ownership transfer; never a state change |
| `sac comment t-N "…"` / `sac comment c-<seq> "…"` | any tier | a note, parked or replied |
| `sac request t-N "…"` / `sac request c-<seq> "…"` | any tier | prose seeking response; the reply names the record's position and the destination task's recorded workspace |
| `sac offer t-N "…"` | any tier | the whole-task closing account |
| `sac accept c-<offer>` | any tier | conclude through the standing offer |
| `sac reject c-<offer> --grounds "…"` | any tier | reconsideration with grounds; reopens the task |
| `sac use t-<consumer> c-<offer> --reason "…"` | any tier | record reliance on a source offer |
| `sac cancel t-N --explanation "…"` | **human only** | stop an unfinished undertaking |
| `sac reopen t-N --explanation "…"` | **human only** | resume a cancelled undertaking |
| `sac revise c-<seq> "…"` (prose also by `--stdin` or `--body-file`) | any tier | presentation repair on prose-carrying variants; the fold names a reviser, `sac log` keeps the original |
| `sac withdraw c-<seq> --note "…"` | any tier | the note's standing-error repair: body out, tombstone stays |
| `sac artifact t-N <path> [--name …]` | any tier | park an artifact on the thread — the client hashes the file into the store at state_dir/artifacts/<sha256> and the wire carries {name, hash} only |
| `sac wait t-N\|c-N --after <seq> --until offer\|activity` | anonymous | block until a match lands: structurally matching activity, or an Offer born on the task — either way strictly after the cursor; nothing is recorded |
| `sac checkpoint t-N` | any tier | record the task branch's tip as its checkpoint; needs a recorded workspace — none is created by checkpoint |
| `sac start t-N "initial request"` (or `--stdin`; `--base <ref>` names a stacked base) | any tier | establish the task's workspace through the server's own Git effects, record the request, assign the incarnation ownership, and submit the pinned native Pi into one host terminal with the request as its prompt; a repeat start reveals the standing workspace's live terminal or reports its address — no second launch, request, or ownership change |
| `sac open t-N` | any tier | ensure the recorded environment exists (a missing checkout is recreated from its branch tip); a fresh association births the establishment alone, a standing one reveals its live terminal or reports its address — never a harness launch, request, or ownership change |
| `sac clean t-N` | any tier | stop the workspace's host terminals and running work, remove the checkout; the branch (unmerged commits included), records, checkpoints, and artifacts stand; a checkout with staged, unstaged, or untracked work refuses first; nothing is recorded |
| `sac exec t-N -- <command and argv>` | any tier | run a command inside the recorded workspace: identity and routing injected from the record, argv boundaries kept, nothing recorded |
| `sac identity` | anonymous | report the environment-declared actor/tier, scope, and routing — disclosure, never a liveness claim |
| `sac list` / `sac show <ids…>` / `sac log` | anonymous | the board, threads and records, raw events |
| `sac search <terms…> [in:t-N by:NAME kind:K] [-C N]` | anonymous | exact terms over titles, comment prose, explanations; kinds: task, note, request, offer, accept, reject, use, artifact, explanation |
| `sac serve [--bind] [--port]` | — | the sole-writer HTTP server and console |
| `sac clone --at <seq> --out <path>` | anonymous | copy the log's prefix into a fresh tracker |
| `sac skill install` / `sac skill check` | any tier | deploy this binary's copy of this skill into ./.agents/skills/saccade, or verify the copy against it; a differing copy refuses until deleted |

Not in this build (later slices, do not assume them): managed
completion obligations, steering a live session,
proposal machinery of any kind. Launching is the host's: `sac start`
asks the host (Orca) for one terminal and never supervises it —
restarting Saccade leaves native sessions alone.

## Prose

Comment prose is CommonMark — tables and math included — and the
console renders them, math and code click-to-copy. Write LaTeX for
math, never unicode approximations. Dollars are the only math
delimiters, and they are exact:

- inline: `$x^2+1$`, `$\mathcal{L}[f]$` — one dollar each side
- display: `$$\frac{a}{b}$$` — two dollars each side

`\(...\)` and `\[...\]` are not the door — they stay literal
backslashes. A formula the renderer cannot parse keeps its source bytes.

## Searching

`sac search` finds records by exact terms over the folded text fields —
task titles, comment prose, cancellation explanations, and artifact
names. No ranking, no fuzzy: a term matches as a whole, word-bounded,
case-folded, or it doesn't. Results are thread-grouped pointers with
one matched line each, in record order.

- **Find where something was decided**: `sac search telemetry`.
- **Follow a reference**: an id term is a reference search — `c-907`
  finds every record citing that comment, `t-49` everything naming
  that task.
- **Narrow**: `in:` `by:` `kind:` — only-show-me filters;
  every narrowing prints visible counts. `sac search --help` owns the
  grammar.
- **Read the neighborhood**: `sac search c-907 -C 3`.
- **Read whole records**: bare seqs show the raw event at that
  position, `c-N` the record's folded form, `t-N` the task plus
  thread. The pipe reads end to end.

Pointers stay pointers. The power tail is unchanged: `sac log | grep`
reads the raw record.

## Waiting

`sac wait t-N|c-N --after <seq> --until offer|activity` blocks until
a match lands. Both flags are required: the cursor is never
defaulted, the mode never chosen for you. In activity mode a task
wait matches every record folding into the task; a comment wait
matches its reply chain — replies at any depth, revisions and
withdrawals of chain members, and decisions targeting it. Unrelated
activity elsewhere on the task and prose-only citations never match.
Any matching activity wakes, partial replies included; the result
never claims the request is answered or the task complete — you
interpret it and may wait again.

In offer mode only an Offer born on the target task strictly after
the cursor wakes the wait: every offer birth qualifies — the one
standing, one already rejected, one long concluded — and no later
decision filters an earlier birth. A revision of an offer is not a
new birth, and notes, requests, use, decisions, and cancellation
never match. Offer mode addresses a task (t-<n>) only: `--until
offer` on a comment target refuses.

The cursor is a global record position you supply, never defaulted:
matches are strictly after it. Every read discloses the snapshot's
cursor — `cursor` on the `--json` faces, a trailing `cursor <seq>`
line on text — and a request write names its own `seq`; read, ask,
wait, in that order, and records that land between the steps are
caught, because committed records are checked before any blocking.
The reply lists matched records in record order and the cursor of the
snapshot inspected through, for the next wait. A wait records nothing
and holds nothing: it is a read the caller owns, not a registration
the tracker keeps; ordinary interruption ends it.

`sac request`'s reply also names the destination: the record's `seq`,
its root task (a comment target resolves through the chain), and the
task's recorded workspace facts — an address, never delivery; no
recorded workspace means none returned.

## Hygiene

- Any create not meant for the record goes to a scratch `--db`: the
  in-repo default is the project's live tracker.
- Comments park on threads. Side files are where conclusions go to die.

## Event times

`--at <epoch-seconds>` backdates an event. Use it only with a
**sourced** measurement (a timestamp from a log, an import, a CI run).
Never invent or eyeball a time; omit `--at` and the event stamps
honestly as "now".

## Workspaces

`sac start t-N "initial request"` establishes the workspace: one
machinery-authored establishment record carries the task reference,
the canonical base commit (the primary checkout's current HEAD, or
`--base <ref>`), the branch (`saccade/t-<n>`), and the worktree's
absolute path — beside the tracker's db, under `worktrees/t-<n>`. That
record's position is the **shared workspace/incarnation identity**,
referenced `i-N`: claims and `SACCADE_INCARNATION` carry it, and first
start's ownership names it while the request keeps its caller's
authorship.

The record holds establishment facts, not liveness: a checkout can go
missing while its association stands. `sac open` (and a repeat start)
recreate a missing checkout from its branch's current tip — committed
advancement survives, identity never changes — and leave a present
checkout's files, uncommitted changes, programs, and ownership alone.
A branch that no longer exists refuses (`workspace_branch_missing`);
recovery beyond that is not built.

`sac clean t-N` tears the recorded workspace down: the host's terminals
and running work in it stop, git removes the checkout, and the branch —
unmerged commits included — stands with every record, checkpoint, and
artifact. A checkout carrying staged, unstaged, or untracked work
refuses (`workspace_dirty`) before anything destructive runs; ignored
files are not work. A vanished checkout and registration clean again
as success, and `sac open` afterwards recreates the checkout from the
retained branch under the same workspace/incarnation identity — never
a successor. Nothing is recorded and no task state gates it: teardown
is explicit authorization to terminate running work, never an inference
about the work's completion, and no state transition fires it.

`sac exec t-N -- <argv>` is the harness-agnostic door into a
workspace: it injects the session's identity and routing
(`SACCADE_ACTOR` — the caller's declared attribution preserved, else
the command's own label, so no wrapper session writes as an unpossessed
human — `SACCADE_TASK`, `SACCADE_INCARNATION`, `SACCADE_WORKSPACE`,
plus repo, db, and server), overwriting stale bindings inherited from
another task, and execs the argv with its argument boundaries intact.
`sac start` submits the pinned native Pi through the same injection.
A standing workspace never grows a terminal per visit: open and repeat
start reveal the live terminal the host holds in the worktree, or
report the address. The record governs; the workspace is a cache.

## Errors and degraded mode

Failures exit 1 with a named variant on stderr (`--json` emits
`{"error": "<variant>", "detail": "…"}`). If resolving an error
requires violating any law of this skill, that is a finding — name it
on the thread before proceeding.

The variant table and degraded mode live in `errors.md` beside this
skill — read it when a command names a variant. When the tracker
misbehaves or a refusal needs reproducing, `diagnosing.md` reconstructs
the conditions from the attempts log.

## Semantics worth knowing

- Task states: `open → offered → concluded`; `cancelled` is the
  human's stop with a recorded explanation, reopenable only by a human
  with another explanation. Concluded is final — later faults open new
  tasks.
- Ownership is the ledger on the task's context: every claim appends
  (who, when, which record), the last entry is the current owner, and
  no state gates a claim.
- The offer that stands is the task's *current offer*: decisions name
  it by id, stale decisions refuse, and a reject clears it so a new
  offer can stand.
- Artifacts are pointers, never payloads — the record holds name+hash,
  the bytes live content-addressed under the state root, an artifact
  renders at its home position (CLI pointer line, console inline image
  via `/a/<hash>`), and the store write precedes the record so a crash
  orphans content, never points at absence.
- Each repo has one tracker; its state root derives from the repo
  path, never from your working directory — `--repo` or `SACCADE_REPO`
  names the project when working from elsewhere. One destination per
  command: `--db` selects local operations on that file, `--server`
  selects a running server for reads, writes, and waits alike, and
  both flags refuse together. With neither, the repo's usual database
  is resolved and its server is discovered from the address hint
  beside that database (`<db>.addr`, published by `sac serve` after it
  binds) and verified to serve exactly that file — missing,
  unreachable, or mismatched refuses; there is no default localhost
  and no fallback to local writes. Scratch work names its own
  destination explicitly: `sac serve --port 0 --db /tmp/scratch/x.db`
  for the server, `--db` or `--server` for every client command.
