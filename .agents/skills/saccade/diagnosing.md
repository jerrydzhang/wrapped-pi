# Diagnosing

Read this when the tracker misbehaves or a refusal needs reproducing.

When the tracker misbehaves, the attempts log reconstructs the
conditions: `attempts.jsonl` beside the tracker in the state root, one
line per request the server judges. Every line carries ts, actor, client
and server binary versions, duration.

- **Refused lines are fat** — code, the storage-seq cursor the request
  died against, the full request as received (a refusal enters no
  journal; the line is the only place its shape survives). **Landed
  lines are thin** — the seqs the request became, never the payload:
  the journal already holds it.
- **Reproduce a refusal**: take the logged line, `sac clone --at
  <cursor> --out <path>`, serve the clone (`--db` names it),
  re-post the logged request — the same code fires. `clone` refuses an
  existing out and cursors beyond the log.
- **One grep surface**: serve's warns (WARN and worse) tee into the same
  file.
- **Version skew names itself**: both binaries are on every line; a
  malformed_request from a working client is a pair mismatch, not
  corruption.
- **Storage seq is not the record id**: `events.seq` is the storage
  cursor; `c-N` record ids are fold positions — two series, never
  interchangeable.
- **Door-level refusals write no line** (cross-site, nameless forms,
  unknown routes): no code vocabulary exists for them; none is invented.
- **Bootstrap**: reads on a missing db refuse ("any mutating command
  creates one"); the first mutating verb initializes it.
