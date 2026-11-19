/* FLECK -- oracle instrumentation implementation (phase 0).
 *
 * Everything here is inert unless the corresponding FLECK_* environment
 * variable is set; see include/fleck.h and docs/state-schema.md.
 * NetHack may be freely redistributed.  See license for details.
 */

#include "hack.h"
#include "fleck.h"

#include <stdarg.h>
#include <stdlib.h>
#include <string.h>

/* ------------------------------------------------------------------ */
/* environment switches (parsed once)                                  */

static int fleck_env_parsed = 0;
static boolean f_seed_on = FALSE;
static unsigned long f_seed = 0L;
static boolean f_date_on = FALSE;
static long f_date = 0L;
static const char *f_replay_path = (const char *) 0;
static const char *f_export_path = (const char *) 0;
static const char *f_rnglog_path = (const char *) 0;
static int f_disp_perturb = 0;      /* FLECK_DISP_PERTURB=<n>, phase-1 task 1 */
static int f_disp_perturb_done = 0;

static void
fleck_parse_env()
{
    const char *s;

    if (fleck_env_parsed)
        return;
    fleck_env_parsed = 1;

    if ((s = getenv("FLECK_SEED")) != (const char *) 0 && *s) {
        f_seed_on = TRUE;
        f_seed = strtoul(s, (char **) 0, 10);
    }
    if ((s = getenv("FLECK_DATE")) != (const char *) 0 && *s) {
        f_date_on = TRUE;
        f_date = strtol(s, (char **) 0, 10);
    }
    if ((s = getenv("FLECK_REPLAY")) != (const char *) 0 && *s)
        f_replay_path = s;
    if ((s = getenv("FLECK_EXPORT")) != (const char *) 0 && *s)
        f_export_path = s;
    if ((s = getenv("FLECK_RNGLOG")) != (const char *) 0 && *s)
        f_rnglog_path = s;
    if ((s = getenv("FLECK_DISP_PERTURB")) != (const char *) 0 && *s)
        f_disp_perturb = atoi(s);
}

/* Phase-1 task-1 perturbation experiment (docs/disp-audit.md): on the
   first call, draw and discard f_disp_perturb extra values from the
   display RNG stream.  Called from one audited pure-display call site
   (display_monster in display.c).  Completely inert when the
   FLECK_DISP_PERTURB environment variable is unset or <= 0. */
void
fleck_disp_perturb()
{
    int i;

    fleck_parse_env();
    if (f_disp_perturb <= 0 || f_disp_perturb_done)
        return;
    f_disp_perturb_done = 1;
    for (i = 0; i < f_disp_perturb; i++)
        (void) rn2_on_display_rng(997);
    fprintf(stderr, "FLECK: DISP perturbation drew %d extra value(s)\n",
            f_disp_perturb);
}

boolean
fleck_seed_enabled()
{
    fleck_parse_env();
    return f_seed_on;
}

/* Seed derivation (docs/oracle-survey.md section 1):
   CORE <- FLECK_SEED;  DISP <- FLECK_SEED ^ golden-ratio constant. */
unsigned long
fleck_seed_for(stream)
int stream;
{
    fleck_parse_env();
    if (stream == FLECK_STREAM_DISP)
        return f_seed ^ 0x9E3779B97F4A7C15UL;
    return f_seed;
}

boolean
fleck_date_enabled()
{
    fleck_parse_env();
    return f_date_on;
}

long
fleck_fixed_time()
{
    fleck_parse_env();
    return f_date;
}

/* ------------------------------------------------------------------ */
/* RNG audit log                                                       */

static FILE *f_rnglog_fp = (FILE *) 0;
static long f_rng_seq = 0L;

void
fleck_rng_log(fn, arg1, arg2, result)
const char *fn;
long arg1, arg2, result;
{
    fleck_parse_env();
    if (!f_rnglog_path)
        return;
    if (!f_rnglog_fp) {
        f_rnglog_fp = fopen(f_rnglog_path, "a");
        if (!f_rnglog_fp)
            return;
    }
    fprintf(f_rnglog_fp, "%ld %s %ld %ld %ld\n", ++f_rng_seq, fn, arg1,
            arg2, result);
    (void) fflush(f_rnglog_fp);
}

/* ------------------------------------------------------------------ */
/* replay input                                                        */

static FILE *f_replay_fp = (FILE *) 0;

