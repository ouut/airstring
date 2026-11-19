/* FLECK -- oracle instrumentation interface (phase 0).
 *
 * All instrumentation is switched by environment variables with the
 * FLECK_ prefix and is completely inert when they are unset:
 *   FLECK_SEED=<u64>    pin both RNG streams to seeds derived from <u64>
 *   FLECK_DATE=<unix>   pin getnow() (and ubirthday) to a fixed timestamp
 *   FLECK_REPLAY=<file> read key input from <file> instead of the tty
 *   FLECK_EXPORT=<file> append a canonical state frame per player turn
 *   FLECK_RNGLOG=<file> append one audit line per public RNG entry call
 *
 * See docs/phase0-spec.md, docs/oracle-survey.md, docs/state-schema.md.
 * NetHack may be freely redistributed.  See license for details.
 */
#ifndef FLECK_H
#define FLECK_H

/* FLECK_SEED: stream selectors for fleck_seed_for() */
#define FLECK_STREAM_CORE 0 /* rn2() and everything through RND() */
#define FLECK_STREAM_DISP 1 /* rn2_on_display_rng() */

boolean fleck_seed_enabled(void);
unsigned long fleck_seed_for(int stream);

boolean fleck_date_enabled(void);
long fleck_fixed_time(void);

/* append one line to the RNG audit log if FLECK_RNGLOG is set;
   arg2 is -1 for single-argument entries (all but d(n,x)) */
void fleck_rng_log(const char *fn, long arg1, long arg2, long result);

/* replay input: fleck_replay_getch() is only called when active;
   on EOF of the replay file it terminates the process cleanly */
boolean fleck_replay_active(void);
int fleck_replay_getch(void);

/* turn export: fleck_note_turn() is called once per moves increment;
   fleck_export_after_turn() is called at the end of the moveloop
   time-passage block and writes a frame iff a turn was noted;
   fleck_export_initial() writes the frame-0 (initial state) */
/* phase-1 task-1 perturbation experiment (docs/disp-audit.md):
   fleck_disp_perturb() is a no-op unless FLECK_DISP_PERTURB=<n> is set,
   in which case its first invocation draws (and discards) n extra values
   from the display RNG stream */
void fleck_disp_perturb(void);

boolean fleck_export_enabled(void);
void fleck_note_turn(void);
void fleck_export_initial(void);
void fleck_export_after_turn(void);

#endif /* FLECK_H */
