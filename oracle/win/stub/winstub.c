/* NetHack 3.6  winstub.c -- airstring S2 structured window shim */
/* Structured-output window port for the WASM build of the fleck
 * instrumented NetHack 3.6.7 oracle.  Written for airstring
 * (2026-11-19); NetHack may be freely redistributed.  See license
 * for details.
 *
 * S1 proved the tree builds to WASM with a no-op stub port.  This S2
 * port replaces the stub with a real window layer whose interaction
 * semantics are a faithful port of the tty port (win/tty/wintty.c,
 * win/tty/topl.c, win/tty/getline.c) -- same state machines, same
 * key-consumption at every prompt -- but with all terminal rendering
 * replaced by structured state plus a JSON event stream to JS (see
 * docs/window-contract.md for the contract).
 *
 * Why the fidelity matters: the fleck replay/verification pipeline
 * requires that a given key stream drives the game through exactly
 * the same sequence of RNG draws as the native tty build.  Every
 * --More--, menu page turn and prompt retry consumes keys, so the
 * shim reproduces the tty port's message wrapping (80x24 virtual
 * terminal, the geometry of the pty that produced the golden
 * transcripts), menu pagination, yn/getlin retry loops and
 * xwaitforspace filtering byte-for-byte in effect.
 *
 * Input funnel: every key the game reads, from any prompt type,
 * comes through shim_nhgetch()/shim_nh_poskey().  When FLECK_REPLAY
 * is active the bytes come from fleck_replay_getch() -- exactly the
 * tty arrangement -- otherwise they are pulled from a JS-supplied
 * queue via the async bridge (globalThis.__airstring_take_key_
 * async, S3/ASYNCIFY): the game suspends until a key is pushed,
 * and only a host-side close of the input produces the -1 that
 * mirrors replay EOF (clean exit, status 0).
 *
 * The fleck frame/RNG export instrumentation reads game-internal
 * state and is untouched by this file.
 */

#include "hack.h"
#include "fleck.h"
#include "dlb.h"
#include "func_tab.h"

#ifdef STUB_GRAPHICS

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ------------------------------------------------------------------ */
/* Stable qsort override (wasm build only; this file is not part of   */
/* the native build).                                                 */
/*                                                                    */
/* Root cause (S3, G2 gate): NetHack's sort_rooms() comparator        */
/* do_comp() compares only lx, so the relative order of rooms with    */
/* equal lx is whatever the libc qsort leaves behind.  The native     */
/* golden files were produced under glibc, whose qsort takes the      */
/* stable mergesort path; musl's qsort is not stable and swapped an   */
/* lx==4 pair on Dlvl 10 of seed 37, changing the room picked for     */
/* the up-stairs (somex modulus rn2(5) instead of rn2(6); first RNG   */
/* divergence at draw 30164).  Giving the wasm build a stable         */
/* mergesort qsort reproduces the glibc semantics for every call      */
/* site; comparators with a total order are unaffected.               */
/* ------------------------------------------------------------------ */
static void
sq_stable_msort(char *base, char *tmp, size_t lo, size_t hi, size_t size,
                int (*cmp)(const void *, const void *))
{
    size_t mid, i, j, k;

    if (hi - lo < 2)
        return;
    mid = lo + (hi - lo) / 2;
    sq_stable_msort(base, tmp, lo, mid, size, cmp);
    sq_stable_msort(base, tmp, mid, hi, size, cmp);
    i = lo;
    j = mid;
    k = lo;
    while (i < mid && j < hi) {
        if (cmp(base + i * size, base + j * size) <= 0) {
            memcpy(tmp + k * size, base + i * size, size);
            i++;
        } else {
            memcpy(tmp + k * size, base + j * size, size);
            j++;
        }
        k++;
    }
    while (i < mid) {
        memcpy(tmp + k * size, base + i * size, size);
        i++;
        k++;
    }
    while (j < hi) {
        memcpy(tmp + k * size, base + j * size, size);
        j++;
        k++;
    }
    memcpy(base + lo * size, tmp + lo * size, (hi - lo) * size);
}

void
qsort(void *base, size_t nmemb, size_t size,
      int (*compar)(const void *, const void *))
{
    char *tmp;

    if (nmemb < 2 || size == 0)
        return;
    tmp = (char *) malloc(nmemb * size);
    if (!tmp) {
        /* stable insertion-sort fallback */
        size_t i, j;
        char *b = (char *) base;
        char *one = (char *) malloc(size);

        if (!one)
            return;
        for (i = 1; i < nmemb; i++) {
            memcpy(one, b + i * size, size);
            j = i;
            while (j > 0 && compar(b + (j - 1) * size, one) > 0) {
                memcpy(b + j * size, b + (j - 1) * size, size);
                j--;
            }
            memcpy(b + j * size, one, size);
        }
        free(one);
        return;
    }
    sq_stable_msort((char *) base, tmp, 0, nmemb, size, compar);
    free(tmp);
}


#ifdef __EMSCRIPTEN__
#include <emscripten.h>
/* JS bridge (implemented in tools/pre-s3.js / the hosting page):
 *   __airstring_event(json_string)  -- receive one contract event
 *   __airstring_take_key_async()    -- queue mode: Promise for the
 *                                      next key byte, or -1 at
 *                                      end-of-input (S3, ASYNCIFY)
 * The S2 bridge also had a synchronous __airstring_next_key(); S3
 * replaces it with the async form below so the game can suspend
 * inside nhgetch until a key actually arrives instead of having
 * to treat an empty queue as EOF.
 */
EM_JS(void, shim_js_event, (const char *json), {
    if (globalThis.__airstring_event)
        globalThis.__airstring_event(UTF8ToString(json));
});
EM_ASYNC_JS(int, shim_js_next_key_async, (), {
    if (globalThis.__airstring_take_key_async)
        return await globalThis.__airstring_take_key_async();
    return -1;
});
/* S3 host completion signal: fired exactly once when the game
 * ends, on either end path (natural shutdown via exit_nhwindows,
 * or the input-EOF clean exit in shim_next_key_raw).  Hosts must
 * wait for this -- with ASYNCIFY the module factory promise
 * resolves at the first stack unwind, long before main() is
 * actually done, and exit() under a kept-alive runtime does not
 * reach the factory promise either. */
EM_JS(void, shim_js_game_over, (int code), {
    if (globalThis.__airstring_game_over)
        globalThis.__airstring_game_over(code);
});
#else
static void shim_js_event(const char *json) { (void) json; }
static int shim_js_next_key_async(void) { return -1; }
static void shim_js_game_over(int code) { (void) code; }
#endif

static int shim_game_over_signalled = 0;

static void
shim_signal_game_over(code)
int code;
{
    if (shim_game_over_signalled)
        return;
    shim_game_over_signalled = 1;
    shim_js_game_over(code);
}

/* ------------------------------------------------------------------ */
/* virtual terminal geometry (matches the golden-run pty: TERM=xterm */
/* with no winsize, i.e. termcap 80x24)                               */

#define SHIM_COLS 80
#define SHIM_ROWS 24
#define CO SHIM_COLS /* name used by the tty sources this file ports */
#define LI SHIM_ROWS

#ifndef NHW_BASE
#define NHW_BASE 6 /* base window type (wintty.h value; port-internal) */
#endif

/* window flags (port-internal; mirrors wintty.h usage) */
#define SHIM_WIN_CANCELLED 0x01 /* menu/text: user escaped out */
#define SHIM_WIN_STOP 0x02      /* message: output stopped by ESC at --More-- */

#define SHIM_MAXWIN 20

/* ------------------------------------------------------------------ */
/* event emission helpers                                              */

/* Append an escaped JSON string body (without quotes) at dst;
   returns pointer to the terminating NUL. */
static char *
shim_jsonesc(dst, src)
char *dst;
const char *src;
{
    char *d = dst;
    const unsigned char *s = (const unsigned char *) src;

    if (!s) {
        *d = '\0';
        return d;
    }
    for (; *s; s++) {
        unsigned char c = *s;

        if (c == '"' || c == '\\') {
            *d++ = '\\';
            *d++ = (char) c;
        } else if (c < 0x20 || c == 0x7f) {
            d += sprintf(d, "\\u%04x", (unsigned) c);
        } else {
            *d++ = (char) c;
        }
    }
    *d = '\0';
    return d;
}

static void
shim_emit(json)
const char *json;
{
    shim_js_event(json);
}

/* ------------------------------------------------------------------ */
/* display state (the ttyDisplay analogue)                             */

static struct shim_display {
    int rows, cols;
    int toplin;       /* 0 empty, 1 has text, 2 no-more-needed, 3 prompt */
    int inmore;       /* more() recursion guard */
    int inread;       /* >0 while a port prompt is reading keys */
    int intr;         /* tty interrupt counter (doprev bookkeeping) */
    int dismiss_more; /* xwaitforspace default char (0 = none) */
    boolean rawprint; /* raw_print since last display */
    int lastwin;
} SD;

/* globals the tty port also provides */
char morc = 0;                /* xwaitforspace result (getline.c) */
char defmorestr[] = "--More--";
/* toplines[] is a core global (decl.c), used as in topl.c */
extern char erase_char, kill_char; /* sys/share/unixtty.c globals; the
    tty port sets them from termios in gettty(), which this port never
    calls -- shim_init_nhwindows pins them to the golden pty values */
winid BASE_WINDOW = WIN_ERR;  /* base window id (wintty.c) */

extern char mapped_menu_cmds[]; /* from options.c */

/* ------------------------------------------------------------------ */
/* key funnel                                                          */

static unsigned long shim_keys_consumed = 0;
static int shim_keys_from_replay = 0; /* sticky once replay seen active */

static int
shim_next_key_raw()
{
    if (fleck_replay_active()) {
        shim_keys_from_replay = 1;
        return fleck_replay_getch(); /* exits cleanly on EOF */
    }
    {
        /* S3: the JS key source is async (ASYNCIFY).  It suspends
           the game until a key is pushed, and returns -1 only when
           the host has closed the input (scripted runs) -- which
           mirrors the replay EOF semantics (clean exit, status 0,
           no save), exactly as the S2 synchronous queue did on
           exhaustion. */
        int k = shim_js_next_key_async();

        if (k < 0) {
            fprintf(stderr,
                    "[shim] key input closed after %lu keys; "
                    "exiting cleanly\n",
                    shim_keys_consumed);
            fflush(stderr);
            shim_signal_game_over(0);
            exit(EXIT_SUCCESS);
        }
        return k;
    }
}

static int shim_nhgetch(void); /* forward; defined with the port proper */

static void
shim_emit_key(c)
int c;
{
    char buf[192], esc[8];

    if (c >= 0x20 && c < 0x7f && c != '"' && c != '\\') {
        esc[0] = (char) c;
        esc[1] = '\0';
    } else
        esc[0] = '\0';
    Sprintf(buf,
            "{\"t\":\"key\",\"n\":%lu,\"code\":%d,\"ch\":\"%s\",\"src\":\"%s\"}",
            shim_keys_consumed, c, esc,
            shim_keys_from_replay ? "replay" : "queue");
    shim_emit(buf);
}

/* ------------------------------------------------------------------ */
/* window bookkeeping                                                  */