boolean
fleck_replay_active()
{
    fleck_parse_env();
    return f_replay_path != (const char *) 0;
}

int
fleck_replay_getch()
{
    int c;

    fleck_parse_env();
    if (!f_replay_fp) {
        f_replay_fp = fopen(f_replay_path, "r");
        if (!f_replay_fp) {
            fprintf(stderr, "FLECK: cannot open replay file %s\n",
                    f_replay_path);
            exit(EXIT_FAILURE);
        }
    }
    c = fgetc(f_replay_fp);
    if (c == EOF) {
        /* Documented behaviour (docs/state-schema.md companions):
           exhausting the replay file terminates the game cleanly,
           with exit status 0 and no save written. */
        fprintf(stderr, "FLECK: replay exhausted; exiting.\n");
        exit(EXIT_SUCCESS);
    }
    return c;
}

/* ------------------------------------------------------------------ */
/* SHA-256 (FIPS 180-4), self-contained for the oracle side            */

typedef struct {
    unsigned int state[8];
    unsigned long long bits;
    unsigned char block[64];
    unsigned int blocklen;
} fleck_sha256_ctx;

static const unsigned int fleck_sha256_k[64] = {
    0x428a2f98U, 0x71374491U, 0xb5c0fbcfU, 0xe9b5dba5U, 0x3956c25bU,
    0x59f111f1U, 0x923f82a4U, 0xab1c5ed5U, 0xd807aa98U, 0x12835b01U,
    0x243185beU, 0x550c7dc3U, 0x72be5d74U, 0x80deb1feU, 0x9bdc06a7U,
    0xc19bf174U, 0xe49b69c1U, 0xefbe4786U, 0x0fc19dc6U, 0x240ca1ccU,
    0x2de92c6fU, 0x4a7484aaU, 0x5cb0a9dcU, 0x76f988daU, 0x983e5152U,
    0xa831c66dU, 0xb00327c8U, 0xbf597fc7U, 0xc6e00bf3U, 0xd5a79147U,
    0x06ca6351U, 0x14292967U, 0x27b70a85U, 0x2e1b2138U, 0x4d2c6dfcU,
    0x53380d13U, 0x650a7354U, 0x766a0abbU, 0x81c2c92eU, 0x92722c85U,
    0xa2bfe8a1U, 0xa81a664bU, 0xc24b8b70U, 0xc76c51a3U, 0xd192e819U,
    0xd6990624U, 0xf40e3585U, 0x106aa070U, 0x19a4c116U, 0x1e376c08U,
    0x2748774cU, 0x34b0bcb5U, 0x391c0cb3U, 0x4ed8aa4aU, 0x5b9cca4fU,
    0x682e6ff3U, 0x748f82eeU, 0x78a5636fU, 0x84c87814U, 0x8cc70208U,
    0x90befffaU, 0xa4506cebU, 0xbef9a3f7U, 0xc67178f2U
};

#define FLECK_RR(x, n) (((x) >> (n)) | ((x) << (32 - (n))))

