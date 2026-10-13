# wrapped-pi

Pinned native Pi with bundled [web search](extensions/websearch.md) and
[background bash execution](extensions/bash-background.md).

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
```

The SDK stub loader is specific to the bash suite; do not apply it to websearch.