typedef struct shim_menu_item {
    anything identifier;
    long count;
    boolean selected;
    char selector, gselector;
    int attr;
    int glyph;
    char *str;  /* composed line, as tty stores it ("a - text") */
    char *text; /* item text as passed to add_menu */
    struct shim_menu_item *next;
} shim_menu_item;

typedef struct shim_windesc {
    int type;
    unsigned flags;
    boolean active;
    int curx, cury;
    int offx, offy;
    int rows, cols;
    int maxrow, maxcol;
    /* NHW_TEXT / NHW_MENU line store (putstr); each entry carries a
       leading attr byte (attr + 1), exactly as the tty port stores */
    char **data;
    /* NHW_MENU */
    shim_menu_item *mlist, **plist;
    int plist_size, npages, nitems, how;
    char *morestr;
    /* NHW_STATUS captured lines */
    char status_lines[3][BUFSZ];
} shim_windesc;

static shim_windesc *shim_wins[SHIM_MAXWIN];

static shim_windesc *
shim_win(wid)
winid wid;
{
    if (wid < 0 || wid >= SHIM_MAXWIN)
        return (shim_windesc *) 0;
    return shim_wins[wid];
}

/* map grid (the structured counterpart of the tty glyph output) */
static struct shim_cell {
    int glyph;
    int ch;
    int color;
    unsigned special;
    int bkglyph;
} shim_map[ROWNO][COLNO];
static boolean shim_map_dirty = TRUE;

static void
shim_map_clear()
{
    int x, y;

    for (y = 0; y < ROWNO; y++)
        for (x = 0; x < COLNO; x++) {
            shim_map[y][x].glyph = NO_GLYPH;
            shim_map[y][x].ch = ' ';
            shim_map[y][x].color = NO_COLOR;
            shim_map[y][x].special = 0;
            shim_map[y][x].bkglyph = NO_GLYPH;
        }
    shim_map_dirty = TRUE;
}

/* message history ring (content matters only for ^P recall display,
   which the shim surfaces as state but does not render) */
#define SHIM_HIST 60
static char shim_history[SHIM_HIST][BUFSZ];
static int shim_history_next = 0;
static int shim_history_count = 0;

static void
shim_remember_topl()
{
    if (*toplines) {
        Strcpy(shim_history[shim_history_next], toplines);
        shim_history_next = (shim_history_next + 1) % SHIM_HIST;
        if (shim_history_count < SHIM_HIST)
            shim_history_count++;
    }
}

/* ------------------------------------------------------------------ */
/* topline machinery (port of win/tty/topl.c, rendering removed)       */

static void shim_more(void); /* forward */

static void
shim_addtopl(s)
const char *s;
{
    /* tty draws s at the cursor and marks the line non-empty; the
       canonical content lives in toplines[], maintained by callers.
       State effects kept: toplin := 1, cury += wrapped segments. */
    const char *p;
    shim_windesc *cw = shim_win(WIN_MESSAGE);

    if (cw) {
        for (p = s; *p; p++)
            if (*p == '\n')
                cw->cury++;
        cw->curx += (int) strlen(s);
    }
    SD.toplin = 1;
}

static void
shim_redotoplin(str)
const char *str;
{
    int otoplin = SD.toplin;
    shim_windesc *cw = shim_win(WIN_MESSAGE);
    const char *p;
    int n = 0, lastseg = 0;

    SD.toplin = 1;
    for (p = str; *p; p++) {
        if (*p == '\n') {
            n++;
            lastseg = 0;
        } else
            lastseg++;
    }
    if (cw) {
        cw->cury = n;
        cw->curx = lastseg;
    }
    if (cw && cw->cury && otoplin != 3)
        shim_more();
}

/* xwaitforspace: port of win/tty/getline.c */
void
xwaitforspace(s)
register const char *s; /* chars allowed besides return */
{
    register int c, x = (int) SD.dismiss_more;

    morc = 0;
    while ((c = shim_nhgetch()) != EOF) {
        if (c == '\n' || c == '\r')
            break;

        if (iflags.cbreak) {
            if (c == '\033') {
                SD.dismiss_more = 1;
                morc = '\033';
                break;
            }
            if ((s && index(s, c)) || c == x || (x == '\n' && c == '\r')) {
                morc = (char) c;
                break;
            }
            shim_emit("{\"t\":\"bell\"}");
        }
    }
}

/* more(): port of win/tty/topl.c */
static void
shim_more()
{
    shim_windesc *cw = shim_win(WIN_MESSAGE);

    /* avoid recursion -- only happens from interrupts */
    if (SD.inmore++)
        return;
    if (iflags.debug_fuzzer)
        return;

    shim_emit("{\"t\":\"more\"}");
    xwaitforspace("\033 ");

    if (cw && morc == '\033')
        cw->flags |= SHIM_WIN_STOP;

    if (SD.toplin && cw && cw->cury) {
        /* docorner(1, cury + 1) redraws the corner window; its only
           state effect is resetting the message cursor */
        cw->curx = cw->cury = 0;
    } else if (cw && morc == '\033') {
        cw->curx = cw->cury = 0;
    }
    SD.toplin = 0;
    SD.inmore = 0;
}

/* update_topl: port of win/tty/topl.c (message accumulation and
   wrapping; drives --More-- timing, hence key consumption) */
static void
shim_update_topl(bp)
register const char *bp;
{
    register char *tl, *otl;
    register int n0;
    int notdied = 1;
    shim_windesc *cw = shim_win(WIN_MESSAGE);
    char esc[BUFSZ * 3], msg[BUFSZ * 2];

    /* structured event: one per logical message */
    (void) shim_jsonesc(msg, bp);
    Sprintf(esc, "{\"t\":\"message\",\"text\":\"%s\"}", msg);
    shim_emit(esc);

    if (!cw)
        return;
    n0 = (int) strlen(bp);
    if ((SD.toplin == 1 || (cw->flags & SHIM_WIN_STOP)) && cw->cury == 0
        && n0 + (int) strlen(toplines) + 3 < CO - 8 /* room for --More-- */
        && (notdied = strncmp(bp, "You die", 7)) != 0) {
        Strcat(toplines, "  ");
        Strcat(toplines, bp);
        cw->curx += 2;
        if (!(cw->flags & SHIM_WIN_STOP))
            shim_addtopl(bp);
        return;
    } else if (!(cw->flags & SHIM_WIN_STOP)) {
        if (SD.toplin == 1) {
            shim_more();
        } else if (cw->cury) { /* for when toplin == 2 && cury > 1 */
            /* docorner(1, cury + 1) redraws; state effect: */
            cw->curx = cw->cury = 0;
        }
    }
    shim_remember_topl();
    (void) strncpy(toplines, bp, TBUFSZ);
    toplines[TBUFSZ - 1] = 0;

    for (tl = toplines; n0 >= CO;) {
        otl = tl;
        for (tl += CO - 1; tl != otl; --tl)
            if (*tl == ' ')
                break;
        if (tl == otl) {
            /* Eek!  A huge token.  Try splitting after it. */
            tl = index(otl, ' ');
            if (!tl)
                break; /* No choice but to spit it out whole. */
        }
        *tl++ = '\n';
        n0 = (int) strlen(tl);
    }
    if (!notdied)
        cw->flags &= ~SHIM_WIN_STOP;
    if (!(cw->flags & SHIM_WIN_STOP))
        shim_redotoplin(toplines);
}

/* show_topl: port of win/tty/topl.c (prompt display path) */
static void
shim_show_topl(str)
const char *str;
{
    shim_windesc *cw = shim_win(WIN_MESSAGE);

    if (!cw)
        return;
    if (!(cw->flags & SHIM_WIN_STOP)) {
        if (cw->cury && SD.toplin == 2)
            clear_nhwindow(WIN_MESSAGE);

        cw->curx = cw->cury = 0;
        Strcpy(toplines, str);
        shim_addtopl(str);

        if (cw->cury && SD.toplin != 3)
            SD.toplin = 2;
    }
}

/* ------------------------------------------------------------------ */
/* window lifecycle (port of win/tty/wintty.c, rendering removed)      */

static void shim_display_nhwindow(winid, BOOLEAN_P); /* forward */
static void shim_dismiss_nhwindow(winid);          /* forward */

static void
shim_free_window_info(cw, freeall)
shim_windesc *cw;
boolean freeall UNUSED;
{
    int i;
    shim_menu_item *curr, *next;

    if (cw->data) {
        for (i = 0; i < cw->maxrow; i++)
            if (cw->data[i]) {
                free((genericptr_t) cw->data[i]);
                cw->data[i] = 0;
            }
        free((genericptr_t) cw->data);
        cw->data = 0;
    }
    cw->rows = cw->maxrow = cw->cury = 0;

    for (curr = cw->mlist; curr; curr = next) {
        next = curr->next;
        free((genericptr_t) curr->str);
        free((genericptr_t) curr->text);
        free((genericptr_t) curr);
    }
    cw->mlist = 0;
    if (cw->plist) {
        free((genericptr_t) cw->plist);
        cw->plist = 0;
    }
    cw->plist_size = cw->npages = cw->nitems = 0;
    if (cw->morestr) {
        free((genericptr_t) cw->morestr);
        cw->morestr = 0;
    }
}

static winid
shim_create_nhwindow(type)
int type;
{
    shim_windesc *newwin;
    int newid;

    for (newid = 0; newid < SHIM_MAXWIN; ++newid)
        if (shim_wins[newid] == 0)
            break;
    if (newid == SHIM_MAXWIN) {
        panic("No window slots!");
        /*NOTREACHED*/
        return WIN_ERR;
    }

    newwin = (shim_windesc *) alloc(sizeof (shim_windesc));
    (void) memset((genericptr_t) newwin, 0, sizeof (shim_windesc));
    shim_wins[newid] = newwin;

    newwin->type = type;
    newwin->flags = 0;
    newwin->active = FALSE;
    newwin->curx = newwin->cury = 0;
    switch (type) {
    case NHW_BASE:
        newwin->offx = newwin->offy = 0;
        newwin->rows = SD.rows;
        newwin->cols = SD.cols;
        newwin->maxrow = newwin->maxcol = 0;
        break;
    case NHW_MESSAGE:
        newwin->offx = newwin->offy = 0;
        if (iflags.msg_history < 20)
            iflags.msg_history = 20;
        else if (iflags.msg_history > 60)
            iflags.msg_history = 60;
        newwin->maxrow = newwin->rows = iflags.msg_history;
        newwin->maxcol = newwin->cols = 0;
        break;
    case NHW_STATUS:
        if (iflags.wc2_statuslines < 2 || iflags.wc2_statuslines > 3)
            iflags.wc2_statuslines = 2;
        newwin->offx = 0;
        {
            int rowoffset = SD.rows - iflags.wc2_statuslines;

            newwin->offy = min(rowoffset, ROWNO + 1);
        }
        newwin->rows = newwin->maxrow = iflags.wc2_statuslines;
        newwin->cols = newwin->maxcol = SD.cols;
        break;
    case NHW_MAP:
        newwin->offx = 0;
        newwin->offy = 1;
        newwin->rows = ROWNO;
        newwin->cols = COLNO;
        newwin->maxrow = 0;
        newwin->maxcol = 0;
        break;
    case NHW_MENU:
    case NHW_TEXT:
        newwin->offx = newwin->offy = 0;
        newwin->rows = newwin->cols = 0;
        newwin->maxrow = newwin->maxcol = 0;
        newwin->data = (char **) 0;
        break;
    }
    return (winid) newid;
}

