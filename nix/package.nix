{
  lib,
  writeShellApplication,
  pi,
  extraExtensions ? [],
}: let
  extensions = [
    ../extensions/websearch.ts
    ../extensions/bash-background.ts
  ] ++ extraExtensions;
in
  writeShellApplication {
    name = "wrapped-pi";
    text = ''
      exec ${lib.getExe pi} ${lib.escapeShellArgs (lib.concatMap (path: ["-e" (toString path)]) extensions)} "$@"
    '';
  }
