# AGENTS.md — how agents work in this repo

wrapped-pi is infrastructure: a pinned native Pi plus a deliberately small
curated set of extensions, consumed as a flake input — saccade's devShell
execs it as its pinned harness. The consumer surface (the `extraExtensions`
override, `bin/wrapped-pi` argument forwarding, store-pinned extension
paths) is a stability commitment: interface changes are expensive downstream
even when this repo's tests pass. Ratified decisions live in tracker
threads; standing law lives here; CLI discipline lives in
`.agents/skills/`.

## Ownership

The human owns the bundled set's curation and the consumer surface. Agents
own implementation of work a task names: extension code, tests, docs,
packaging mechanics.

## Standing law

- Release builds resolve extension paths from the Nix store; mutable
  working-tree paths are a dev-shell concern.
- The wrapper installs nothing into `~/.pi`. Pi here shares real auth, model
  configuration, and session history — anything that starts pi touches the
  user's environment.
- Pi runs with real credentials: never print, copy, or move auth material;
  never run `pi auth` from repo work.
- Each `extensions/*.md` is user-facing documentation and moves with the
  code it describes.
- Pin bumps (`nix flake update`, input edits) may be agent-authored but are
  always explicit: a flake.lock change is named in the offer, never buried
  in unrelated work.

## Commands

```sh
nix flake check
node --test extensions/websearch.test.ts
node --import ./extensions/tests/register.mjs --test extensions/tests/bash-background.test.ts
node --test extensions/tests/pdf-read.test.ts
node --test extensions/tests/pdf-read.poppler.test.ts   # real Poppler; skips without it
```

The SDK stub loader belongs to the bash suite only; never apply it to
websearch. The tracker serves via `devenv up sac` on port 8815 (8811–8814
are taken by sibling repos).

## Trip-wires (look wrong, are right)

- Non-hermeticity is intentional — do not fix it.
- The dev env enters through direnv or `nix develop --impure`; plain
  `nix develop` fails at devenv's root inference, because pure evaluation
  has no PWD. Known behavior, not a bug to solve.

## Verification

Node tests with stubs prove logic only. Changes touching rendering, tool
registration, or session behavior must also be verified in a live pi
session driven through the `orca-terminals` skill — launch
`pi --no-session -e ./extensions/<file>.ts`, drive it, read `--screen`,
and report what was observed. Stub tests green is not done for UI-facing
changes.

## Working under saccade

Retrieve before reasoning; park conclusions on the task thread as they
form, not batched at delivery; offer with evidence — diff summary, tests
run with counts, live-session observations. Never accept your own offer:
acceptance is the user's. Worktree lifecycle belongs to `sac start`,
`sac open`, and `sac clean` — never `orca worktree create` or
`worktree rm` for task work.