static void
shim_clear_nhwindow(window)
winid window;
{
    register shim_windesc *cw = 0;

    if (window == WIN_ERR || (cw = shim_win(window)) == (shim_windesc *) 0)
        panic("Bad window id %d", (int) window);
    SD.lastwin = window;

    switch (cw->type) {
    case NHW_MESSAGE:
        if (SD.toplin) {
            /* home + cl_end + optional docorner: state effect only */
            SD.toplin = 0;
        }
        break;
    case NHW_STATUS: {
        int i;

        for (i = 0; i < 3; i++)
            cw->status_lines[i][0] = '\0';
        context.botlx = 1;
        break;
    }
    case NHW_MAP:
        context.botlx = 1;
        shim_map_clear();
        break;
    case NHW_BASE:
        shim_map_clear();
        break;
    case NHW_MENU:
    case NHW_TEXT:
        shim_free_window_info(cw, FALSE);
        break;
    }
    cw->curx = cw->cury = 0;
}

static void
shim_dismiss_nhwindow(window)
winid window;
{
    register shim_windesc *cw = 0;

    if (window == WIN_ERR || (cw = shim_win(window)) == (shim_windesc *) 0)
        panic("Bad window id %d", (int) window);

    switch (cw->type) {
    case NHW_MESSAGE:
        if (SD.toplin)
            shim_display_nhwindow(WIN_MESSAGE, TRUE);
        /*FALLTHRU*/
    case NHW_STATUS:
    case NHW_BASE:
    case NHW_MAP:
        cw->active = 0;
        break;
    case NHW_MENU:
    case NHW_TEXT:
        if (cw->active)
            cw->active = 0;
        break;
    }
    cw->flags = 0;
}

static void
shim_destroy_nhwindow(window)
winid window;
{
    register shim_windesc *cw = 0;

    if (window == WIN_ERR || (cw = shim_win(window)) == (shim_windesc *) 0)
        panic("Bad window id %d", (int) window);

    if (cw->active)
        shim_dismiss_nhwindow(window);
    if (cw->type == NHW_MESSAGE)
        iflags.window_inited = 0;
    if (cw->type == NHW_MAP)
        shim_map_clear();

    shim_free_window_info(cw, TRUE);
    free((genericptr_t) cw);
    shim_wins[window] = 0; /* available for re-use */
}

static void
shim_curs(window, x, y)
winid window;
register int x, y;
{
    shim_windesc *cw = shim_win(window);

    if (!cw)
        return;
    SD.lastwin = window;
    cw->curx = --x; /* column 0 is never used */
    cw->cury = y;
}

/* compress_str: port of win/tty/wintty.c (used for non-message putstr) */
static const char *
shim_compress_str(str)
const char *str;
{
    static char cbuf[BUFSZ];

    /* compress out consecutive spaces if line is too long;
       topline wrapping converts space at wrap point into newline,
       we reverse that here */
    if ((int) strlen(str) >= CO || index(str, '\n')) {
        const char *in_str = str;
        char c, *outstr = cbuf, *outend = &cbuf[sizeof cbuf - 1];
        boolean was_space = TRUE; /* True discards all leading spaces */

        while ((c = *in_str++) != '\0' && outstr < outend) {
            if (c == '\n')
                c = ' ';
            if (was_space && c == ' ')
                continue;
            *outstr++ = c;
            was_space = (c == ' ');
        }
        if ((was_space && outstr > cbuf) || outstr == outend)
            --outstr; /* remove trailing space or make room for terminator */
        *outstr = '\0';
        str = cbuf;
    }
    return str;
}

static void
shim_putstr(window, attr, str)
winid window;
int attr;
const char *str;
{
    register shim_windesc *cw = 0;
    register char *ob;
    register long i, n0;

    /* Assume there's a real problem if the window is missing --
       probably a panic message */
    if (window == WIN_ERR || (cw = shim_win(window)) == (shim_windesc *) 0) {
        raw_print(str);
        return;
    }

    if (str == (const char *) 0
        || ((cw->flags & SHIM_WIN_CANCELLED) && (cw->type != NHW_MESSAGE)))
        return;
    if (cw->type != NHW_MESSAGE)
        str = shim_compress_str(str);

    SD.lastwin = window;

    switch (cw->type) {
    case NHW_MESSAGE: {
        int suppress_history = (attr & ATR_NOHISTORY);

        if (!suppress_history) {
            /* normal output; add to current top line if room, else
               flush whatever is there to history and then write this */
            shim_update_topl(str);
        } else {
            /* put anything already on top line into history */
            shim_remember_topl();
            /* write to top line without remembering it */
            shim_show_topl(str);
        }
        break;
    }
    case NHW_STATUS:
        /* genl_status_update composes whole lines; capture them */
        if (cw->cury < 0 || cw->cury >= cw->maxrow)
            cw->cury = 0;
        (void) strncpy(cw->status_lines[cw->cury], str, BUFSZ - 1);
        cw->status_lines[cw->cury][BUFSZ - 1] = '\0';
        cw->cury = (cw->cury + 1) % cw->maxrow;
        cw->curx = 0;
        break;
    case NHW_MAP:
        cw->curx = 0;
        cw->cury++;
        break;
    case NHW_BASE:
        cw->curx = 0;
        cw->cury++;
        break;
    case NHW_MENU:
    case NHW_TEXT:
        if (cw->type == NHW_TEXT && cw->cury == SD.rows - 1) {
            /* not a menu, so save memory and output 1 page at a time */
            cw->maxcol = SD.cols; /* force full-screen mode */
            shim_display_nhwindow(window, TRUE);
            for (i = 0; i < cw->maxrow; i++)
                if (cw->data[i]) {
                    free((genericptr_t) cw->data[i]);
                    cw->data[i] = 0;
                }
            cw->maxrow = cw->cury = 0;
        }
        /* always grows one at a time, but alloc 12 at a time */
        if (cw->cury >= cw->rows) {
            char **tmp;

            cw->rows += 12;
            tmp = (char **) alloc(sizeof(char *) * (unsigned) cw->rows);
            for (i = 0; i < cw->maxrow; i++)
                tmp[i] = cw->data[i];
            if (cw->data)
                free((genericptr_t) cw->data);
            cw->data = tmp;

            for (i = cw->maxrow; i < cw->rows; i++)
                cw->data[i] = 0;
        }
        if (cw->data[cw->cury])
            free((genericptr_t) cw->data[cw->cury]);
        n0 = (long) strlen(str) + 1L;
        ob = cw->data[cw->cury] = (char *) alloc((unsigned) n0 + 1);
        *ob++ = (char) (attr + 1); /* avoid nuls, for convenience */
        Strcpy(ob, str);

        if (n0 > cw->maxcol)
            cw->maxcol = n0;
        if (++cw->cury > cw->maxrow)
            cw->maxrow = cw->cury;
        if (n0 > CO) {
            /* attempt to break the line */
            for (i = CO - 1; i && str[i] != ' ' && str[i] != '\n';)
                i--;
            if (i) {
                cw->data[cw->cury - 1][++i] = '\0';
                shim_putstr(window, attr, &str[i]);
            }
        }
        break;
    }
}

/* ------------------------------------------------------------------ */
/* map output                                                          */

static void
shim_print_glyph(window, x, y, glyph, bkglyph)
winid window UNUSED;
xchar x, y;
int glyph;
int bkglyph;
{
    int ch;
    int color;
    unsigned special;

    if (x < 0 || x >= COLNO || y < 0 || y >= ROWNO)
        return;
    /* map glyph to character and color (same core routine tty uses) */
    (void) mapglyph(glyph, &ch, &color, &special, (int) x, (int) y, 0);

    shim_map[y][x].glyph = glyph;
    shim_map[y][x].ch = ch;
    shim_map[y][x].color = color;
    shim_map[y][x].special = special;
    shim_map[y][x].bkglyph = bkglyph;
    shim_map_dirty = TRUE;
}

static void
shim_emit_map_snapshot()
{
    /* one event carrying the whole grid: chars + colors per cell */
    static char *buf = 0;
    static unsigned buflen = 0;
    unsigned need = 64 + ROWNO * (COLNO * 16 + 8);
    char *p;
    int x, y;

    if (!buf || buflen < need) {
        if (buf)
            free((genericptr_t) buf);
        buf = (char *) alloc(need);
        buflen = need;
    }
    p = buf;
    p += sprintf(p, "{\"t\":\"map\",\"rows\":[");
    for (y = 0; y < ROWNO; y++) {
        if (y)
            *p++ = ',';
        *p++ = '"';
        for (x = 0; x < COLNO; x++) {
            int c = shim_map[y][x].ch;

            if (c == '"' || c == '\\') {
                *p++ = '\\';
                *p++ = (char) c;
            } else if (c < 0x20 || c >= 0x7f)
                p += sprintf(p, "\\u%04x", (unsigned) (c & 0xff));
            else
                *p++ = (char) c;
        }
        *p++ = '"';
    }
    p += sprintf(p, "],\"colors\":[");
    for (y = 0; y < ROWNO; y++) {
        if (y)
            *p++ = ',';
        *p++ = '[';
        for (x = 0; x < COLNO; x++) {
            if (x)
                *p++ = ',';
            p += sprintf(p, "%d", shim_map[y][x].color);
        }
        *p++ = ']';
    }
    p += sprintf(p, "]}");
    shim_emit(buf);
    shim_map_dirty = FALSE;
}

/* ------------------------------------------------------------------ */
/* text window processing (port of process_text_window + dmore)        */

static void
shim_dmore(cw, s)
register shim_windesc *cw;
const char *s; /* valid responses */
{
    char esc[QBUFSZ * 2], ebuf[QBUFSZ];
    const char *prompt = cw->morestr ? cw->morestr : defmorestr;

    (void) shim_jsonesc(ebuf, prompt);
    Sprintf(esc, "{\"t\":\"more\",\"prompt\":\"%s\"}", ebuf);
    shim_emit(esc);
    xwaitforspace(s);
}

/* emit one displayed text page (lines are data[] entries; the attr
   byte at [0] is reported separately) */
static void
shim_emit_text_page(window, cw, firstline, nlines)
winid window;
shim_windesc *cw;
int firstline, nlines;
{
    static char *buf = 0;
    static unsigned buflen = 0;
    unsigned need = 128 + 32 * (BUFSZ * 2 + 16);
    char *p;
    int li;

    if (!buf || buflen < need) {
        if (buf)
            free((genericptr_t) buf);
        buf = (char *) alloc(need);
        buflen = need;
    }
    p = buf;
    p += sprintf(p, "{\"t\":\"text\",\"win\":%d,\"lines\":[",
                 (int) window);
    for (li = 0; li < nlines; li++) {
        char ebuf[BUFSZ * 2];
        const char *line = "";
        int attr = 0;

        if (li)
            *p++ = ',';
        if (cw->data[firstline + li]) {
            attr = (int) (unsigned char) cw->data[firstline + li][0] - 1;
            line = &cw->data[firstline + li][1];
        }
        (void) shim_jsonesc(ebuf, line);
        p += sprintf(p, "{\"attr\":%d,\"text\":\"%s\"}", attr, ebuf);
    }
    p += sprintf(p, "]}");
    shim_emit(buf);
}

