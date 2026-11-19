/* NetHack 3.6  winstub.c -- airstring S1 build spike */
/* Minimal stub window port for the WASM cross-build feasibility spike.
 * Written for airstring (2026-11-19); NetHack may be freely
 * redistributed.  See license for details.
 *
 * Purpose: satisfy the window_procs interface with no-ops so the game
 * links and starts under Emscripten/Node, and prove that execution
 * reaches the window port's key-read entry points.  stub_nhgetch()
 * feeds a fixed script of keys, logs every call to stderr, and exits
 * the process cleanly once the script is exhausted (mirroring the
 * fleck replay-EOF semantics: clean exit, status 0, no save written).
 * This is a spike harness, not a playable port; S2 replaces it with
 * the real structured-output shim.
 */

#include "hack.h"

#ifdef STUB_GRAPHICS

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ------------------------------------------------------------------ */
/* key feeder                                                          */

static const char stub_key_script[] =
    "        " /* spaces: dismiss intro --More-- pagers */
    "........" /* wait moves */
    "........"
    "........"
    "........";
static unsigned long stub_key_pos = 0;
static unsigned long stub_getch_count = 0;

static int
stub_next_key()
{
    int c;

    stub_getch_count++;
    if (stub_key_pos < sizeof(stub_key_script) - 1) {
        c = (unsigned char) stub_key_script[stub_key_pos++];
        fprintf(stderr, "[stub] nhgetch #%lu -> '%c' (0x%02x)\n",
                stub_getch_count, (c >= 32 && c < 127) ? c : '?', c);
        return c;
    }
    fprintf(stderr,
            "[stub] nhgetch #%lu: script exhausted, exiting cleanly\n",
            stub_getch_count);
    fflush(stderr);
    exit(EXIT_SUCCESS);
    return 0; /* not reached */
}

/* ------------------------------------------------------------------ */
/* window bookkeeping (ids only; nothing is rendered)                  */

#define STUB_MAXWIN 32
static int stub_win_types[STUB_MAXWIN];
static winid stub_next_winid = 1;

static int
stub_win_type(winid wid)
{
    if (wid < 1 || wid >= STUB_MAXWIN)
        return -1;
    return stub_win_types[wid];
}

/* ------------------------------------------------------------------ */
/* port functions                                                      */

static void
stub_init_nhwindows(argcp, argv)
int *argcp UNUSED;
char **argv UNUSED;
{
    fprintf(stderr, "[stub] init_nhwindows\n");
}

static void
stub_player_selection()
{
    /* Role/race/gender/align are pinned via NETHACKOPTIONS in the S1
     * harness, so there is nothing to prompt for.  If a field was left
     * unspecified, role_init() (called later by newgame) randomizes
     * it, which is acceptable for the spike. */
    fprintf(stderr, "[stub] player_selection (no-op; options pinned)\n");
}

static void
stub_askname()
{
    Strcpy(plname, "s1spike");
    fprintf(stderr, "[stub] askname -> \"%s\"\n", plname);
}

static void
stub_get_nh_event()
{
}

static void
stub_exit_nhwindows(str)
const char *str UNUSED;
{
    fprintf(stderr, "[stub] exit_nhwindows\n");
}

static void
stub_suspend_nhwindows(str)
const char *str UNUSED;
{
}

static void
stub_resume_nhwindows()
{
}

static winid
stub_create_nhwindow(type)
int type;
{
    winid wid = stub_next_winid++;

    if (wid < STUB_MAXWIN)
        stub_win_types[wid] = type;
    fprintf(stderr, "[stub] create_nhwindow type=%d -> %d\n", type,
            (int) wid);
    return wid;
}

static void
stub_clear_nhwindow(wid)
winid wid UNUSED;
{
}

static void
stub_display_nhwindow(wid, blocking)
winid wid UNUSED;
boolean blocking;
{
    /* Real ports wait for a key here when blocking is TRUE; that wait
     * is what dismisses --More-- and text pagers.  Mirror it so the
     * startup flow advances exactly as it would interactively. */
    if (blocking) {
        fprintf(stderr, "[stub] display_nhwindow(blocking) -> key\n");
        (void) stub_next_key();
    }
}

static void
stub_destroy_nhwindow(wid)
winid wid UNUSED;
{
}

static void
stub_curs(wid, x, y)
winid wid UNUSED;
int x UNUSED;
int y UNUSED;
{
}

static void
stub_putstr(wid, attr, str)
winid wid;
int attr UNUSED;
const char *str;
{
    /* Keep message-window text visible as run evidence; drop the
     * rest (map/status are glyph/status driven, not putstr). */
    if (stub_win_type(wid) == NHW_MESSAGE && str)
        fprintf(stderr, "[stub] msg: %s\n", str);
}

static void
stub_display_file(str, complain)
const char *str UNUSED;
boolean complain UNUSED;
{
}

static void
stub_start_menu(wid)
winid wid UNUSED;
{
}

