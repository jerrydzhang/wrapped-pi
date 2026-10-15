{
  description = "Pinned Pi with bundled web search and background execution";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    pi.url = "github:earendil-works/pi";
    saccade.url = "github:jerrydzhang/saccade";
    devenv.url = "github:cachix/devenv";
  };

  nixConfig = {
    extra-substituters = ["https://devenv.cachix.org"];
    extra-trusted-public-keys = ["devenv.cachix.org-1:w1cLUi8dv3hnoSPGAuibQv+f9TZLr6cv/Hm9XgU50cw="];
  };

  outputs = {
    self,
    nixpkgs,
    pi,
    saccade,
    devenv,
    ...
  } @ inputs: let
    forAllSystems = nixpkgs.lib.genAttrs nixpkgs.lib.systems.flakeExposed;
  in {
    packages = forAllSystems (system: let
      pkgs = nixpkgs.legacyPackages.${system};
    in {
      default = pkgs.callPackage ./nix/package.nix {
        pi = pi.packages.${system}.pi;
        poppler = pkgs."poppler-utils";
      };
    });

    checks = forAllSystems (system: let
      pkgs = nixpkgs.legacyPackages.${system};
    in {
      extensions = pkgs.runCommand "wrapped-pi-extension-tests" {
        nativeBuildInputs = [pkgs.nodejs pkgs."poppler-utils"];
      } ''
        cp -R ${./extensions} extensions
        chmod -R u+w extensions
        node --test extensions/websearch.test.ts
        node --import ./extensions/tests/register.mjs --test extensions/tests/bash-background.test.ts
        node --import ./extensions/tests/register.mjs --test extensions/tests/subagent.test.ts
        node --test extensions/tests/pdf-read.test.ts
        node --test extensions/tests/pdf-read.poppler.test.ts
        touch "$out"
      '';
    });

    devShells = forAllSystems (system: let
      pkgs = nixpkgs.legacyPackages.${system};
    in {
      default = devenv.lib.mkShell {
        inherit inputs pkgs;
        modules = [
          ({config, ...}: {
            # pure evaluation (nix flake check) has no PWD for devenv's
            # default root inference; fall back to the flake source so the
            # shell still evaluates
            devenv.root =
              if builtins.getEnv "PWD" != ""
              then builtins.getEnv "PWD"
              else toString ./.;
            packages = [
              pkgs.nodejs
              pkgs."poppler-utils"
              saccade.packages.${system}.default
            ];

            # sac start submits the current working-tree wrapped-pi
            # instead of the pin baked into the saccade binary
            env.SACCADE_PI = "${self.packages.${system}.default}/bin/wrapped-pi";
            # pin this shell's clients to our own tracker server
            env.SACCADE_SERVER = "http://127.0.0.1:8815";

            process.manager.implementation = "native";
            processes.sac = {
              exec = "${saccade.packages.${system}.default}/bin/sac serve --repo ${config.devenv.root} --bind 0.0.0.0 --port 8815";
              restart = {
                on = "on_failure";
                max = 10;
              };
              ready.http.get = {
                port = 8815;
                path = "/";
              };
            };
          })
        ];
      };
    });
  };
}