static void
shim_process_text_window(window, cw)
winid window;
shim_windesc *cw;
{
    int i, n, pagestart;

    pagestart = 0;
    for (n = 0, i = 0; i < cw->maxrow; i++) {
        if (!cw->offx && (n + cw->offy == SD.rows - 1)) {
            /* emit the page before waiting, as tty draws before dmore */
            shim_emit_text_page(window, cw, pagestart, i - pagestart);
            pagestart = i;
            shim_dmore(cw, quitchars);
            if (morc == '\033') {
                cw->flags |= SHIM_WIN_CANCELLED;
                break;
            }
            n = 0;
        }
        n++;
    }
    if (i == cw->maxrow) {
        shim_emit_text_page(window, cw, pagestart, i - pagestart);
        shim_dmore(cw, quitchars);
        if (morc == '\033')
            cw->flags |= SHIM_WIN_CANCELLED;
    }
}

/* ------------------------------------------------------------------ */
/* menus (port of win/tty/wintty.c menu machinery)                     */

static void
shim_start_menu(window)
winid window;
{
    shim_clear_nhwindow(window);
}

static void
shim_add_menu(window, glyph, identifier, ch, gch, attr, str, preselected)
winid window;
int glyph;
const anything *identifier;
char ch;
char gch;
int attr;
const char *str;
boolean preselected;
{
    register shim_windesc *cw = 0;
    shim_menu_item *item;
    const char *newstr;
    char buf[4 + BUFSZ];

    if (str == (const char *) 0)
        return;

    if (window == WIN_ERR || (cw = shim_win(window)) == (shim_windesc *) 0
        || cw->type != NHW_MENU)
        panic("Bad window id %d", (int) window);

    cw->nitems++;
    if (identifier->a_void) {
        int len = (int) strlen(str);

        if (len >= BUFSZ) {
            impossible("Menu item too long (%d).", len);
            len = BUFSZ - 1;
        }
        Sprintf(buf, "%c - ", ch ? ch : '?');
        (void) strncpy(buf + 4, str, len);
        buf[4 + len] = '\0';
        newstr = buf;
    } else
        newstr = str;

    item = (shim_menu_item *) alloc(sizeof (shim_menu_item));
    item->identifier = *identifier;
    item->count = -1L;
    item->selected = preselected;
    item->selector = ch;
    item->gselector = gch;
    item->attr = attr;
    item->glyph = glyph;
    item->str = dupstr(newstr ? newstr : "");
    item->text = dupstr(str);

    item->next = cw->mlist;
    cw->mlist = item;
}

/* Invert the given list, can handle NULL as an input. */
static shim_menu_item *
shim_reverse_menu(curr)
shim_menu_item *curr;
{
    shim_menu_item *next, *head = 0;

    while (curr) {
        next = curr->next;
        curr->next = head;
        head = curr;
        curr = next;
    }
    return head;
}

static void
shim_end_menu(window, prompt)
winid window;
const char *prompt;
{
    shim_windesc *cw = 0;
    shim_menu_item *curr;
    short len;
    int lmax, n;
    char menu_ch;

    if (window == WIN_ERR || (cw = shim_win(window)) == (shim_windesc *) 0
        || cw->type != NHW_MENU)
        panic("Bad window id %d", (int) window);

    /* Reverse the list so that items are in correct order. */
    cw->mlist = shim_reverse_menu(cw->mlist);

    /* Put the prompt at the beginning of the menu. */
    if (prompt) {
        anything any;

        any = zeroany; /* not selectable */
        shim_add_menu(window, NO_GLYPH, &any, 0, 0, ATR_NONE, "",
                      MENU_UNSELECTED);
        shim_add_menu(window, NO_GLYPH, &any, 0, 0, ATR_NONE, prompt,
                      MENU_UNSELECTED);
    }

    /* 52: 'a'..'z' and 'A'..'Z'; avoids selector duplication within a page */
    lmax = min(52, (int) SD.rows - 1); /* # lines per page */
    cw->npages = (cw->nitems + (lmax - 1)) / lmax; /* # of pages */

    /* make sure page list is large enough */
    if (cw->plist_size < cw->npages + 1) { /* +1: need one slot beyond last */
        if (cw->plist)
            free((genericptr_t) cw->plist);
        cw->plist_size = cw->npages + 1;
        cw->plist = (shim_menu_item **) alloc(
            cw->plist_size * sizeof (shim_menu_item *));
    }

    cw->cols = 0; /* cols is set when the win is initialized... (why?) */
    menu_ch = '?'; /* lint suppression */
    for (n = 0, curr = cw->mlist; curr; n++, curr = curr->next) {
        /* set page boundaries and character accelerators */
        if ((n % lmax) == 0) {
            menu_ch = 'a';
            cw->plist[n / lmax] = curr;
        }
        if (curr->identifier.a_void && !curr->selector) {
            curr->str[0] = curr->selector = menu_ch;
            if (menu_ch++ == 'z')
                menu_ch = 'A';
        }

        /* cut off any lines that are too long */
        len = (short) (strlen(curr->str) + 2); /* extra space at beg & end */
        if (len > (int) SD.cols) {
            curr->str[SD.cols - 2] = 0;
            len = (short) SD.cols;
        }
        if (len > cw->cols)
            cw->cols = len;
    }
    cw->plist[cw->npages] = 0; /* plist terminator */

    /*
     * If greater than 1 page, morestr is "(x of y) " otherwise, "(end) "
     */
    if (cw->npages > 1) {
        char buf[QBUFSZ];

        /* produce the largest demo string */
        Sprintf(buf, "(%ld of %ld) ", (long) cw->npages, (long) cw->npages);
        len = (short) strlen(buf);
        cw->morestr = dupstr("");
    } else {
        cw->morestr = dupstr("(end) ");
        len = (short) strlen(cw->morestr);
    }

    if (len > (int) SD.cols) {
        /* truncate the prompt if it's too long for the screen */
        if (cw->npages <= 1) /* only str in single page case */
            cw->morestr[SD.cols] = 0;
        len = (short) SD.cols;
    }
    if (len > cw->cols)
        cw->cols = len;

    cw->maxcol = cw->cols;

    /*
     * The number of lines in the first page plus the morestr will be
     * the maximum size of the window.
     */
    if (cw->npages > 1)
        cw->maxrow = cw->rows = lmax + 1;
    else
        cw->maxrow = cw->rows = cw->nitems + 1;
}

/* --- menu selection-state helpers (display side effects dropped) --- */

static boolean
shim_toggle_menu_curr(curr, counting, count)
shim_menu_item *curr;
boolean counting;
long count;
{
    if (curr->selected) {
        if (counting && count > 0) {
            curr->count = count;
            return TRUE;
        } else { /* change state */
            curr->selected = FALSE;
            curr->count = -1L;
            return TRUE;
        }
    } else { /* !selected */
        if (counting && count > 0) {
            curr->count = count;
            curr->selected = TRUE;
            return TRUE;
        } else if (!counting) {
            curr->selected = TRUE;
            return TRUE;
        }
        /* do nothing counting&&count==0 */
    }
    return FALSE;
}

static void
shim_set_all_on_page(page_start, page_end)
shim_menu_item *page_start, *page_end;
{
    shim_menu_item *curr;

    for (curr = page_start; curr != page_end; curr = curr->next)
        if (curr->identifier.a_void && !curr->selected)
            curr->selected = TRUE;
}

static void
shim_unset_all_on_page(page_start, page_end)
shim_menu_item *page_start, *page_end;
{
    shim_menu_item *curr;

    for (curr = page_start; curr != page_end; curr = curr->next)
        if (curr->identifier.a_void && curr->selected) {
            curr->selected = FALSE;
            curr->count = -1L;
        }
}

static void
shim_invert_all_on_page(page_start, page_end, acc)
shim_menu_item *page_start, *page_end;
char acc; /* group accelerator, 0 => all */
{
    shim_menu_item *curr;

    for (curr = page_start; curr != page_end; curr = curr->next)
        if (curr->identifier.a_void && (acc == 0 || curr->gselector == acc)) {
            if (curr->selected) {
                curr->selected = FALSE;
                curr->count = -1L;
            } else
                curr->selected = TRUE;
        }
}

static void
shim_invert_all(cw, page_start, page_end, acc)
shim_windesc *cw;
shim_menu_item *page_start, *page_end;
char acc; /* group accelerator, 0 => all */
{
    shim_menu_item *curr;
    boolean on_curr_page;

    shim_invert_all_on_page(page_start, page_end, acc);

    /* invert the rest */
    for (on_curr_page = FALSE, curr = cw->mlist; curr; curr = curr->next) {
        if (curr == page_start)
            on_curr_page = TRUE;
        else if (curr == page_end)
            on_curr_page = FALSE;

        if (!on_curr_page && curr->identifier.a_void
            && (acc == 0 || curr->gselector == acc)) {
            if (curr->selected) {
                curr->selected = FALSE;
                curr->count = -1;
            } else
                curr->selected = TRUE;
        }
    }
}

/* emit one menu page as a contract event */
static void
shim_emit_menu_page(window, cw, curr_page, page_start, page_end)
winid window;
shim_windesc *cw;
int curr_page;
shim_menu_item *page_start, *page_end;
{
    static char *buf = 0;
    static unsigned buflen = 0;
    unsigned need = 256 + 64 * (BUFSZ * 2 + 96);
    char *p;
    shim_menu_item *curr;
    boolean first = TRUE;

    if (!buf || buflen < need) {
        if (buf)
            free((genericptr_t) buf);
        buf = (char *) alloc(need);
        buflen = need;
    }
    p = buf;
    p += sprintf(p,
                 "{\"t\":\"menu\",\"win\":%d,\"how\":%d,\"page\":%d,"
                 "\"pages\":%d,\"items\":[",
                 (int) window, cw->how, curr_page, (int) cw->npages);
    for (curr = page_start; curr != page_end; curr = curr->next) {
        char esel[2], etext[BUFSZ * 2], selj[8];

        if (!first)
            *p++ = ',';
        first = FALSE;
        esel[0] = curr->selector ? curr->selector : '\0';
        esel[1] = '\0';
        (void) shim_jsonesc(selj, esel);
        (void) shim_jsonesc(etext, curr->text);
        p += sprintf(p,
                     "{\"sel\":\"%s\",\"glyph\":%d,\"attr\":%d,"
                     "\"text\":\"%s\",\"selected\":%s,\"count\":%ld,"
                     "\"pickable\":%s}",
                     selj, curr->glyph, curr->attr, etext,
                     curr->selected ? "true" : "false", curr->count,
                     curr->identifier.a_void ? "true" : "false");
    }
    p += sprintf(p, "]}");
    shim_emit(buf);
}

/* A string containing all the default commands -- to add to a list
   of acceptable inputs.  (Same table as win/tty/wintty.c.) */