static void
fleck_sha256_block(ctx, p)
fleck_sha256_ctx *ctx;
const unsigned char *p;
{
    unsigned int w[64];
    unsigned int a, b, c, d, e, f, g, h, t1, t2;
    int i;

    for (i = 0; i < 16; i++)
        w[i] = ((unsigned int) p[i * 4] << 24)
               | ((unsigned int) p[i * 4 + 1] << 16)
               | ((unsigned int) p[i * 4 + 2] << 8)
               | ((unsigned int) p[i * 4 + 3]);
    for (i = 16; i < 64; i++) {
        unsigned int s0 = FLECK_RR(w[i - 15], 7) ^ FLECK_RR(w[i - 15], 18)
                          ^ (w[i - 15] >> 3);
        unsigned int s1 = FLECK_RR(w[i - 2], 17) ^ FLECK_RR(w[i - 2], 19)
                          ^ (w[i - 2] >> 10);
        w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    a = ctx->state[0]; b = ctx->state[1]; c = ctx->state[2]; d = ctx->state[3];
    e = ctx->state[4]; f = ctx->state[5]; g = ctx->state[6]; h = ctx->state[7];
    for (i = 0; i < 64; i++) {
        unsigned int S1 = FLECK_RR(e, 6) ^ FLECK_RR(e, 11) ^ FLECK_RR(e, 25);
        unsigned int ch = (e & f) ^ (~e & g);
        unsigned int S0 = FLECK_RR(a, 2) ^ FLECK_RR(a, 13) ^ FLECK_RR(a, 22);
        unsigned int maj = (a & b) ^ (a & c) ^ (b & c);
        t1 = h + S1 + ch + fleck_sha256_k[i] + w[i];
        t2 = S0 + maj;
        h = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
    }
    ctx->state[0] += a; ctx->state[1] += b; ctx->state[2] += c;
    ctx->state[3] += d; ctx->state[4] += e; ctx->state[5] += f;
    ctx->state[6] += g; ctx->state[7] += h;
}

static void
fleck_sha256(data, len, hexout)
const char *data;
unsigned long len;
char *hexout; /* 65 bytes */
{
    fleck_sha256_ctx ctx;
    unsigned long i;
    int j;
    static const char hexdigits[] = "0123456789abcdef";

    ctx.state[0] = 0x6a09e667U; ctx.state[1] = 0xbb67ae85U;
    ctx.state[2] = 0x3c6ef372U; ctx.state[3] = 0xa54ff53aU;
    ctx.state[4] = 0x510e527fU; ctx.state[5] = 0x9b05688cU;
    ctx.state[6] = 0x1f83d9abU; ctx.state[7] = 0x5be0cd19U;
    ctx.bits = (unsigned long long) len * 8ULL;
    ctx.blocklen = 0;

    for (i = 0; i < len; i++) {
        ctx.block[ctx.blocklen++] = (unsigned char) data[i];
        if (ctx.blocklen == 64) {
            fleck_sha256_block(&ctx, ctx.block);
            ctx.blocklen = 0;
        }
    }
    ctx.block[ctx.blocklen++] = 0x80;
    if (ctx.blocklen > 56) {
        while (ctx.blocklen < 64)
            ctx.block[ctx.blocklen++] = 0;
        fleck_sha256_block(&ctx, ctx.block);
        ctx.blocklen = 0;
    }
    while (ctx.blocklen < 56)
        ctx.block[ctx.blocklen++] = 0;
    for (j = 7; j >= 0; j--)
        ctx.block[ctx.blocklen++] =
            (unsigned char) ((ctx.bits >> (j * 8)) & 0xffU);
    fleck_sha256_block(&ctx, ctx.block);

    for (j = 0; j < 8; j++) {
        hexout[j * 8] = hexdigits[(ctx.state[j] >> 28) & 0xf];
        hexout[j * 8 + 1] = hexdigits[(ctx.state[j] >> 24) & 0xf];
        hexout[j * 8 + 2] = hexdigits[(ctx.state[j] >> 20) & 0xf];
        hexout[j * 8 + 3] = hexdigits[(ctx.state[j] >> 16) & 0xf];
        hexout[j * 8 + 4] = hexdigits[(ctx.state[j] >> 12) & 0xf];
        hexout[j * 8 + 5] = hexdigits[(ctx.state[j] >> 8) & 0xf];
        hexout[j * 8 + 6] = hexdigits[(ctx.state[j] >> 4) & 0xf];
        hexout[j * 8 + 7] = hexdigits[ctx.state[j] & 0xf];
    }
    hexout[64] = '\0';
}

/* ------------------------------------------------------------------ */
/* growable string buffer for canonical serialization                  */

typedef struct {
    char *buf;
    unsigned long len, cap;
} fleck_sbuf;

static void
fleck_sb_init(sb)
fleck_sbuf *sb;
{
    sb->cap = 4096;
    sb->len = 0;
    sb->buf = (char *) malloc((unsigned) sb->cap);
    sb->buf[0] = '\0';
}

static void
fleck_sb_free(sb)
fleck_sbuf *sb;
{
    free(sb->buf);
    sb->buf = (char *) 0;
    sb->len = sb->cap = 0;
}

static void
fleck_sb_addn(sb, s, n)
fleck_sbuf *sb;
const char *s;
unsigned long n;
{
    if (sb->len + n + 1 > sb->cap) {
        while (sb->len + n + 1 > sb->cap)
            sb->cap *= 2;
        sb->buf = (char *) realloc(sb->buf, (unsigned) sb->cap);
    }
    memcpy(sb->buf + sb->len, s, (unsigned) n);
    sb->len += n;
    sb->buf[sb->len] = '\0';
}

static void
fleck_sb_add(sb, s)
fleck_sbuf *sb;
const char *s;
{
    fleck_sb_addn(sb, s, (unsigned long) strlen(s));
}

static void
fleck_sb_printf(fleck_sbuf *sb, const char *fmt, ...)
{
    char tmp[1024];
    va_list ap;

    va_start(ap, fmt);
    (void) vsnprintf(tmp, sizeof tmp, fmt, ap);
    va_end(ap);
    fleck_sb_add(sb, tmp);
}

/* ------------------------------------------------------------------ */
/* canonical state export (docs/state-schema.md)                       */

static FILE *f_export_fp = (FILE *) 0;
static long f_frame_idx = 0L;
static int f_turn_pending = 0;

boolean
fleck_export_enabled()
{
    fleck_parse_env();
    return f_export_path != (const char *) 0;
}

void
fleck_note_turn()
{
    f_turn_pending = 1;
}

struct fleck_monrow {
    int mnum, x, y, hp, hpmax, tame, peaceful, sleeping, stun, conf,
        canmove, flee, mux, muy; /* mux/muy added in schema v1.1 */
};
struct fleck_itemrow {
    int filled; /* inventory rows: letter in 'letter' instead of x/y */
    int x, y;
    int letter;
    int otyp;
    long quan;
    int buc, spe, corpsenm, lamplit;
    long worn;
};
struct fleck_traprow {
    int x, y, ttyp, tseen;
    int dst_dnum, dst_dlevel; /* schema v1.4: MAGIC_PORTAL destination */
};

static int
fleck_cmp_mon(a, b)
const void *a, *b;
{
    const struct fleck_monrow *ma = (const struct fleck_monrow *) a;
    const struct fleck_monrow *mb = (const struct fleck_monrow *) b;
    if (ma->x != mb->x) return ma->x - mb->x;
    if (ma->y != mb->y) return ma->y - mb->y;
    if (ma->mnum != mb->mnum) return ma->mnum - mb->mnum;
    return ma->hp - mb->hp;
}

static int
fleck_cmp_item(a, b)
const void *a, *b;
{
    const struct fleck_itemrow *ia = (const struct fleck_itemrow *) a;
    const struct fleck_itemrow *ib = (const struct fleck_itemrow *) b;
    if (ia->x != ib->x) return ia->x - ib->x;
    if (ia->y != ib->y) return ia->y - ib->y;
    if (ia->otyp != ib->otyp) return ia->otyp - ib->otyp;
    if (ia->spe != ib->spe) return ia->spe - ib->spe;
    if (ia->corpsenm != ib->corpsenm) return ia->corpsenm - ib->corpsenm;
    if (ia->quan != ib->quan) return ia->quan < ib->quan ? -1 : 1;
    if (ia->buc != ib->buc) return ia->buc - ib->buc;
    return ia->lamplit - ib->lamplit;
}

static int
fleck_cmp_trap(a, b)
const void *a, *b;
{
    const struct fleck_traprow *ta = (const struct fleck_traprow *) a;
    const struct fleck_traprow *tb = (const struct fleck_traprow *) b;
    if (ta->x != tb->x) return ta->x - tb->x;
    if (ta->y != tb->y) return ta->y - tb->y;
    return ta->ttyp - tb->ttyp;
}

static int
fleck_cmp_inv(a, b)
const void *a, *b;
{
    const struct fleck_itemrow *ia = (const struct fleck_itemrow *) a;
    const struct fleck_itemrow *ib = (const struct fleck_itemrow *) b;
    return ia->letter - ib->letter;
}

static int
fleck_buc(otmp)
struct obj *otmp;
{
    return otmp->blessed ? 2 : (otmp->cursed ? 0 : 1);
}

static void
fleck_fill_itemrow(row, otmp)
struct fleck_itemrow *row;
struct obj *otmp;
{
    row->otyp = (int) otmp->otyp;
    row->quan = otmp->quan;
    row->buc = fleck_buc(otmp);
    row->spe = (int) otmp->spe;
    row->corpsenm = otmp->corpsenm;
    row->lamplit = otmp->lamplit ? 1 : 0;
    row->worn = 0L;
}

static void
fleck_export_frame()
{
    fleck_sbuf hero, layout, mons, items, inv, frame, hashin;
    char hero_hash[65], layout_hash[65], mons_hash[65], items_hash[65],
        inv_hash[65], frame_hash[65];
    int x, y, i;
    struct monst *mtmp;
    struct obj *otmp;
    struct trap *ttmp;
    struct fleck_monrow *monrows;
    struct fleck_itemrow *itemrows, *invrows;
    struct fleck_traprow *traprows;
    int nmon, nitem, ninv, ntrap, cap;

    if (!f_export_fp) {
        f_export_fp = fopen(f_export_path, "a");
        if (!f_export_fp)
            return;
    }

    /* ---- hero ---- */
    fleck_sb_init(&hero);
    fleck_sb_printf(&hero, "role=%d race=%d gender=%d align=%d\n",
                    flags.initrole, flags.initrace, flags.initgend,
                    flags.initalign);
    fleck_sb_printf(&hero, "form=%d x=%d y=%d dnum=%d dlevel=%d moves=%ld\n",
                    u.umonnum, (int) u.ux, (int) u.uy, (int) u.uz.dnum,
                    (int) u.uz.dlevel, moves);
    fleck_sb_printf(&hero, "hp=%d hpmax=%d pw=%d pwmax=%d ac=%d\n",
                    Upolyd ? u.mh : u.uhp, Upolyd ? u.mhmax : u.uhpmax,
                    u.uen, u.uenmax, (int) u.uac);
    fleck_sb_printf(&hero, "xl=%d exp=%ld hunger=%d luck=%d\n", u.ulevel,
                    u.uexp, u.uhunger, (int) Luck);
    fleck_sb_printf(&hero, "attr=%d,%d,%d,%d,%d,%d\n", ACURR(A_STR),
                    ACURR(A_INT), ACURR(A_WIS), ACURR(A_DEX), ACURR(A_CON),
                    ACURR(A_CHA));
    fleck_sb_printf(&hero, "gold=%ld\n", money_cnt(invent));
    /* schema v1.2 (phase 4): current dungeon depth */
    fleck_sb_printf(&hero, "dunlev=%d\n", depth(&u.uz));
    /* schema v1.4: effective encumbrance tier (near_capacity(),
       hack.c) and effective hero condition bits in the frozen order
       blind, conf, stun, hallu, strangled, vomit, legs, deaf -- each
       is the youprop.h effective-value macro the game logic tests. */
    fleck_sb_printf(&hero, "burden=%d\n", near_capacity());
    fleck_sb_printf(&hero, "cond=%d,%d,%d,%d,%d,%d,%d,%d\n",
                    Blind ? 1 : 0, Confusion ? 1 : 0, Stunned ? 1 : 0,
                    Hallucination ? 1 : 0, Strangled ? 1 : 0,
                    Vomiting ? 1 : 0, Wounded_legs ? 1 : 0, Deaf ? 1 : 0);
    fleck_sha256(hero.buf, hero.len, hero_hash);

    /* ---- level-layout ---- */
    fleck_sb_init(&layout);
    fleck_sb_add(&layout, "grid\n");
    for (y = 0; y < ROWNO; y++) {
        for (x = 0; x < COLNO; x++) {
            if (x)
                fleck_sb_add(&layout, " ");
            fleck_sb_printf(&layout, "%d", (int) levl[x][y].typ);
        }
        fleck_sb_add(&layout, "\n");
    }
    fleck_sb_add(&layout, "doors\n");
    for (x = 0; x < COLNO; x++)
        for (y = 0; y < ROWNO; y++)
            if (levl[x][y].typ == DOOR || levl[x][y].typ == SDOOR)
                fleck_sb_printf(&layout, "%d %d %d\n", x, y,
                                (int) levl[x][y].flags);
    fleck_sb_add(&layout, "traps\n");
    ntrap = 0;
    for (ttmp = ftrap; ttmp; ttmp = ttmp->ntrap)
        ntrap++;
    traprows = (struct fleck_traprow *)
        malloc(sizeof (struct fleck_traprow) * (unsigned) (ntrap + 1));
    i = 0;
    for (ttmp = ftrap; ttmp; ttmp = ttmp->ntrap) {
        traprows[i].x = (int) ttmp->tx;
        traprows[i].y = (int) ttmp->ty;
        traprows[i].ttyp = (int) ttmp->ttyp;
        traprows[i].tseen = ttmp->tseen ? 1 : 0;
        /* schema v1.4: portal destination (trap->dst, trap.h) */
        traprows[i].dst_dnum = (int) ttmp->dst.dnum;
        traprows[i].dst_dlevel = (int) ttmp->dst.dlevel;
        i++;
    }
    qsort(traprows, (unsigned) ntrap, sizeof (struct fleck_traprow),
          fleck_cmp_trap);
    for (i = 0; i < ntrap; i++) {
        if (traprows[i].ttyp == MAGIC_PORTAL)
            fleck_sb_printf(&layout, "%d %d %d %d %d %d\n", traprows[i].x,
                            traprows[i].y, traprows[i].ttyp,
                            traprows[i].tseen, traprows[i].dst_dnum,
                            traprows[i].dst_dlevel);
        else
            fleck_sb_printf(&layout, "%d %d %d %d\n", traprows[i].x,
                            traprows[i].y, traprows[i].ttyp,
                            traprows[i].tseen);
    }
    free(traprows);
    /* schema v1.4: altars sub-block (after traps): altar alignment
       from levl altarmask with the shrine bit masked out, converted
       with Amask2align (aligntyp values). */
    fleck_sb_add(&layout, "altars\n");
    for (x = 0; x < COLNO; x++)
        for (y = 0; y < ROWNO; y++)
            if (levl[x][y].typ == ALTAR)
                fleck_sb_printf(&layout, "%d %d %d\n", x, y,
                                (int) Amask2align(levl[x][y].altarmask
                                                  & AM_MASK));
    fleck_sha256(layout.buf, layout.len, layout_hash);

    /* ---- monsters ---- */
    fleck_sb_init(&mons);
    nmon = 0;
    for (mtmp = fmon; mtmp; mtmp = mtmp->nmon)
        nmon++;
    monrows = (struct fleck_monrow *)
        malloc(sizeof (struct fleck_monrow) * (unsigned) (nmon + 1));
    i = 0;
    for (mtmp = fmon; mtmp; mtmp = mtmp->nmon) {
        monrows[i].mnum = (int) mtmp->mnum;
        monrows[i].x = (int) mtmp->mx;
        monrows[i].y = (int) mtmp->my;
        monrows[i].hp = mtmp->mhp;
        monrows[i].hpmax = mtmp->mhpmax;
        monrows[i].tame = (int) mtmp->mtame;
        monrows[i].peaceful = mtmp->mpeaceful ? 1 : 0;
        monrows[i].sleeping = mtmp->msleeping ? 1 : 0;
        monrows[i].stun = mtmp->mstun ? 1 : 0;
        monrows[i].conf = mtmp->mconf ? 1 : 0;
        monrows[i].canmove = mtmp->mcanmove ? 1 : 0;
        monrows[i].flee = mtmp->mflee ? 1 : 0;
        monrows[i].mux = (int) mtmp->mux; /* schema v1.1 */
        monrows[i].muy = (int) mtmp->muy;
        i++;
    }
    qsort(monrows, (unsigned) nmon, sizeof (struct fleck_monrow),
          fleck_cmp_mon);
    for (i = 0; i < nmon; i++)
        fleck_sb_printf(&mons, "%d %d %d %d %d %d %d %d %d %d %d %d %d %d\n",
                        monrows[i].mnum, monrows[i].x, monrows[i].y,
                        monrows[i].hp, monrows[i].hpmax, monrows[i].tame,
                        monrows[i].peaceful, monrows[i].sleeping,
                        monrows[i].stun, monrows[i].conf, monrows[i].canmove,
                        monrows[i].flee, monrows[i].mux, monrows[i].muy);
    free(monrows);
    fleck_sha256(mons.buf, mons.len, mons_hash);

    /* ---- floor items ---- */
    fleck_sb_init(&items);
    cap = 64;
    nitem = 0;
    itemrows = (struct fleck_itemrow *)
        malloc(sizeof (struct fleck_itemrow) * (unsigned) cap);
    for (x = 0; x < COLNO; x++)
        for (y = 0; y < ROWNO; y++)
            for (otmp = level.objects[x][y]; otmp; otmp = otmp->nexthere) {
                if (nitem >= cap) {
                    cap *= 2;
                    itemrows = (struct fleck_itemrow *) realloc(
                        itemrows,
                        sizeof (struct fleck_itemrow) * (unsigned) cap);
                }
                fleck_fill_itemrow(&itemrows[nitem], otmp);
                itemrows[nitem].x = x;
                itemrows[nitem].y = y;
                itemrows[nitem].letter = 0;
                nitem++;
            }
    qsort(itemrows, (unsigned) nitem, sizeof (struct fleck_itemrow),
          fleck_cmp_item);
    for (i = 0; i < nitem; i++)
        fleck_sb_printf(&items, "%d %d %d %ld %d %d %d %d\n", itemrows[i].x,
                        itemrows[i].y, itemrows[i].otyp,
                        itemrows[i].quan, itemrows[i].buc, itemrows[i].spe,
                        itemrows[i].corpsenm, itemrows[i].lamplit);
    free(itemrows);
    fleck_sha256(items.buf, items.len, items_hash);

    /* ---- hero inventory ---- */
    fleck_sb_init(&inv);
    cap = 64;
    ninv = 0;
    invrows = (struct fleck_itemrow *)
        malloc(sizeof (struct fleck_itemrow) * (unsigned) cap);
    for (otmp = invent; otmp; otmp = otmp->nobj) {
        if (ninv >= cap) {
            cap *= 2;
            invrows = (struct fleck_itemrow *) realloc(
                invrows, sizeof (struct fleck_itemrow) * (unsigned) cap);
        }
        fleck_fill_itemrow(&invrows[ninv], otmp);
        invrows[ninv].letter = (int) (unsigned char) otmp->invlet;
        invrows[ninv].worn = otmp->owornmask;
        ninv++;
    }
    qsort(invrows, (unsigned) ninv, sizeof (struct fleck_itemrow),
          fleck_cmp_inv);
    for (i = 0; i < ninv; i++)
        fleck_sb_printf(&inv, "%c %d %ld %d %d %d %d %ld\n",
                        invrows[i].letter, invrows[i].otyp, invrows[i].quan,
                        invrows[i].buc, invrows[i].spe, invrows[i].corpsenm,
                        invrows[i].lamplit, invrows[i].worn);
    free(invrows);
    fleck_sha256(inv.buf, inv.len, inv_hash);

    /* ---- frame assembly ---- */
    fleck_sb_init(&hashin);
    fleck_sb_printf(&hashin, "turn=%ld\n", moves);
    fleck_sb_printf(&hashin, "%s\n%s\n%s\n%s\n%s\n", hero_hash, layout_hash,
                    mons_hash, items_hash, inv_hash);
    fleck_sha256(hashin.buf, hashin.len, frame_hash);
    fleck_sb_free(&hashin);

    fleck_sb_init(&frame);
    fleck_sb_printf(&frame, "frame %ld\n", f_frame_idx++);
    fleck_sb_printf(&frame, "turn %ld\n", moves);
    fleck_sb_add(&frame, "[hero]\n");
    fleck_sb_addn(&frame, hero.buf, hero.len);
    fleck_sb_printf(&frame, "hash=%s\n", hero_hash);
    fleck_sb_add(&frame, "[level-layout]\n");
    fleck_sb_addn(&frame, layout.buf, layout.len);
    fleck_sb_printf(&frame, "hash=%s\n", layout_hash);
    fleck_sb_add(&frame, "[monsters]\n");
    fleck_sb_addn(&frame, mons.buf, mons.len);
    fleck_sb_printf(&frame, "hash=%s\n", mons_hash);
    fleck_sb_add(&frame, "[items]\n");
    fleck_sb_addn(&frame, items.buf, items.len);
    fleck_sb_printf(&frame, "hash=%s\n", items_hash);
    fleck_sb_add(&frame, "[inventory]\n");
    fleck_sb_addn(&frame, inv.buf, inv.len);
    fleck_sb_printf(&frame, "hash=%s\n", inv_hash);
    fleck_sb_printf(&frame, "framehash=%s\n", frame_hash);
    fleck_sb_add(&frame, "end\n");

    (void) fwrite(frame.buf, 1, (unsigned) frame.len, f_export_fp);
    (void) fflush(f_export_fp);

    fleck_sb_free(&hero);
    fleck_sb_free(&layout);
    fleck_sb_free(&mons);
    fleck_sb_free(&items);
    fleck_sb_free(&inv);
    fleck_sb_free(&frame);
}

void
fleck_export_initial()
{
    if (fleck_export_enabled())
        fleck_export_frame();
}

void
fleck_export_after_turn()
{
    if (f_turn_pending) {
        f_turn_pending = 0;
        if (fleck_export_enabled())
            fleck_export_frame();
    }
}

/*fleck.c*/
