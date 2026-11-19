# airstring S2 report — structured window shim + G1 full-run byte gate

## Gate verdict: PASS

G1 (seed 42 + smoke-01 key stream, 97 bytes) run headless in Node
through the S2 shim, in **both** feed modes:

| mode | frames | rnglog | vs golden |
|---|---|---|---|
| replay (`FLECK_REPLAY`, native path) | 475,696 B / 93 frames | 123,627 B / 6,850 lines | `cmp` identical |
| queue (JS key queue → shim funnel) | 475,696 B / 93 frames | 123,627 B / 6,850 lines | `cmp` identical |

sha256 (both modes, both files):
frames `09c48b071a835162e4cd0f3216594c30fc343bc5bcf8136ade13dbd1e186b0f4`,
rng `845c33acf93207230470115a729f84a18449960b5e5df32358f859dba526b4fb`
— equal to the golden files and to the recorded G1 golden hashes.
The two modes' contract event streams (217 events) are also
identical except the `src` label on `key` events (`replay` vs
`queue`). Queue mode consumed all 97 keys through the JS queue.

Build: `./build-wasm.sh` end-to-end, exit 0.
`out/nethack.wasm` 3,910,475 B, sha256
`e9406438090a10b54070fe7a9f697b311ee0c63e6d720336733e07a8561cd64e`;
`out/nethack.js` 180,656 B.

## rnglog line 2537 divergence (S1 leftover): CLOSED

Under the canonical smoke-01 stream the wasm rnglog now matches
the golden for **all 6,850 lines**, line 2537 included. The S1
divergence was an artefact of S1's spike setup — a different key
stream (`name:s1spike`, stub-fed keys) legitimately walks a
different rng path — not a platform difference. No code was
changed to make it go away; it disappears by running the same
stream the golden was recorded with.

## The bug the gate caught (and the fix)

First S2 run: frames file missing entirely, rnglog an exact
2,423-line prefix of the golden, then "replay exhausted". Root
cause, pinned by an instrumented build (debug prints in fleck.c,
**reverted afterwards — `src/fleck.c` is byte-identical to the
repo copy**) plus the shim's per-key audit events:

- The tty port puts the terminal into cbreak mode at startup
  (`setftty()`, sys/share/unixtty.c: `iflags.cbreak = ON`,
  `iflags.echo = OFF`). The stub port never establishes that
  state, so `iflags.cbreak` was 0.
- `xwaitforspace()` (win/tty/getline.c, ported faithfully) only
  accepts its dismissal characters (space/return/ESC) **when
  cbreak is set**; otherwise it consumes keys until a newline.
  The first `--More--` (for the com_pager error pline) therefore
  swallowed `   edyes` up to the stream's only `\n`; the second
  (triggered by the moveloop-prolog "Be careful!" pline)
  swallowed keys 10–97 to EOF, exiting the game from the moveloop
  prolog — before `rndencode = rnd(9000)` (golden line 2424) and
  before `fleck_export_initial()`, which is also why no frames
  file existed.
- Fix (in `shim_init_nhwindows`, next to the existing
  erase/kill pinning): `iflags.cbreak = TRUE; iflags.echo = FALSE;`
  — completing the terminal-mode setup the tty port performs,
  not a workaround. After the fix, native and shim consume the
  three startup dismissal keys identically (pager/more
  accounting: 3 keys before the first command key in both) and
  the full run is byte-identical.

## Side item 1: `com_pager: message 1 not found` — root cause located

Confirmed present in wasm runs (paniclog: `impossible com_pager:
message 1 not found.`), absent natively. Byte-level proof:

- `quest.dat` (in nhdat) is written by native `makedefs`
  (`do_questtxt`) in **LP64 layout**: header of `long qt_offsets[]`
  (8 B each) and `struct qtmsg` records of 32 B
  (`{int; char; long offset, size, summary_size}`).
- The wasm reader (`src/questpgr.c`) is ILP32: it reads 4 B longs
  and 20 B records → the offset table and message table are
  garbage from the second entry on, so `msg_in()` finds nothing.
- Verified by parsing `oracle/dat/quest.dat` (119,478 B) both
  ways in Python: LP64 parse is perfect (14 classes, first class
  has 55 messages numbered 1,2,3,5,6,…); ILP32 parse produces
  interleaved zeros and nonsense msgnums (1,0,24397,0,90,…).
- Same family as the S1 `version_info` fix. Suggested fix (not
  applied — mainline to schedule): under `CROSS_TO_WASM`, give
  the quest.dat on-disk fields fixed-width types in
  `include/qtext.h`, `src/questpgr.c` and `util/makedefs.c`.
  This build compiles makedefs with the same hints, so both
  sides switch together; the native fleck oracle build does not
  define the macro and is unaffected.
- Gate impact: none for G1 — the failure path (2 error plines +
  their `--More--` dismissals) consumes exactly as many keys at
  exactly the pre-command point as the native success path
  (pager window dismissal + mores), proven by the byte-identical
  full run. This alignment is stream-dependent luck, however;
  the fix is still needed before real play (S3/S4 data-format
  pass), because quest text is also gameplay content.