static const char default_menu_cmds_shim[] = {
    MENU_FIRST_PAGE,    MENU_LAST_PAGE,   MENU_NEXT_PAGE,
    MENU_PREVIOUS_PAGE, MENU_SELECT_ALL,  MENU_UNSELECT_ALL,
    MENU_INVERT_ALL,    MENU_SELECT_PAGE, MENU_UNSELECT_PAGE,
    MENU_INVERT_PAGE,   MENU_SEARCH,      0 /* null terminator */
};

/* process_menu_window: port of win/tty/wintty.c (rendering removed;
   the key loop, paging, counting and selection logic are unchanged) */
static void shim_getlin(const char *, char *); /* forward */

static void
shim_process_menu_window(window, cw)
winid window;
shim_windesc *cw;
{
    shim_menu_item *page_start, *page_end, *curr;
    long count;
    int n, curr_page, page_lines, resp_len;
    boolean finished, counting, reset_count;
    char resp[QBUFSZ], gacc[QBUFSZ], *msave, *morestr, really_morc;
#define SHIM_MENU_EXPLICIT_CHOICE 0x7f /* pseudo menu manipulation char */

    curr_page = page_lines = 0;
    page_start = page_end = 0;
    msave = cw->morestr; /* save the morestr */
    cw->morestr = morestr = (char *) alloc((unsigned) QBUFSZ);
    counting = FALSE;
    count = 0L;
    reset_count = TRUE;
    finished = FALSE;

    /* collect group accelerators; for PICK_NONE, they're ignored;
       for PICK_ONE, only those which match exactly one entry will be
       accepted; for PICK_ANY, those which match any entry are okay */
    gacc[0] = '\0';
    if (cw->how != PICK_NONE) {
        int i, gcnt[128];
#define SHIM_GSELIDX(c) ((c) & 127) /* guard against `signed char' */

        for (i = 0; i < SIZE(gcnt); i++)
            gcnt[i] = 0;
        for (n = 0, curr = cw->mlist; curr; curr = curr->next)
            if (curr->gselector && curr->gselector != curr->selector) {
                ++n;
                ++gcnt[SHIM_GSELIDX(curr->gselector)];
            }

        if (n > 0) /* at least one group accelerator found */
            for (curr = cw->mlist; curr; curr = curr->next)
                if (curr->gselector && curr->gselector != curr->selector
                    && !index(gacc, curr->gselector)
                    && (cw->how == PICK_ANY
                        || gcnt[SHIM_GSELIDX(curr->gselector)] == 1)) {
                    char *rp = eos(gacc);

                    *rp++ = curr->gselector;
                    *rp = '\0'; /* re-terminate for index() */
                }
    }
    resp_len = 0; /* lint suppression */

    /* loop until finished */
    while (!finished) {
        if (reset_count) {
            counting = FALSE;
            count = 0;
        } else
            reset_count = TRUE;

        if (!page_start) {
            /* new page to be displayed */
            if (curr_page < 0 || (cw->npages > 0 && curr_page >= cw->npages))
                panic("bad menu screen page #%d", curr_page);

            {
                char *rp = resp;

                if (cw->npages > 0) {
                    /* collect accelerators */
                    page_start = cw->plist[curr_page];
                    page_end = cw->plist[curr_page + 1];
                    for (page_lines = 0, curr = page_start; curr != page_end;
                         page_lines++, curr = curr->next) {
                        if (curr->selector)
                            *rp++ = curr->selector;
                    }
                } else {
                    page_start = 0;
                    page_end = 0;
                    page_lines = 0;
                }
                *rp = 0;
            }
            /* remember how many explicit menu choices there are */
            resp_len = (int) strlen(resp);

            shim_emit_menu_page(window, cw, curr_page, page_start, page_end);

            /* set extra chars.. */
            Strcat(resp, default_menu_cmds_shim);
            Strcat(resp, " ");                  /* next page or end */
            Strcat(resp, "0123456789\033\n\r"); /* counts, quit */
            Strcat(resp, gacc);                 /* group accelerators */
            Strcat(resp, mapped_menu_cmds);

            if (cw->npages > 1)
                Sprintf(cw->morestr, "(%d of %d)", curr_page + 1,
                        (int) cw->npages);
            else if (msave)
                Strcpy(cw->morestr, msave);
            else
                Strcpy(cw->morestr, defmorestr);

            shim_dmore(cw, resp);
        } else {
            /* just waiting for another key on the same page... */
            xwaitforspace(resp);
        }

        really_morc = morc; /* (only used with SHIM_MENU_EXPLICIT_CHOICE) */
        if ((index(resp, morc)) != 0
            && index(resp, morc) < resp + resp_len)
            /* explicit menu selection; don't override it if it also
               happens to match a mapped menu command */
            morc = SHIM_MENU_EXPLICIT_CHOICE;
        else
            morc = map_menu_cmd(morc);

        switch (morc) {
        case '0':
            /* special case: '0' is also the default ball class */
            if (!counting && index(gacc, morc))
                goto group_accel;
            /* fall through to count the zero */
            /*FALLTHRU*/
        case '1':
        case '2':
        case '3':
        case '4':
        case '5':
        case '6':
        case '7':
        case '8':
        case '9':
            count = (count * 10L) + (long) (morc - '0');
            if (count != 0L) { /* ignore leading zeros */
                counting = TRUE;
                reset_count = FALSE;
            }
            break;
        case '\033': /* cancel - from counting or loop */
            if (!counting) {
                /* deselect everything */
                for (curr = cw->mlist; curr; curr = curr->next) {
                    curr->selected = FALSE;
                    curr->count = -1L;
                }
                cw->flags |= SHIM_WIN_CANCELLED;
                finished = TRUE;
            }
            /* else only stop count */
            break;
        case '\0': /* finished (commit) */
        case '\n':
        case '\r':
            /* only finished if we are actually picking something */
            if (cw->how != PICK_NONE) {
                finished = TRUE;
                break;
            }
        /* else fall through */
        case ' ':
        case MENU_NEXT_PAGE:
            if (cw->npages > 0 && curr_page != cw->npages - 1) {
                curr_page++;
                page_start = 0;
            } else if (morc == ' ') {
                /* ' ' finishes menus here, but stop '>' doing the same. */
                finished = TRUE;
            }
            break;
        case MENU_PREVIOUS_PAGE:
            if (cw->npages > 0 && curr_page != 0) {
                --curr_page;
                page_start = 0;
            }
            break;
        case MENU_FIRST_PAGE:
            if (cw->npages > 0 && curr_page != 0) {
                page_start = 0;
                curr_page = 0;
            }
            break;
        case MENU_LAST_PAGE:
            if (cw->npages > 0 && curr_page != cw->npages - 1) {
                page_start = 0;
                curr_page = cw->npages - 1;
            }
            break;
        case MENU_SELECT_PAGE:
            if (cw->how == PICK_ANY)
                shim_set_all_on_page(page_start, page_end);
            break;
        case MENU_UNSELECT_PAGE:
            shim_unset_all_on_page(page_start, page_end);
            break;
        case MENU_INVERT_PAGE:
            if (cw->how == PICK_ANY)
                shim_invert_all_on_page(page_start, page_end, 0);
            break;
        case MENU_SELECT_ALL:
            if (cw->how == PICK_ANY) {
                shim_set_all_on_page(page_start, page_end);
                /* set the rest */
                for (curr = cw->mlist; curr; curr = curr->next)
                    if (curr->identifier.a_void && !curr->selected)
                        curr->selected = TRUE;
            }
            break;
        case MENU_UNSELECT_ALL:
            shim_unset_all_on_page(page_start, page_end);
            /* unset the rest */
            for (curr = cw->mlist; curr; curr = curr->next)
                if (curr->identifier.a_void && curr->selected) {
                    curr->selected = FALSE;
                    curr->count = -1;
                }
            break;
        case MENU_INVERT_ALL:
            if (cw->how == PICK_ANY)
                shim_invert_all(cw, page_start, page_end, 0);
            break;
        case MENU_SEARCH:
            if (cw->how == PICK_NONE) {
                shim_emit("{\"t\":\"bell\"}");
                break;
            } else {
                char searchbuf[BUFSZ + 2], tmpbuf[BUFSZ] = DUMMY;
                boolean on_curr_page = FALSE;
                int lineno = 0;

                shim_getlin("Search for:", tmpbuf);
                if (!tmpbuf[0] || tmpbuf[0] == '\033')
                    break;
                Sprintf(searchbuf, "*%s*", tmpbuf);

                for (curr = cw->mlist; curr; curr = curr->next) {
                    if (on_curr_page)
                        lineno++;
                    if (curr == page_start)
                        on_curr_page = TRUE;
                    else if (curr == page_end)
                        on_curr_page = FALSE;
                    if (curr->identifier.a_void
                        && pmatchi(searchbuf, curr->str)) {
                        (void) shim_toggle_menu_curr(curr, counting, count);
                        if (cw->how == PICK_ONE) {
                            finished = TRUE;
                            break;
                        }
                    }
                }
            }
            break;
        case SHIM_MENU_EXPLICIT_CHOICE:
            morc = really_morc;
        /*FALLTHRU*/
        default:
            if (cw->how == PICK_NONE || !index(resp, morc)) {
                /* unacceptable input received */
                shim_emit("{\"t\":\"bell\"}");
                break;
            } else if (index(gacc, morc)) {
 group_accel:
                /* group accelerator; for the PICK_ONE case, we know
                   that it matches exactly one item in order to be in
                   gacc[] */
                shim_invert_all(cw, page_start, page_end, morc);
                if (cw->how == PICK_ONE)
                    finished = TRUE;
                break;
            }
            /* find, toggle, and possibly update */
            for (n = 0, curr = page_start; curr != page_end;
                 n++, curr = curr->next)
                if (morc == curr->selector) {
                    (void) shim_toggle_menu_curr(curr, counting, count);
                    if (cw->how == PICK_ONE)
                        finished = TRUE;
                    break; /* from `for' loop */
                }
            break;
        }

    } /* while */
    cw->morestr = msave;
    free((genericptr_t) morestr);
#undef SHIM_MENU_EXPLICIT_CHOICE
}

static int
shim_select_menu(window, how, menu_list)
winid window;
int how;
menu_item **menu_list;
{
    register shim_windesc *cw = 0;
    shim_menu_item *curr;
    menu_item *mi;
    int n, cancelled;

    if (window == WIN_ERR || (cw = shim_win(window)) == (shim_windesc *) 0
        || cw->type != NHW_MENU)
        panic("Bad window id %d", (int) window);

    *menu_list = (menu_item *) 0;
    cw->how = (short) how;
    morc = 0;
    shim_display_nhwindow(window, TRUE);
    cancelled = !!(cw->flags & SHIM_WIN_CANCELLED);
    shim_dismiss_nhwindow(window); /* does not destroy window data */

    if (cancelled) {
        n = -1;
    } else {
        for (n = 0, curr = cw->mlist; curr; curr = curr->next)
            if (curr->selected)
                n++;
    }

    if (n > 0) {
        *menu_list = (menu_item *) alloc(n * sizeof (menu_item));
        for (mi = *menu_list, curr = cw->mlist; curr; curr = curr->next)
            if (curr->selected) {
                mi->item = curr->identifier;
                mi->count = curr->count;
                mi++;
            }
    }

    {
        char esc[128];

        Sprintf(esc, "{\"t\":\"menu-end\",\"win\":%d,\"n\":%d,"
                     "\"cancelled\":%s}",
                (int) window, n, cancelled ? "true" : "false");
        shim_emit(esc);
    }
    return n;
}

