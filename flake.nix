{
  description = "Pinned Pi with bundled web search and background execution";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    llm-agents.url = "github:numtide/llm-agents.nix";
  };

  outputs = {nixpkgs, llm-agents, ...}: let
    forAllSystems = nixpkgs.lib.genAttrs nixpkgs.lib.systems.flakeExposed;
  in {
    packages = forAllSystems (system: let
      pkgs = nixpkgs.legacyPackages.${system};
    in {
      default = pkgs.callPackage ./nix/package.nix {
        pi = llm-agents.packages.${system}.pi;
      };
    });

    checks = forAllSystems (system: let
      pkgs = nixpkgs.legacyPackages.${system};
    in {
      extensions = pkgs.runCommand "wrapped-pi-extension-tests" {
        nativeBuildInputs = [pkgs.nodejs];
      } ''
        cp -R ${./extensions} extensions
        chmod -R u+w extensions
        node --test extensions/websearch.test.ts
        node --import ./extensions/tests/register.mjs --test extensions/tests/bash-background.test.ts
        touch "$out"
      '';
    });

    devShells = forAllSystems (system: let
      pkgs = nixpkgs.legacyPackages.${system};
    in {
      default = pkgs.mkShellNoCC {
        packages = [pkgs.nodejs];
      };
    });
  };
}
