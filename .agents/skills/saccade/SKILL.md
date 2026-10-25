---
name: saccade
description: Use when running the `sac` CLI - working tasks, claiming ownership, offering and reviewing conclusions, or any question about the tracker's events, task states, tiers, or comments.
  - ".agents/**"
x-saccade-version: 0.15.0
---

# Saccade (`sac`)

One binary over an append-only event log; the world is a fold of that log.
The record is the reasoning cache: conclusions live on threads so the next
reader - often you, after a context loss - never re-derives them. There is
no managed execution in this build: the tracker records undertakings,
accounts, and decisions - it holds no waits and supervises nothing
(waiting is the caller's temporary read), and launching asks the host for
a terminal, never manages the session.

## Identity

Tier is **possessed, never passed**. `SACCADE_ACTOR` set means agent tier;
unset means human tier. There is no tier argument, and actor names never
carry authority. Mutating commands record your identity from possession;
reads need none.

Before your first tracker write, run `sac identity`. Preserve an injected
`SACCADE_ACTOR` and task scope on ordinary writes: do not override them with
`--actor`, environment assignments, or names copied from the thread or
thread. An agent establishes its own actor label only when `SACCADE_ACTOR`
is absent; then set it and check `sac identity` before writing.

A session's environment may declare a **scope**: `SACCADE_TASK` (`t-N`),
`SACCADE_INCARNATION_SEQ` (a bare birth-record position - the machine
identity channel; the public `i-N` is the fold's dense numbering), and
`SACCADE_WORKSPACE` (an absolute path). Any one present declares a scope:
native participation can precede any task, so the task binding is
optional. The scope is
disclosure riding every record you write - never proof, never ownership.
It feeds exactly one gate: an agent whose declared scope covers a task
cannot **accept** that task's offer (`self_acceptance`). Humans are never
scope-gated.

An unpossessed write is guarded: with `SACCADE_ACTOR` unset, a mutation
with a terminal attached to any of stdin, stdout, or stderr proceeds on
one notice line (a named `--actor` passes silently), and the same
mutation with no terminal anywhere refuses (`identity_fallback`),
`--actor` notwithstanding - export `SACCADE_ACTOR=<name>`, as `--actor`
rides the terminal arm.

## The record is the reasoning cache

These are behaviors, not suggestions - every one exists because an agent
that skips it burns its reasoning on re-derivation or acts on guesses.

1. **Reason lightly, retrieve, then reason deeply - in that order.**
   Before any deep reasoning, frame what you would need to know, then read
   the context around it: the thread, `sac log`, the code the record names.
   Deep reasoning comes last and only on what retrieval didn't answer.
   Deep-first reasoning is the failure mode, not a style.
2. **Park conclusions at altitude** as they form (`sac comment t-N --title "..." "..."`) -
   parking is durability: an unparked conclusion dies with your context, a
   parked one survives reboot, handoff, and the next session. Park each
   conclusion when it forms, never batched at delivery - a crash between
   formation and park loses it. A cache entry is semantic content that
   survives rewording: the verdict, the why, the dead end, the deviation.
   What a maintainer would need to re-derive is a conclusion; code comments
   and commit messages are not the record. Narration of the next ten lines
   is not a conclusion; a write that cannot name its next reader doesn't
   earn bytes.
3. **Disagreement is a finding.** When the record, the skill, and the
   code disagree - with each other or with what you observe - stop and
   name the conflict on the thread and route it to your asker - the
   asker carries it to the skill's author. Never resolve it silently.
   Hidden staleness poisons the cache for every later reader.

## The model

Tasks are named undertakings: `open -> offered -> concluded`, with
`cancelled` as the human's stop. Ownership is separate from state - a
claim records whole-task responsibility (human, an incarnation, or
named external agent), transfers freely, and never gates anything; a
native incarnation is task-free, and a claim is never a scope change.

Work concludes through accounts and decisions, all of them comments:

- **Offer** - the whole-task closing account, born with its authored
  title (the concise whole-account description, `--title`). Moves
  `open -> offered`. Any tier may offer; offering is not owner-gated.
- **Accept** - names the offer (`c-N`), no prose. Moves `offered ->
  concluded`. Accept when the work is actually relied on, not when it
  is merely finished. An agent whose declared scope covers the task
  cannot accept its offer.
- **Reject** - names the offer with required grounds. Moves `offered ->
  open`, asking reconsideration; it does not establish wrongness. Any
  participant may reject, including the producer. To replace an
  account, reject it while it stands, then offer anew - there is no
  separate withdrawal door, and a second offer on an offered task
  refuses.
- **Use** - lives on the consuming task and declares a fixed source
  task with a reason; it names no offer at birth. `sac bind` selects
  the conclusion it rests on: the source task's current offered or
  concluded account, chosen with grounds. Rebinding is the same verb,
  earlier selections stay in the log, a replaced or accepted source
  never moves the selection, and a different source task is another
  use. Use creates no acceptance, and acceptance creates no use.
- **Note** - everything else that parks on a thread or replies to a
  record, born with its authored title (`--title`, required - never
  synthesized for you). A note may record a question or a finding; a
  request addressed to a peer is a message, not a note; native human
  conversation stays native. No separate request kind exists.

Older offers stay addressable; decisions naming a superseded offer
refuse (`not_current_offer`). A concluded task never reopens - later
faults belong in new tasks. Human cancellation of an unfinished task
requires an explanation; human reopening of a cancelled one does too.
`offered` is a normal persistent state, not a queue to clear.

Revision repairs presentation only: a note or an offer revises its
title and/or its body independently (`sac revise c-N --title "..."`,
or a body alone), and the other prose-carrying variants (grounds,
reason) their body - the fold presents the latest and names a
reviser; the bodyless accept refuses the door, no other kind takes a
title, references never change, and a substantive correction is a
new contribution citing the old one. For an offer account that
replacement is a reject and a fresh offer. Withdrawal is the note's
standing-error repair alone: the title and body leave the fold
together, a tombstone stays.

## Working a task

There is no runner in this build. You arrive at a task through whatever
launched you - a human, a coordinating agent - working in a workspace
the record names. The tracker's part of the loop:

1. **Retrieve first** (the protocol above): read your thread whole -
   the spec, prior verdicts, dead ends, parked working state - then the
   code and record it names.
2. **Claim if you own it** (`sac claim t-N`): whole-task
   responsibility, recorded on the ledger, transferring on the next
   claim. A task-scoped helper can contribute without claiming; a
   claim without an incarnation reference is a named external agent's
   claim. Launching never claims: launch transfers no
   ownership.
3. **Work and park** conclusions as comments as they form. Deviate
   openly: if the spec cannot be followed as written, say so on the
   thread with evidence.
4. **Offer** the whole-task account (`sac offer t-N --title "..." "..."`): outcome,
   evidence - what changed, which tests ran with counts, which
   commands were exercised, which files were touched, omissions and
   deviations. The offer is what a consumer reviews.
5. **The consumer decides.** A reviewer accepts (`sac accept c-N`) or
   rejects with grounds (`sac reject c-N --grounds "..."`); the producer
   may reject its own offer to reopen for a fix. Failure honestly
   reported is success.

Human judgment acts: cancellation (`sac cancel t-N --explanation "..."`)
and reopening (`sac reopen t-N --explanation "..."`).

## Commands

| Command | Who | Notes |
|---|---|---|
| `sac create task "name"` | any tier | the reply names what was born |
| `sac claim t-N` | any tier | ownership transfer; never a state change |
| `sac comment t-N --title "..." "..."` / `sac comment c-<n> --title "..." "..."` (`--ref` repeatable) | any tier | a note with its authored title, parked or replied; each `--ref` earns a `[^k]` citation marker |
| `sac send --to i-<n> [--reply m-<n>] [--task t-<n>] "body"` (`--stdin`) | a registered incarnation | durable addressed communication: the sender rides the environment, delivery is the recipient's integration's act; never a comment, never a thread entry |
| `sac messages [i-<n>]` | anonymous | the messages an incarnation participates in, in record order, with their delivery state (pending/submitted - bookkeeping, never a reading or agreement claim); the mailbox defaults to the declared scope |
| `sac offer t-N --title "..." "..."` | any tier | the whole-task closing account with its authored title |
| `sac accept c-<offer>` | any tier | conclude through the standing offer |
| `sac reject c-<offer> --grounds "..."` | any tier | reconsideration with grounds; reopens the task |
| `sac use t-<consumer> --source t-<source> --reason "..."` | any tier | prospective reliance: the consuming task declares its fixed source task, born unbound |
| `sac bind c-<use> c-<offer> --grounds "..."` | any tier | bind or rebind the use's selection: the source task's current offered or concluded account; earlier selections stay in the log |
| `sac cancel t-N --explanation "..."` | **human only** | stop an unfinished undertaking |
| `sac reopen t-N --explanation "..."` | **human only** | resume a cancelled undertaking |
| `sac revise c-<n> [--title "..."] ["..."]` (prose also by `--stdin` or `--body-file`; at least one field) | any tier | presentation repair: a note or offer's title and/or body, the other variants' body; the fold names a reviser, `sac log` keeps the original |
| `sac withdraw c-<n> --note "..."` | any tier | the note's standing-error repair: title and body out, tombstone stays |
| `sac artifact t-N <path> [--name ...]` | any tier | park an artifact on the thread - the client hashes the file into the store at state_dir/artifacts/<sha256> and the wire carries {name, hash} only |
| `sac wait t-N\|c-N --after <seq> --until offer\|activity` | anonymous | block until a match lands: structurally matching activity, or an Offer born on the task - either way strictly after the cursor; nothing is recorded |
| `sac launch --workspace <dir> [-- prompt]` / `--new [label] [--base <ref>]` | any tier | launch the composed native Pi task-free: `--workspace` selects an explicit existing directory; `--new` provisions a fresh workspace through the server's Git effects and launches there; a fresh session registers itself as a new incarnation at start; `--resume i-<n>` continues a saved native session from its recorded locator, validated against the saved header. No task, claim, or request is provisioned |
| `sac workspace new [label] [--base <ref>]` | any tier | provision a NEW task-free workspace through the server's Git effects: the label plus a generated uniqueness suffix (workspace-<token> without a label), cut at the named base or the primary HEAD. The birth record's position is the workspace's identity - no task, claim, or incarnation, and no new numbering |
| `sac workspace switch i-<n> --to <dir> [--resume -- prompt]` | any tier | move a STOPPED native session's saved working directory to an explicit existing one: a held guard refuses (exit the session first) and an unprobeable one refuses as unknown, both before anything moves; the target must already exist; the saved header is retargeted atomically (same native id, body, and history), and the change record lands only after the header actually moved - it asserts the confirmed change, never a running process. `--resume` then continues the same native id there through the ordinary resume door |
| `sac launch --workspace <dir> --ask "question"` | a registered incarnation | cheap peer creation with an initial question: launches the peer, and once it registers the question goes to it as a durable addressed message from your own scope - the newborn's address is your reply surface. Requires SACCADE_INCARNATION_SEQ; never argv-shaped human input, never a task or ownership |
| `sac identity` | anonymous | report the environment-declared actor/tier, scope, and routing - disclosure, never a liveness claim |
| `sac list` / `sac show <ids...>` / `sac log` | anonymous | the board, threads and records, raw events |
| `sac search <terms...> [in:t-N by:NAME kind:K] [-C N]` | anonymous | exact terms over titles, comment prose, explanations; kinds: task, note, offer, accept, reject, use, artifact, explanation |
| `sac serve [--bind] [--port]` | - | the sole-writer HTTP server and console |
| `sac clone --at <seq> --out <path>` | anonymous | copy the log's prefix into a fresh tracker |
| `sac skill install` / `sac skill check` | any tier | deploy this binary's copy of this skill into ./.agents/skills/saccade, or verify the copy against it; a differing copy refuses until deleted |

Not in this build (later slices, do not assume them): managed
completion obligations, proposal machinery of any kind. Launching is
the host's:
`sac launch` asks the host (Orca) for one terminal and never
supervises it - restarting Saccade leaves native sessions alone.

## Prose

Comment prose is CommonMark - tables and math included - and the
console renders them, math and code click-to-copy. Write LaTeX for
math, never unicode approximations. Dollars are the only math
delimiters, and they are exact:

- inline: `$x^2+1$`, `$\mathcal{L}[f]$` - one dollar each side
- display: `$$\frac{a}{b}$$` - two dollars each side

`\(...\)` and `\[...\]` are not the door - they stay literal
backslashes. A formula the renderer cannot parse keeps its source bytes.

## Searching

`sac search` finds records by exact terms over the folded text fields -
task titles, note and offer titles, comment prose, cancellation
explanations, and artifact names. No ranking, no fuzzy: a term matches as a whole, word-bounded,
case-folded, or it doesn't. Results are thread-grouped pointers with
one matched line each, in record order.

- **Find where something was decided**: `sac search telemetry`.
- **Follow a reference**: an id term is a reference search - `c-907`
  finds every record citing that comment, `t-49` everything naming
  that task.
- **Narrow**: `in:` `by:` `kind:` - only-show-me filters;
  every narrowing prints visible counts. `sac search --help` owns the
  grammar.
- **Read the neighborhood**: `sac search c-907 -C 3`.
- **Read whole records**: bare seqs show the raw event at that
  position, `c-N` the comment as it folds, `t-N` the task plus
  thread. The pipe reads end to end.

Pointers stay pointers. The power tail is unchanged: `sac log | grep`
reads the raw record.

## Waiting

`sac wait t-N|c-N --after <seq> --until offer|activity` blocks until
a match lands. Both flags are required: the cursor is never
defaulted, the mode never chosen for you. In activity mode a task
wait matches every record folding into the task; a comment wait
matches its reply chain - replies at any depth, revisions and
withdrawals of chain members, and decisions targeting it. Unrelated
activity elsewhere on the task and prose-only citations never match.
Any matching activity wakes, partial replies included; the result
never claims the offer is accepted or the task complete - you
interpret it and may wait again.

In offer mode only an Offer born on the target task strictly after
the cursor wakes the wait: every offer birth qualifies - the one
standing, one already rejected, one long concluded - and no later
decision filters an earlier birth. A revision of an offer is not a
new birth, and notes, use, decisions, and cancellation
never match. Offer mode addresses a task (t-<n>) only: `--until
offer` on a comment target refuses.

The cursor is a global record position you supply, never defaulted:
matches are strictly after it. Every read discloses the snapshot's
cursor - `cursor` on the `--json` faces, a trailing `cursor <seq>`
line on text; read, ask, wait, in that order, and records that land
between the steps are caught, because committed records are checked
before any blocking.
The reply lists matched records in record order and the cursor of the
snapshot inspected through, for the next wait. A wait records nothing
and holds nothing: it is a read the caller owns, not a registration
the tracker keeps; ordinary interruption ends it.

Delivery facts for messages are small and ordinary: a message reads
`pending` until the recipient's integration hands it to its native
session, then `submitted` - never a claim of reading, agreement,
completion, or task acceptance. A sent message activates its recipient
at supported boundaries: a running peer's delivery bridge parks on the
tracker and delivers into the live queue, or starts a turn when the
session is idle; while it waits, the wait releases; a peer that is not
running has its exact saved session's resume launched by the next
send from any face (submission, not reattachment - the mail stays
pending until the resumed session registers and drains), and every
doubt about liveness leaves the mail pending - a transient disconnect
never spawns a duplicate into a running session, and simultaneous
senders serialize per native session. Submission confirms
from the saved session history at later boundaries. The mailbox read is
`sac messages`.

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

A workspace can be born task-free: `sac workspace new` provisions
through the server's own Git effects - the optional label plus a
generated uniqueness suffix, `workspace-<token>` without one - cut at
the named base or the primary HEAD, and lands a creation birth whose
record position is the identity: no task, no claim, no incarnation,
and no new human-facing number. The birth carries what the effect
actually established: the canonical base commit, the branch, and the
worktree's absolute path - beside the tracker's db, under `worktrees/`.
Several sessions may select one workspace; selecting an existing
directory (`sac launch --workspace`) provisions nothing.

`sac launch` submits the composed native Pi into one host terminal at
the chosen workspace, task-free: a fresh session registers itself as a
new incarnation when it attaches, and `--resume i-<n>` continues a
saved one from its recorded locator, validated against the saved
header. No task, claim, or request is provisioned.

The log may also name task-bound workspaces: a historical
establishment record carries the task reference, the canonical base
commit, the branch (`saccade/t-<n>`), and the worktree's absolute
path. That record's position births a **historical attribution
identity**, referenced `i-N`: claims carry it, and it holds no native
session - a real session's identity is the registration born when the
composed Pi attaches (`SACCADE_INCARNATION_SEQ` carries it). These
establishments, their checkpoints, and their attribution read and fold
exactly as always; the commands that established, reopened, executed
into, checkpointed, or tore such workspaces down are retired. The
record governs; the workspace is a cache.

A native session's saved working directory moves by explicit change:
`sac workspace switch i-<n> --to <dir>` resolves the recorded
incarnation, requires the session's launch guard to be free (kernel
evidence it is not owned by a live process; unknown refuses),
validates the exact saved association and the existing target, then
retargets the saved header atomically and lands the change record only
after the header actually moved. The fact stays true if a later launch
fails; nothing is inferred, nothing is stopped, and no process list is
consulted.

## Errors and degraded mode

Failures exit 1 with a named variant on stderr (`--json` emits
`{"error": "<variant>", "detail": "..."}`). If resolving an error
requires violating any law of this skill, that is a finding - name it
on the thread before proceeding.

The variant table and degraded mode live in `errors.md` beside this
skill - read it when a command names a variant. When the tracker
misbehaves or a refusal needs reproducing, `diagnosing.md` reconstructs
the conditions from the attempts log.

## Semantics worth knowing

- Task states: `open -> offered -> concluded`; `cancelled` is the
  human's stop with a recorded explanation, reopenable only by a human
  with another explanation. Concluded is final - later faults open new
  tasks.
- Ownership is the ledger on the task's context: every claim appends
  (who, when, which record), the last entry is the current owner, and
  no state gates a claim.
- The offer that stands is the task's *current offer*: decisions name
  it by id, stale decisions refuse, and a reject clears it so a new
  offer can stand.
- Artifacts are pointers, never payloads - the record holds name+hash,
  the bytes live content-addressed under the state root, an artifact
  renders at its home position (CLI pointer line, console inline image
  via `/a/<hash>`), and the store write precedes the record so a crash
  orphans content, never points at absence.
- Each repo has one tracker; its state root derives from the repo
  path, never from your working directory - `--repo` or `SACCADE_REPO`
  names the project when working from elsewhere. One destination per
  command: `--db` selects local operations on that file, `--server`
  selects a running server for reads, writes, and waits alike, and
  both flags refuse together. With neither, the repo's usual database
  is resolved and its server is discovered from the address hint
  beside that database (`<db>.addr`, published by `sac serve` after it
  binds) and verified to serve exactly that file - missing,
  unreachable, or mismatched refuses; there is no default localhost
  and no fallback to local writes. Scratch work names its own
  destination explicitly: `sac serve --port 0 --db /tmp/scratch/x.db`
  for the server, `--db` or `--server` for every client command.