static void
stub_add_menu(wid, glyph, any, ch, gch, attr, str, preselected)
winid wid UNUSED;
int glyph UNUSED;
const ANY_P *any UNUSED;
CHAR_P ch UNUSED;
CHAR_P gch UNUSED;
int attr UNUSED;
const char *str UNUSED;
BOOLEAN_P preselected UNUSED;
{
}

static void
stub_end_menu(wid, prompt)
winid wid UNUSED;
const char *prompt UNUSED;
{
}

static int
stub_select_menu(wid, how, selected)
winid wid UNUSED;
int how UNUSED;
MENU_ITEM_P **selected;
{
    if (selected)
        *selected = (MENU_ITEM_P *) 0;
    return 0; /* nothing selected (treated as cancelled) */
}

static char
stub_message_menu(let, how, mesg)
CHAR_P let UNUSED;
int how UNUSED;
const char *mesg UNUSED;
{
    return '\033';
}

static void
stub_update_inventory()
{
}

static void
stub_mark_synch()
{
}

static void
stub_wait_synch()
{
}

#ifdef CLIPPING
static void
stub_cliparound(x, y)
int x UNUSED;
int y UNUSED;
{
}
#endif

#ifdef POSITIONBAR
static void
stub_update_positionbar(posbar)
char *posbar UNUSED;
{
}
#endif

static void
stub_print_glyph(wid, x, y, glyph, bkglyph)
winid wid UNUSED;
XCHAR_P x UNUSED;
XCHAR_P y UNUSED;
int glyph UNUSED;
int bkglyph UNUSED;
{
}

static void
stub_raw_print(str)
const char *str;
{
    if (str)
        fprintf(stderr, "[stub] raw: %s\n", str);
}

static void
stub_raw_print_bold(str)
const char *str;
{
    stub_raw_print(str);
}

static int
stub_nhgetch()
{
    return stub_next_key();
}

static int
stub_nh_poskey(x, y, mod)
int *x, *y, *mod;
{
    if (x)
        *x = 0;
    if (y)
        *y = 0;
    if (mod)
        *mod = 0;
    return stub_next_key();
}

static void
stub_nhbell()
{
}

static int
stub_doprev_message()
{
    return 0;
}

static char
stub_yn_function(question, choices, def)
const char *question UNUSED;
const char *choices UNUSED;
CHAR_P def;
{
    char ans = def ? (char) def : 'y';

    fprintf(stderr, "[stub] yn_function -> '%c'\n", ans);
    return ans;
}

static void
stub_getlin(question, buf)
const char *question UNUSED;
char *buf;
{
    Strcpy(buf, "s1spike");
    fprintf(stderr, "[stub] getlin -> \"%s\"\n", buf);
}

static int
stub_get_ext_cmd()
{
    return -1; /* cancelled */
}

static void
stub_number_pad(state)
int state UNUSED;
{
}

static void
stub_delay_output()
{
}

static void
stub_start_screen()
{
}

static void
stub_end_screen()
{
}

static void
stub_outrip(wid, how, when)
winid wid UNUSED;
int how UNUSED;
time_t when UNUSED;
{
    /* genl_outrip only exists when TEXT_TOMBSTONE is enabled (rip.c
     * keys it off the graphical ports / DUMPLOG); the stub port
     * provides its own no-op instead. */
}

static void
stub_status_enablefield(idx, nm, fmt, enable)
int idx UNUSED;
const char *nm UNUSED;
const char *fmt UNUSED;
BOOLEAN_P enable UNUSED;
{
}

/* ------------------------------------------------------------------ */

struct window_procs stub_procs = {
    "stub",
    0, /* wincap */
    0, /* wincap2 */
    { 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1 },
    stub_init_nhwindows, stub_player_selection, stub_askname,
    stub_get_nh_event, stub_exit_nhwindows, stub_suspend_nhwindows,
    stub_resume_nhwindows, stub_create_nhwindow, stub_clear_nhwindow,
    stub_display_nhwindow, stub_destroy_nhwindow, stub_curs,
    stub_putstr, genl_putmixed, stub_display_file, stub_start_menu,
    stub_add_menu, stub_end_menu, stub_select_menu, stub_message_menu,
    stub_update_inventory, stub_mark_synch, stub_wait_synch,
#ifdef CLIPPING
    stub_cliparound,
#endif
#ifdef POSITIONBAR
    stub_update_positionbar,
#endif
    stub_print_glyph, stub_raw_print, stub_raw_print_bold, stub_nhgetch,
    stub_nh_poskey, stub_nhbell, stub_doprev_message, stub_yn_function,
    stub_getlin, stub_get_ext_cmd, stub_number_pad, stub_delay_output,
    /* tty-specific leftovers */
    stub_start_screen, stub_end_screen, stub_outrip,
    genl_preference_update, genl_getmsghistory, genl_putmsghistory,
    genl_status_init, genl_status_finish, stub_status_enablefield,
    genl_status_update, genl_can_suspend_yes,
};

#endif /* STUB_GRAPHICS */