/* special hack for treating top line --More-- as a one item menu */
static char
shim_message_menu(let, how, mesg)
char let;
int how;
const char *mesg;
{
    /* "menu" without selection; use ordinary pline, no more() */
    if (how == PICK_NONE) {
        pline("%s", mesg);
        return 0;
    }

    SD.dismiss_more = let;
    morc = 0;
    /* barebones pline(); we're only supposed to be called after
       response to a prompt, so assume the display is up to date */
    shim_putstr(WIN_MESSAGE, 0, mesg);
    /* if `mesg' didn't wrap (triggering --More--), force --More-- now */
    if (SD.toplin == 1) {
        shim_more();
        SD.toplin = 1; /* more resets this */
        shim_clear_nhwindow(WIN_MESSAGE);
    }
    /* normally <ESC> means skip further messages, but in this case
       it means cancel the current prompt; any other messages should
       continue to be output normally */
    if (shim_win(WIN_MESSAGE))
        shim_win(WIN_MESSAGE)->flags &= ~SHIM_WIN_CANCELLED;
    SD.dismiss_more = 0;

    return ((how == PICK_ONE && morc == let) || morc == '\033') ? morc
                                                                : '\0';
}

static void shim_raw_print(const char *);  /* forward */
static void shim_wait_synch(void);         /* forward */

/* ------------------------------------------------------------------ */
/* display_nhwindow (port of win/tty/wintty.c)                         */

static void
shim_display_nhwindow(window, blocking)
winid window;
BOOLEAN_P blocking; /* with ttys, all windows are blocking */
{
    register shim_windesc *cw = 0;
    short s_maxcol;

    if (window == WIN_ERR || (cw = shim_win(window)) == (shim_windesc *) 0)
        panic("Bad window id %d", (int) window);
    if (cw->flags & SHIM_WIN_CANCELLED)
        return;
    SD.lastwin = window;
    SD.rawprint = 0;

    switch (cw->type) {
    case NHW_MESSAGE:
        if (SD.toplin == 1) {
            shim_more();
            SD.toplin = 1; /* more resets this */
            shim_clear_nhwindow(window);
        } else
            SD.toplin = 0;
        cw->curx = cw->cury = 0;
        if (!cw->active)
            iflags.window_inited = TRUE;
        break;
    case NHW_MAP:
        if (blocking) {
            if (!SD.toplin)
                SD.toplin = 1;
            shim_display_nhwindow(WIN_MESSAGE, TRUE);
            if (shim_map_dirty)
                shim_emit_map_snapshot();
            return;
        }
        if (shim_map_dirty)
            shim_emit_map_snapshot();
        /*FALLTHRU*/
    case NHW_BASE:
        break;
    case NHW_TEXT:
        cw->maxcol = SD.cols; /* force full-screen mode */
        /*FALLTHRU*/
    case NHW_MENU:
        cw->active = 1;
        /* cw->maxcol is a long, but its value is constrained to
           be <= SD.cols, so is sure to fit within a short */
        s_maxcol = (short) cw->maxcol;
        cw->offx = (uchar) max(10, (int) (SD.cols - s_maxcol - 1));
        if (cw->offx < 0)
            cw->offx = 0;
        if (cw->type == NHW_MENU)
            cw->offy = 0;
        if (SD.toplin == 1)
            shim_display_nhwindow(WIN_MESSAGE, TRUE);
        if (cw->offx == 10 || cw->maxrow >= (int) SD.rows
            || !iflags.menu_overlay) {
            cw->offx = 0;
            SD.toplin = 0;
        } else {
            if (WIN_MESSAGE != WIN_ERR)
                shim_clear_nhwindow(WIN_MESSAGE);
        }

        if (cw->data || !cw->maxrow)
            shim_process_text_window(window, cw);
        else
            shim_process_menu_window(window, cw);
        break;
    }
    cw->active = 1;
}

/* display_file: port of win/tty/wintty.c (built-in pager branch) */
static void
shim_display_file(fname, complain)
const char *fname;
boolean complain;
{
    dlb *f;
    char buf[BUFSZ];
    char *cr;

    shim_clear_nhwindow(WIN_MESSAGE);
    f = dlb_fopen(fname, "r");
    if (!f) {
        if (complain) {
            shim_raw_print("");
            /* tty calls perror(fname) here (goes to stderr) */
            fprintf(stderr, "%s: cannot open\n", fname);
            shim_wait_synch(); /* rawprint set -> getret key wait */
            pline("Cannot open \"%s\".", fname);
        } else if (u.ux)
            docrt();
    } else {
        winid datawin = shim_create_nhwindow(NHW_TEXT);
        boolean empty = TRUE;
        shim_windesc *dw = shim_win(datawin);
        shim_windesc *sw = shim_win(WIN_STATUS);

        if (complain && dw && sw) {
            /* attempt to scroll text below map window if there's room */
            dw->offy = sw->offy + 3;
            if ((int) dw->offy + 12 > (int) SD.rows)
                dw->offy = 0;
        }
        while (dlb_fgets(buf, BUFSZ, f)) {
            if ((cr = index(buf, '\n')) != 0)
                *cr = 0;
            if (index(buf, '\t') != 0)
                (void) tabexpand(buf);
            empty = FALSE;
            shim_putstr(datawin, 0, buf);
            if (dw && (dw->flags & SHIM_WIN_CANCELLED))
                break;
        }
        if (!empty)
            shim_display_nhwindow(datawin, FALSE);
        shim_destroy_nhwindow(datawin);
        (void) dlb_fclose(f);
    }
}

/* ------------------------------------------------------------------ */
/* raw print / synch (port of win/tty/wintty.c)                        */

static void
shim_raw_print(str)
const char *str;
{
    char esc[BUFSZ * 3], ebuf[BUFSZ * 2];

    SD.rawprint = 1;
    if (str) {
        (void) shim_jsonesc(ebuf, str);
        Sprintf(esc, "{\"t\":\"raw\",\"text\":\"%s\"}", ebuf);
        shim_emit(esc);
        fprintf(stderr, "[shim] raw: %s\n", str);
    }
}

static void
shim_raw_print_bold(str)
const char *str;
{
    shim_raw_print(str);
}

/* getret(): port of the tty static (wait for a key after raw output) */
static void
shim_getret()
{
    shim_emit("{\"t\":\"getret\"}");
    xwaitforspace(" ");
}

static void
shim_mark_synch()
{
}

static void
shim_wait_synch()
{
    /* we just need to make sure all windows are synch'd */
    if (SD.rawprint) {
        shim_getret();
        SD.rawprint = 0;
    } else if (shim_win(WIN_MAP)) {
        shim_display_nhwindow(WIN_MAP, FALSE);
        if (SD.inmore) {
            shim_addtopl("--More--");
        } else if (SD.inread > program_state.gameover) {
            /* this can only happen if we were reading and got
               interrupted */
            SD.toplin = 3;
            /* (tty calls doprev_message twice here; it consumes no
               keys and the shim does not render recall) */
            SD.intr++;
        }
    }
}

/* ------------------------------------------------------------------ */
/* the funnel itself                                                   */

static int
shim_nhgetch()
{
    int i;
    shim_windesc *mw = shim_win(WIN_MESSAGE);

    /* reading a key clears the message window's WIN_STOP flag */
    if (mw)
        mw->flags &= ~SHIM_WIN_STOP;
    i = shim_next_key_raw();
    if (!i)
        i = '\033'; /* map NUL to ESC since nethack doesn't expect NUL */
    else if (i == EOF)
        i = '\033'; /* same for EOF */
    shim_keys_consumed++;
    shim_emit_key(i);
    return i;
}

static int
shim_nh_poskey(x, y, mod)
int *x, *y, *mod;
{
    if (x)
        *x = 0;
    if (y)
        *y = 0;
    if (mod)
        *mod = 0;
    return shim_nhgetch();
}

static void
shim_nhbell()
{
    shim_emit("{\"t\":\"bell\"}");
}

static int
shim_doprev_message()
{
    /* tty renders previous messages here; it consumes no keys and
       returns 0.  The shim keeps the history as state (see contract)
       but has nothing to render. */
    return 0;
}

/* ------------------------------------------------------------------ */
/* yn_function: port of win/tty/topl.c                                 */

