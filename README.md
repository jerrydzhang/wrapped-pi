# wrapped-pi

Pinned native Pi with bundled [web search](extensions/websearch.md),
[background jobs](extensions/bash-background.md) (detached commands and
subagents with a shared wait/stop lifecycle), and
[PDF-capable read](extensions/pdf-read.md) (Poppler from the package
closure; non-PDF reads unchanged).

## Run

```sh
nix run .
nix run . -- --help
```

No separate Pi installation is required. Nix supplies Pi and the extension
sources in the executable's runtime closure. The wrapper installs nothing into
`~/.pi`; plain and wrapped Pi share the existing auth, model configuration,
preferences, and sessions. Normal user/project extension discovery remains
active, subject to Pi's usual project trust rules.

To use the bundled `subagent` tool, set `WRAPPED_PI_SUBAGENT_MODEL` to a model
pattern (anything `pi --model` accepts) in the environment where you launch
the wrapper; without it the tool refuses rather than silently falling back to
the session model. The wrapper exports `WRAPPED_PI_EXTENSIONS` (its pinned
`-e` list) so subagent children load the bundled set, `extraExtensions`
included. See [the extension's documentation](extensions/bash-background.md)
for the full contract.

If these extensions were previously installed globally, remove those managed
copies explicitly before adopting the wrapper to avoid duplicate loading.
Unrelated extensions remain yours to manage. Shipped components are pinned;
the complete runtime environment is intentionally not hermetic.

## Consumer composition

Add this flake as an input, then use its default package. Consumer-owned
integration extensions can be added without changing the bundled set:

```nix
wrapped-pi.packages.${system}.default.override {
  extraExtensions = [./extensions/my-integration.ts];
}
```

The executable is `bin/wrapped-pi`; arguments are forwarded to native Pi.
Extension paths belong in the Nix store for release packaging. Mutable
working-tree paths are a development-shell concern, not a release input.

## Tests

```sh
nix flake check
node --test extensions/websearch.test.ts
node --import ./extensions/tests/register.mjs --test extensions/tests/bash-background.test.ts
node --import ./extensions/tests/register.mjs --test extensions/tests/subagent.test.ts
node --test extensions/tests/pdf-read.test.ts
node --test extensions/tests/pdf-read.poppler.test.ts   # real Poppler; skips without it
```

The SDK stub loader is specific to the bash suite; do not apply it to websearch.