## Side item 2: getpwuid/getlogin audit — complete

Call sites compiled into the wasm build: only `src/mail.c` and
`sys/unix/unixmain.c` (other `getuid()` uses never dereference a
passwd entry).

- **`src/mail.c:112` is the only live hazard**: in the non-AMS
  MAILPATH branch, `getpwuid(getuid())->pw_name` is dereferenced
  without a NULL check; Emscripten's `getpwuid()` returns NULL
  (no /etc/passwd) → the S1 crash. Current mitigation kept:
  pre-s2.js injects a dummy `MAIL` path so the branch is not
  taken. (mail.c:103's `memcpy(&ppasswd, getpwuid(...))` variant
  is inside `#ifdef AMS` and is not compiled in this build.)
- `unixmain.c` is clean: `getlogin()` results (lines 559, 707)
  are NULL-checked before use; `get_unix_pw()` checks
  `getpwnam`/`getpwuid` results and validates the uid;
  `get_login_name()` checks `if (pw)` before copying `pw_name`
  (re-verified for this report).
- Recommendation: leave the source as is, keep the `MAIL`
  mitigation; if mainline prefers a source fix, a NULL check at
  mail.c:112 is a one-line upstream-style change.

## Stretch item: G2 (seed 37 + slice-17) — partial, divergence located

Replay mode. Output is an **exact byte prefix** of the golden
for both files, up to:

- frames: frame **286** complete (287 frames exported;
  1,534,138 of 25,586,024 bytes)
- rnglog: line **16,906** of 205,683

Then, descending Dlvl 5 → 6 (moves 326 → 327) into the special
level placed at Dlvl:6 for seed 37, the game panics:
`sp_level_loader: impossible opcode -1.` followed by the dungeon
collapse banner, and exits (7,278 keys consumed).

Root-cause class located (beyond the ask; same disease as
quest.dat): the `.lev` binary format contains host-width `long`
fields. The first is `sp_lev.n_opcodes` (`include/sp_lev.h:447`,
`long n_opcodes`): native `lev_comp` writes it as 8 bytes, the
wasm loader reads 4 → the opcode stream is misaligned
immediately after the version header (which passes, thanks to
the S1 CROSS_TO_WASM pinning). `spo_variant.vardata.l` has the
same problem downstream. Suggested fix is the identical pattern:
fixed-width on-disk types under `CROSS_TO_WASM` in
`include/sp_lev.h`, `src/sp_lev.c`, `util/lev_comp` writer.
Not fixed in S2 (out of scope); proposed for the S3/S4
data-format pass together with quest.dat.

## Changed files (repo-relative; copy over the repo to merge)

- `oracle/win/stub/winstub.c` — **rewritten** (419 → 2,745
  lines). Full tty-semantics window port: EM_JS event bridge,
  single input funnel (replay-first, JS queue second, EOF =
  clean exit), topline/`--More--` machine, menu paging and
  selection, text windows, yn/getlin/extcmd prompts, map glyph
  grid snapshots, status field publication, terminal-mode
  pinning (80×24, erase/kill, cbreak/echo — see above).
- `oracle/sys/unix/hints/linux-wasm-s1` — one line: the pre-js
  path now points at `../../tools/pre-s2.js`.
  **Discrepancy to note:** as committed, line 39 pointed at
  `../../pre-spike.js`, but in the repo `pre-spike.js` lives
  under `tools/` — the committed hints path does not resolve
  inside the repo layout; S2 builds with the corrected path.
  Mainline should check how S1's build resolved it before
  merging.
- `tools/pre-s2.js` — **new**. preRun injection of run
  parameters (seed/date/options/export/rng paths, `MAIL`
  mitigation, replay file placement) + the JS side of the key
  queue.
- `tools/run-node-s2.mjs` — **new**. Headless harness:
  `--keys/--mode replay|queue/--seed/--date/--options/--out/
  --events/--quiet-keys`; reads frames/rng back from MEMFS.
- `docs/window-contract.md` — **new** (this workspace's `docs/`
  maps to the repo's `docs/`). The JS↔shim contract: transport,
  80×24 geometry, event catalogue, prompt kinds, the single
  input funnel and its EOF semantics, pinned terminal state,
  registered gaps.

Unchanged: `build-wasm.sh` (byte-identical), all oracle sources
other than winstub.c (verified by tree diff; `include/date.h`
differs only by its build timestamp, a generated file; the
fleck.c instrumentation used during diagnosis was fully
reverted).

## Runs kept in this workspace

`runs/g1-replay.{frames,rng,events.jsonl}`,
`runs/g1-queue.{frames,rng,events.jsonl}` (gate evidence),
`runs/g2-replay.{frames,rng,events.jsonl}` (stretch evidence),
build logs `build-s2.log`, `build-dbg.log`, `build-s2b.log`.