static char
shim_yn_function(query, resp, def)
const char *query, *resp;
char def;
{
    register char q;
    char rtmp[40];
    boolean digit_ok, allow_num, preserve_case = FALSE;
    shim_windesc *cw = shim_win(WIN_MESSAGE);
    boolean doprev = 0;
    char prompt[BUFSZ];
    char esc[QBUFSZ * 2 + 128], ebuf[QBUFSZ * 2];

    yn_number = 0L;
    if (SD.toplin == 1 && cw && !(cw->flags & SHIM_WIN_STOP))
        shim_more();
    if (cw)
        cw->flags &= ~SHIM_WIN_STOP;
    SD.toplin = 3; /* special prompt state */
    SD.inread++;

    /* structured prompt event */
    {
        char ebuf2[QBUFSZ * 2], defch[2];

        (void) shim_jsonesc(ebuf, query);
        (void) shim_jsonesc(ebuf2, resp ? resp : "");
        defch[0] = def;
        defch[1] = '\0';
        Sprintf(esc,
                "{\"t\":\"prompt\",\"kind\":\"yn\",\"q\":\"%s\","
                "\"choices\":\"%s\",\"def\":\"%s\"}",
                ebuf, resp ? ebuf2 : "", resp ? defch : "");
        if (!resp)
            esc[0] = '\0', Sprintf(esc,
                    "{\"t\":\"prompt\",\"kind\":\"yn\",\"q\":\"%s\","
                    "\"choices\":null,\"def\":null}",
                    ebuf);
        shim_emit(esc);
    }

    if (resp) {
        char *rb, respbuf[QBUFSZ];

        allow_num = (index(resp, '#') != 0);
        Strcpy(respbuf, resp);
        /* normally we force lowercase, but if any uppercase letters
           are present in the allowed response, preserve case;
           check this before stripping the hidden choices */
        for (rb = respbuf; *rb; ++rb)
            if ('A' <= *rb && *rb <= 'Z') {
                preserve_case = TRUE;
                break;
            }
        /* any acceptable responses that follow <esc> aren't displayed */
        if ((rb = index(respbuf, '\033')) != 0)
            *rb = '\0';
        (void) strncpy(prompt, query, QBUFSZ - 1);
        prompt[QBUFSZ - 1] = '\0';
        Sprintf(eos(prompt), " [%s]", respbuf);
        if (def)
            Sprintf(eos(prompt), " (%c)", def);
        /* trailing space is wanted in case of reprompt */
        Strcat(prompt, " ");
        custompline(OVERRIDE_MSGTYPE | SUPPRESS_HISTORY, "%s", prompt);
    } else {
        /* no restriction on allowed response, so always preserve case */
        Sprintf(prompt, "%s ", query);
        custompline(OVERRIDE_MSGTYPE | SUPPRESS_HISTORY, "%s", prompt);
        q = readchar();
        goto clean_up;
    }

    do { /* loop until we get valid input */
        q = readchar();
        if (!preserve_case)
            q = lowc(q);
        if (q == '\020') { /* ctrl-P */
            if (iflags.prevmsg_window != 's') {
                int sav = SD.inread;

                SD.inread = 0;
                (void) shim_doprev_message();
                SD.inread = sav;
                shim_clear_nhwindow(WIN_MESSAGE);
                if (cw)
                    cw->maxcol = cw->maxrow;
                /* addtopl(prompt): redraw prompt on topline */
                Strcpy(toplines, prompt);
                shim_addtopl(prompt);
            } else {
                if (!doprev)
                    (void) shim_doprev_message(); /* need two initially */
                (void) shim_doprev_message();
                doprev = 1;
            }
            q = '\0'; /* force another loop iteration */
            continue;
        } else if (doprev) {
            shim_clear_nhwindow(WIN_MESSAGE);
            if (cw)
                cw->maxcol = cw->maxrow;
            doprev = 0;
            Strcpy(toplines, prompt);
            shim_addtopl(prompt);
            q = '\0'; /* force another loop iteration */
            continue;
        }
        digit_ok = allow_num && digit(q);
        if (q == '\033') {
            if (index(resp, 'q'))
                q = 'q';
            else if (index(resp, 'n'))
                q = 'n';
            else
                q = def;
            break;
        } else if (index(quitchars, q)) {
            q = def;
            break;
        }
        if (!index(resp, q) && !digit_ok) {
            shim_nhbell();
            q = (char) 0;
        } else if (q == '#' || digit_ok) {
            char z, digit_string[2];
            int n_len = 0;
            long value = 0;

            /* addtopl("#") */
            Strcat(toplines, "#"), n_len++;
            digit_string[1] = '\0';
            if (q != '#') {
                digit_string[0] = q;
                Strcat(toplines, digit_string), n_len++;
                value = q - '0';
                q = '#';
            }
            do { /* loop until we get a non-digit */
                z = readchar();
                if (!preserve_case)
                    z = lowc(z);
                if (digit(z)) {
                    value = (10 * value) + (z - '0');
                    if (value < 0)
                        break; /* overflow: try again */
                    digit_string[0] = z;
                    Strcat(toplines, digit_string), n_len++;
                } else if (z == 'y' || index(quitchars, z)) {
                    if (z == '\033')
                        value = -1; /* abort */
                    z = '\n';       /* break */
                } else if (z == erase_char || z == '\b') {
                    if (n_len <= 1) {
                        value = -1;
                        break;
                    } else {
                        value /= 10;
                        /* removetopl(1) */
                        toplines[strlen(toplines) - 1] = '\0';
                        n_len--;
                    }
                } else {
                    value = -1; /* abort */
                    shim_nhbell();
                    break;
                }
            } while (z != '\n');
            if (value > 0)
                yn_number = value;
            else if (value == 0)
                q = 'n'; /* 0 => "no" */
            else {       /* remove number from top line, then try again */
                toplines[strlen(toplines) - n_len] = '\0';
                n_len = 0;
                q = '\0';
            }
        }
    } while (!q);

 clean_up:
    if (yn_number)
        Sprintf(rtmp, "#%ld", yn_number);
    else
        (void) key2txt((uchar) q, rtmp);
    Sprintf(toplines, "%s%s", prompt, rtmp);
    SD.inread--;
    SD.toplin = 2;
    if (SD.intr)
        SD.intr--;
    if (cw && cw->cury)
        shim_clear_nhwindow(WIN_MESSAGE);

    {
        char esc2[64];

        Sprintf(esc2, "{\"t\":\"prompt-end\",\"kind\":\"yn\",\"ans\":\"%c\"}",
                q == '\033' ? 'e' : q);
        if (q < 0x20 || q >= 0x7f)
            Sprintf(esc2, "{\"t\":\"prompt-end\",\"kind\":\"yn\",\"ans\":%d}",
                    (int) (uchar) q);
        shim_emit(esc2);
    }
    return q;
}

/* ------------------------------------------------------------------ */
/* getlin / get_ext_cmd: port of win/tty/getline.c                     */

static boolean shim_suppress_history = FALSE;
typedef boolean (*shim_getlin_hook_proc)(char *);
static boolean shim_ext_cmd_getlin_hook(char *); /* forward */

static void
shim_hooked_getlin(query, bufp, hook)
const char *query;
register char *bufp;
shim_getlin_hook_proc hook;
{
    register char *obufp = bufp;
    register int c;
    shim_windesc *cw = shim_win(WIN_MESSAGE);
    boolean doprev = 0;
    char esc[QBUFSZ * 2 + 64], ebuf[QBUFSZ * 2];

    if (SD.toplin == 1 && cw && !(cw->flags & SHIM_WIN_STOP))
        shim_more();
    if (cw)
        cw->flags &= ~SHIM_WIN_STOP;
    SD.toplin = 3; /* special prompt state */
    SD.inread++;

    (void) shim_jsonesc(ebuf, query);
    Sprintf(esc, "{\"t\":\"prompt\",\"kind\":\"line\",\"q\":\"%s\"}", ebuf);
    shim_emit(esc);

    /* issue the prompt */
    custompline(OVERRIDE_MSGTYPE | SUPPRESS_HISTORY, "%s ", query);
    /* !EDIT_GETLIN: bufp is output only; init it to empty */
    *bufp = '\0';

    for (;;) {
        Strcat(strcat(strcpy(toplines, query), " "), obufp);
        c = pgetchar();
        if (c == '\033' || c == EOF) {
            if (c == '\033' && obufp[0] != '\0') {
                obufp[0] = '\0';
                bufp = obufp;
                shim_clear_nhwindow(WIN_MESSAGE);
                /* addtopl(query); addtopl(" "); addtopl(obufp); */
                Strcpy(toplines, query);
            } else {
                obufp[0] = '\033';
                obufp[1] = '\0';
                break;
            }
        }
        if (SD.intr) {
            SD.intr--;
            *bufp = 0;
        }
        if (c == '\020') { /* ctrl-P */
            if (iflags.prevmsg_window != 's') {
                int sav = SD.inread;

                SD.inread = 0;
                (void) shim_doprev_message();
                SD.inread = sav;
                shim_clear_nhwindow(WIN_MESSAGE);
                if (cw)
                    cw->maxcol = cw->maxrow;
                /* addtopl(query); addtopl(" "); *bufp = 0; addtopl(obufp); */
                *bufp = 0;
            } else {
                if (!doprev)
                    (void) shim_doprev_message(); /* need two initially */
                (void) shim_doprev_message();
                doprev = 1;
                continue;
            }
        } else if (doprev && iflags.prevmsg_window == 's') {
            shim_clear_nhwindow(WIN_MESSAGE);
            if (cw)
                cw->maxcol = cw->maxrow;
            doprev = 0;
            *bufp = 0;
        }
        if (c == erase_char || c == '\b') {
            if (bufp != obufp) {
                bufp--;
                *bufp = 0;
            } else
                shim_nhbell();
        } else if (c == '\n' || c == '\r') {
            break;
        } else if (' ' <= (unsigned char) c && c != '\177'
                   && (bufp - obufp < BUFSZ - 1 && bufp - obufp < CO)) {
            *bufp = c;
            bufp[1] = 0;
            bufp++;
            if (hook)
                (void) (*hook)(obufp);
        } else if (c == kill_char || c == '\177') { /* Robert Viduya */
            /* this test last - @ might be the kill_char */
            bufp = obufp;
            *bufp = 0;
        } else
            shim_nhbell();
    }
    SD.toplin = 2; /* nonempty, no --More-- required */
    SD.inread--;
    clear_nhwindow(WIN_MESSAGE); /* clean up after ourselves */

    if (shim_suppress_history) {
        /* prevent next message from pushing current query+answer
           into message history */
        *toplines = '\0';
    }

    {
        char esc2[BUFSZ * 3], ebuf2[BUFSZ * 2];

        (void) shim_jsonesc(ebuf2, obufp);
        Sprintf(esc2, "{\"t\":\"prompt-end\",\"kind\":\"line\",\"text\":\"%s\"}",
                ebuf2);
        shim_emit(esc2);
    }
}

static void
shim_getlin(query, bufp)
const char *query;
char *bufp;
{
    shim_suppress_history = FALSE;
    shim_hooked_getlin(query, bufp, (shim_getlin_hook_proc) 0);
}

/*
 * Implement extended command completion by using this hook into
 * shim_getlin.  Check the characters already typed, if they uniquely
 * identify an extended command, expand the string to the whole
 * command.  (Port of ext_cmd_getlin_hook in win/tty/getline.c.)
 */
static boolean
shim_ext_cmd_getlin_hook(base)
char *base;
{
    int oindex, com_index;

    com_index = -1;
    for (oindex = 0; extcmdlist[oindex].ef_txt != (char *) 0; oindex++) {
        if (extcmdlist[oindex].flags & CMD_NOT_AVAILABLE)
            continue;
        if ((extcmdlist[oindex].flags & AUTOCOMPLETE)
            && !(!wizard && (extcmdlist[oindex].flags & WIZMODECMD))
            && !strncmpi(base, extcmdlist[oindex].ef_txt, strlen(base))) {
            if (com_index == -1) /* no matches yet */
                com_index = oindex;
            else /* more than 1 match */
                return FALSE;
        }
    }
    if (com_index >= 0) {
        Strcpy(base, extcmdlist[com_index].ef_txt);
        return TRUE;
    }

    return FALSE; /* didn't match anything */
}

static int
shim_get_ext_cmd()
{
    int i;
    char buf[BUFSZ];

    /* Note: the tty port delegates to extcmd_via_menu() when the
       'extmenu' option is set, but that core routine is compiled
       only under TTY_GRAPHICS/CURSES_GRAPHICS, neither of which is
       defined for this port (defining TTY_GRAPHICS would change
       core code paths, which verification forbids).  The option is
       therefore inert here: extended commands always use the
       getlin path below.  Pinned replay runs never set extmenu. */
    shim_suppress_history = TRUE;
    buf[0] = '\0';
    shim_hooked_getlin("#", buf, in_doagain ? (shim_getlin_hook_proc) 0
                                            : shim_ext_cmd_getlin_hook);
    (void) mungspaces(buf);
    if (buf[0] == 0 || buf[0] == '\033')
        return -1;

    for (i = 0; extcmdlist[i].ef_txt != (char *) 0; i++)
        if (!strcmpi(buf, extcmdlist[i].ef_txt))
            break;

    if (!in_doagain) {
        int j;

        for (j = 0; buf[j]; j++)
            savech(buf[j]);
        savech('\n');
    }

    if (extcmdlist[i].ef_txt == (char *) 0) {
        pline("%s: unknown extended command.", buf);
        i = -1;
    }

    return i;
}

/* ------------------------------------------------------------------ */
/* startup prompts                                                     */

static void shim_exit_nhwindows(const char *); /* forward */

/* clean up and quit (port of the tty port's static bail()) */
static void
shim_bail(mesg)
const char *mesg;
{
    clearlocks();
    shim_exit_nhwindows(mesg);
    nh_terminate(EXIT_SUCCESS);
    /*NOTREACHED*/
}

