{
  lib,
  writeShellApplication,
  pi,
  poppler,
  extraExtensions ? [],
}: let
  extensions = [
    ../extensions/websearch.ts
    ../extensions/bash-background.ts
    ../extensions/pdf-read.ts
  ] ++ extraExtensions;
in
  writeShellApplication {
    name = "wrapped-pi";
    text = ''
      # pdf-read resolves poppler executables from here; the store path pins
      # the release build, so host PATH is never consulted for poppler.
      # getBin yields the output root; the executables sit under bin/.
      export WRAPPED_PI_POPPLER_BIN="${lib.getBin poppler}/bin"
      exec ${lib.getExe pi} ${lib.escapeShellArgs (lib.concatMap (path: ["-e" (toString path)]) extensions)} "$@"
    '';
  }
