# airstring window contract (S2 draft)

The contract between the WASM NetHack build (window port
`oracle/win/stub/winstub.c`, "the shim") and its JavaScript host
(browser page, Node harness, verifier). The shim is a faithful port
of the tty window port's *interaction semantics* (key consumption,
message stacking, `--More--` timing, menu paging) with rendering
replaced by a structured event stream. Frame export (fleck
instrumentation) reads game-internal state directly and is **not**
part of this contract.

## Transport

- C → JS: `__airstring_event(json)` — one JSON object per event,
  delivered synchronously, in emission order. In Emscripten this is
  an `EM_JS` bridge; the host assigns
  `globalThis.__airstring_event` before instantiating the module.
- JS → C: `__airstring_next_key()` — returns the next input byte
  (0–255) or `-1` when the queue is empty (see "Input" below).
- Run parameters are injected in a `preRun` callback via
  `globalThis.__airstring_config`:
  `{ seed, date, options, exportPath, rngPath, mode, keysBase64 }`.
  They become the environment variables `FLECK_SEED`, `FLECK_DATE`,
  `FLECK_EXPORT`, `FLECK_RNGLOG`, `NETHACKOPTIONS`, `MAIL` (dummy
  spool path; see report §getpwuid audit) and, in replay mode,
  `FLECK_REPLAY`. Emscripten 6.0 neither reads `process.env` nor
  honours a factory-passed `ENV`; `preRun` is the only working
  injection point (proven in S1).

## Geometry

The virtual terminal is pinned at **80×24** (cols×rows). Message
wrapping, `--More--` placement and menu paging
(`lmax = min(52, rows-1) = 23` lines per page) all derive from it,
matching the pty geometry of the native golden runs.

## Events

Every event is a JSON object with a `t` field.

| event | fields | meaning |
|---|---|---|
| `init` | `rows`, `cols`, `port` | window system up; always the first game event |
| `map` | `rows`: 21 strings of 80 chars, `colors`: 21×80 ints | full map snapshot (glyph grid rendered to chars + color codes), emitted when the game displays the map window |
| `status` | `fields`: {name: string} | status fields as last set by the core's generic status updater; only active, non-empty fields are included |
| `message` | `text` | one logical top-line message (pline). Stacking/`--More--` behaviour follows the tty topline machine |
| `more` | — | a `--More--` prompt is now waiting; the next key event is its dismissal |
| `prompt` | `kind`, `q`, plus per-kind fields | the game is asking a question; see prompt kinds below |
| `prompt-end` | `kind`, plus the answer (`ans` for yn, `text` for line) | the question has been answered |
| `menu` | `win`, `how` (PICK_NONE/ONE/ANY), `page`, `pages`, `items`: [{selector, text, glyph, count, selected}] | one page of a menu window being displayed |
| `menu-end` | `win`, `n` (selection count), `cancelled` | menu closed; selections themselves travel through the core, this is a UI sync marker |
| `text` | `win`, `lines`: [string] | a text window (help, intro, end-of-game text) being displayed; dismissal consumes one key, as in tty (`dmore`) |
| `raw` | `text` | raw_print output (startup warnings, panic banners) |
| `bell` | — | the game rang the bell (invalid key at a prompt, etc.) |
| `key` | `n` (1-based ordinal), `code`, `ch`, `src` (`replay`/`queue`) | audit event: one byte consumed by the input funnel |
| `getret` | — | "press return" wait after raw output (tty `getret`) |
| `askname` | — | the game is asking for the player name via getlin (only when the name is not pinned by options) |
| `rip` | — | tombstone screen shown (fields to be structured in S5) |
| `exit` | — | window system shut down; no further events |

### Prompt kinds

`prompt.kind` enumerates what the game is waiting for:

- `yn` — a yes/no-style question answered by a single key.
  Fields: `q` (question text), `choices` (string of acceptable
  answer chars, or `null` when the core accepts any key as in
  object-selection prompts such as "What do you want to eat?"),
  `def` (default answer char or `null`).
- `line` — a free-text line (getlin): name prompts, wish, engrave
  text, `#call`, etc. Field: `q`. Terminated by `\n`; editing keys
  follow the tty line editor (erase char = DEL, kill char = ^U,
  pinned to the golden pty's line discipline).
- Menus and direction/position queries do not use `prompt`: menus
  use `menu`/`menu-end`, and `nh_poskey` answers are plain `key`
  consumptions in the main command flow. The host distinguishes
  "main command" vs "direction" vs "position pick" from game state
  (last command issued), not from a separate event; S5 may add a
  `kind:"poskey"` marker if the UI needs it.

## Input: the single funnel

All input paths — main command keys (`nhgetch`), `nh_poskey`,
yn questions, getlin, menu selection, `--More--` dismissal,
text-window dismissal, `getret` — converge on one funnel inside
the shim (`shim_nhgetch`), which is also where the `key` audit
event is emitted. There is exactly one place where bytes enter
the game.

The funnel has two sources, in priority order:

1. **Replay**: if `FLECK_REPLAY` is set, bytes come from the
   fleck replay file inside the game (`fleck_replay_getch`), the
   identical code path the native oracle uses.
2. **Queue**: otherwise bytes come from `__airstring_next_key()`.

End-of-input semantics mirror the native replay: when the active
source is exhausted, the game exits cleanly with status 0
(replay EOF calls `exit(EXIT_SUCCESS)`; an empty queue in a
scripted run does the same). Interactive hosts (S3+) keep the
queue non-empty by construction and never signal EOF.

Byte-level semantics match tty: NUL/EOF bytes map to ESC, and
reading a key clears the message window's STOP flag, as
`tty_nhgetch` does.

**Verified invariant (S2 gate):** for the same key stream, replay
mode and queue mode produce byte-identical frame exports and
byte-identical rng logs, and both are byte-identical to the
native golden run.

## Terminal-mode state pinned by the shim

The tty port establishes terminal state at startup that core code
silently depends on. The shim pins the same state in
`init_nhwindows`:

- `erase_char = '\177'`, `kill_char = '\025'` (golden pty line
  discipline; `gettty()` is never called in this port).
- `iflags.cbreak = TRUE`, `iflags.echo = FALSE` — the state
  `setftty()` establishes. **Load-bearing:** `xwaitforspace()`
  accepts its dismissal characters only in cbreak mode; without
  this pin a `--More--` prompt swallows every key up to the next
  newline and desynchronises the entire stream (S2 gate finding;
  see REPORT.md).

## Known gaps (registered, not blocking S2)

- `player_selection`: facets not pinned by options are chosen by
  the core's randomisation path after an informational prompt;
  the tty port's interactive facet menus and confirmation step
  are not reproduced. Unreachable in pinned-parameter runs.
- `askname` is an approximation of the tty flow; unreachable when
  the name is pinned.
- Extended commands via menu (`extcmd_via_menu`) do not exist in
  this build (the core compiles that path only for
  TTY_GRAPHICS/CURSES_GRAPHICS); `#` commands go through getlin
  with the tty autocomplete hook, as in the S2 shim's
  `get_ext_cmd`.
- Map/text window `putstr` text is not emitted separately; the
  map is published as the glyph grid (`map` event) and text
  windows as `text` events.
- `doprev_message` (Ctrl-P) returns without rendering, exactly as
  far as key consumption goes; message history display is an S5
  UI concern.
- Systemic audit item for S4: core code under `#ifdef
  TTY_GRAPHICS` may behave differently between the native (tty)
  and wasm (stub) builds; S2's full-run byte equality on G1 is
  strong evidence for the G1 path, but the ifdef sites need an
  explicit audit before the verifier ships.