static void
shim_askname()
{
    /* Called only when no name was pinned via options/startup; the
       tty version reads raw keys until newline (not via getlin).
       Port of the tty_askname main loop, minus SELECTSAVED. */
    static const char who_are_you[] = "Who are you? ";
    register int c, ct, tryct = 0;
    char buf[BUFSZ];

    shim_putstr(BASE_WINDOW, 0, "");
    do {
        if (++tryct > 1) {
            if (tryct > 10)
                shim_bail("Giving up after 10 tries.\n");
            shim_putstr(BASE_WINDOW, 0, "Enter a name for your character...");
        }
        shim_putstr(BASE_WINDOW, 0, who_are_you);
        ct = 0;
        buf[0] = '\0';
        while ((c = shim_nhgetch()) != '\n' && c != '\r') {
            if (c == '\033') {
                ct = 0;
                buf[0] = '\0';
                break;
            }
            if (c == erase_char || c == '\b' || c == '\177') {
                if (ct > 0)
                    buf[--ct] = '\0';
                continue;
            }
            if (c == kill_char || c == '\025') {
                ct = 0;
                buf[0] = '\0';
                continue;
            }
            if (' ' <= (unsigned char) c && c < 0x7f
                && ct < (int) sizeof buf - 1 && ct < (int) sizeof plname - 1) {
                buf[ct++] = (char) c;
                buf[ct] = '\0';
            }
        }
        if (c == '\033')
            continue;
        /* strip trailing spaces, like the tty loop's cleanup */
        while (ct > 0 && buf[ct - 1] == ' ')
            buf[--ct] = '\0';
        if (ct > 0)
            Strcpy(plname, buf);
    } while (!plname[0]);
    shim_emit("{\"t\":\"askname\"}");
}

static void
shim_player_selection()
{
    /* The tty port prompts only for facets the player did not
       specify.  All fleck replay/verification runs pin role, race,
       gender and alignment via NETHACKOPTIONS, and the native
       transcript confirms the tty port consumes no keys in that
       case; mirror that: with everything specified, there is
       nothing to ask.  For unspecified facets, offer the tty port's
       initial "[ynaq]" prompt and let random selection fill the
       rest (full manual menu picking is a documented gap in
       docs/window-contract.md; it is unreachable in pinned runs). */
    boolean picksomething = (flags.initrole == ROLE_NONE
                             || flags.initrace == ROLE_NONE
                             || flags.initgend == ROLE_NONE
                             || flags.initalign == ROLE_NONE);

    if (flags.randomall && picksomething) {
        if (flags.initrole == ROLE_NONE)
            flags.initrole = ROLE_RANDOM;
        if (flags.initrace == ROLE_NONE)
            flags.initrace = ROLE_RANDOM;
        if (flags.initgend == ROLE_NONE)
            flags.initgend = ROLE_RANDOM;
        if (flags.initalign == ROLE_NONE)
            flags.initalign = ROLE_RANDOM;
        picksomething = FALSE;
    }
    rigid_role_checks();
    if (picksomething) {
        char pbuf[QBUFSZ];
        char *prompt = build_plselection_prompt(pbuf, QBUFSZ,
                                                flags.initrole,
                                                flags.initrace,
                                                flags.initgend,
                                                flags.initalign);
        char pick4u;

        shim_putstr(BASE_WINDOW, 0, "");
        shim_putstr(BASE_WINDOW, 0, prompt);
        do {
            pick4u = lowc(readchar());
            if (index(quitchars, pick4u))
                pick4u = 'y';
        } while (!index(ynaqchars, pick4u));
        if (pick4u == 'q') {
            /* tty goes to give_up -> bail() */
            shim_bail("Until next time then...");
        }
        /* 'y', 'a' or 'n': mark every unspecified facet random and
           let role_init pick (tty additionally offers manual menus
           for 'n' and a confirmation for 'y'; see contract doc) */
        if (flags.initrole == ROLE_NONE)
            flags.initrole = ROLE_RANDOM;
        if (flags.initrace == ROLE_NONE)
            flags.initrace = ROLE_RANDOM;
        if (flags.initgend == ROLE_NONE)
            flags.initgend = ROLE_RANDOM;
        if (flags.initalign == ROLE_NONE)
            flags.initalign = ROLE_RANDOM;
    }
}

/* ------------------------------------------------------------------ */
/* misc port entry points                                              */

static void
shim_init_nhwindows(argcp, argv)
int *argcp UNUSED;
char **argv UNUSED;
{
    SD.rows = SHIM_ROWS;
    SD.cols = SHIM_COLS;
    SD.toplin = 0;
    SD.inmore = 0;
    SD.inread = 0;
    SD.intr = 0;
    SD.dismiss_more = 0;
    SD.rawprint = FALSE;
    /* gettty() on the golden-run pty read the kernel-default line
       discipline: VERASE=DEL, VKILL=Ctrl-U.  Nothing in this port
       calls gettty(), so pin the same values here. */
    erase_char = '\177';
    kill_char = '\025';
    /* setftty() (sys/share/unixtty.c) puts the tty port into cbreak
       mode with echo off before play begins: iflags.cbreak=ON,
       iflags.echo=OFF.  Nothing in this port calls setftty(), so pin
       the same terminal-mode state here.  This is load-bearing, not
       cosmetic: xwaitforspace() only accepts its dismissal chars
       (space/return/ESC) when iflags.cbreak is set; with it clear,
       a --More-- prompt swallows every key up to the next newline,
       which desynchronises the whole key stream (found by the S2
       G1 byte-comparison gate; see REPORT.md). */
    iflags.cbreak = TRUE;
    iflags.echo = FALSE;
    *toplines = '\0';
    shim_map_clear();
    BASE_WINDOW = shim_create_nhwindow(NHW_BASE);
    shim_emit("{\"t\":\"init\",\"rows\":24,\"cols\":80,"
              "\"port\":\"airstring-shim\"}");
    fprintf(stderr, "[shim] init_nhwindows (virtual 80x24)\n");
}

static void
shim_get_nh_event()
{
}

static void
shim_exit_nhwindows(str)
const char *str UNUSED;
{
    shim_emit("{\"t\":\"exit\"}");
    fprintf(stderr, "[shim] exit_nhwindows (keys consumed: %lu)\n",
            shim_keys_consumed);
    shim_signal_game_over(0);
}

static void
shim_suspend_nhwindows(str)
const char *str UNUSED;
{
}

static void
shim_resume_nhwindows()
{
}

static void
shim_update_inventory()
{
}

#ifdef CLIPPING
static void
shim_cliparound(x, y)
int x UNUSED;
int y UNUSED;
{
}
#endif

#ifdef POSITIONBAR
static void
shim_update_positionbar(posbar)
char *posbar UNUSED;
{
}
#endif

static void
shim_number_pad(state)
int state UNUSED;
{
}

static void
shim_delay_output()
{
}

static void
shim_start_screen()
{
}

static void
shim_end_screen()
{
}

static void
shim_outrip(wid, how, when)
winid wid UNUSED;
int how UNUSED;
time_t when UNUSED;
{
    /* genl_outrip only exists when TEXT_TOMBSTONE is enabled; the
       shim port provides its own no-op plus a contract event */
    shim_emit("{\"t\":\"rip\"}");
}

/* status: wrap the generic (windows.c) implementation so the shim
   can publish structured fields; names are recorded at enable time */
extern char *status_vals[];       /* windows.c */
extern boolean status_activefields[]; /* windows.c */

#define SHIM_MAXSTATUS 128
static char *shim_status_names[SHIM_MAXSTATUS];

static void
shim_status_enablefield(idx, nm, fmt, enable)
int idx;
const char *nm;
const char *fmt;
boolean enable;
{
    if (idx >= 0 && idx < SHIM_MAXSTATUS) {
        if (shim_status_names[idx])
            free((genericptr_t) shim_status_names[idx]);
        shim_status_names[idx] = nm ? dupstr(nm) : (char *) 0;
    }
    genl_status_enablefield(idx, nm, fmt, enable);
}

static void
shim_emit_status()
{
    static char *buf = 0;
    static unsigned buflen = 0;
    unsigned need = 256 + SHIM_MAXSTATUS * (BUFSZ + 64);
    char *p;
    int i;
    boolean first = TRUE;
    shim_windesc *sw = shim_win(WIN_STATUS);

    if (!buf || buflen < need) {
        if (buf)
            free((genericptr_t) buf);
        buf = (char *) alloc(need);
        buflen = need;
    }
    p = buf;
    p += sprintf(p, "{\"t\":\"status\",\"fields\":{");
    for (i = 0; i < SHIM_MAXSTATUS; i++) {
        char ebuf[BUFSZ * 2];

        if (!status_activefields[i] || !status_vals[i]
            || !status_vals[i][0])
            continue;
        if (!first)
            *p++ = ',';
        first = FALSE;
        (void) shim_jsonesc(ebuf, status_vals[i]);
        p += sprintf(p, "\"%s\":\"%s\"",
                     shim_status_names[i] ? shim_status_names[i] : "?",
                     ebuf);
    }
    p += sprintf(p, "},\"lines\":[");
    if (sw) {
        int li;

        for (li = 0; li < sw->maxrow; li++) {
            char ebuf[BUFSZ * 2];

            if (li)
                *p++ = ',';
            (void) shim_jsonesc(ebuf, sw->status_lines[li]);
            p += sprintf(p, "\"%s\"", ebuf);
        }
    }
    p += sprintf(p, "]}");
    shim_emit(buf);
}

static void
shim_status_update(idx, ptr, chg, percent, color, colormasks)
int idx;
genericptr_t ptr;
int chg, percent, color;
unsigned long *colormasks;
{
    genl_status_update(idx, ptr, chg, percent, color, colormasks);
    if (idx == BL_FLUSH)
        shim_emit_status();
}

/* ------------------------------------------------------------------ */

struct window_procs stub_procs = {
    "stub",
    0, /* wincap */
    0, /* wincap2 */
    { 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1 },
    shim_init_nhwindows, shim_player_selection, shim_askname,
    shim_get_nh_event, shim_exit_nhwindows, shim_suspend_nhwindows,
    shim_resume_nhwindows, shim_create_nhwindow, shim_clear_nhwindow,
    shim_display_nhwindow, shim_destroy_nhwindow, shim_curs,
    shim_putstr, genl_putmixed, shim_display_file, shim_start_menu,
    shim_add_menu, shim_end_menu, shim_select_menu, shim_message_menu,
    shim_update_inventory, shim_mark_synch, shim_wait_synch,
#ifdef CLIPPING
    shim_cliparound,
#endif
#ifdef POSITIONBAR
    shim_update_positionbar,
#endif
    shim_print_glyph, shim_raw_print, shim_raw_print_bold, shim_nhgetch,
    shim_nh_poskey, shim_nhbell, shim_doprev_message, shim_yn_function,
    shim_getlin, shim_get_ext_cmd, shim_number_pad, shim_delay_output,
    /* tty-specific leftovers */
    shim_start_screen, shim_end_screen, shim_outrip,
    genl_preference_update, genl_getmsghistory, genl_putmsghistory,
    genl_status_init, genl_status_finish, shim_status_enablefield,
    shim_status_update, genl_can_suspend_yes,
};

#endif /* STUB_GRAPHICS */
