# `tools/` — reference implementation

`session-signals.cjs` scores a session from **L0 to L4** using the criteria described in
[PROTOCOL.md](../PROTOCOL.md), by reading session logs. It is the instrument we used to produce
[FINDINGS.md](../FINDINGS.md).

> ⚠️ **This implementation is DSH-specific.** It reads DSH's session logs
> (`~/.dsh/sessions/**/session.v4.jsonl.zstd`, multi-frame zstd) and DSH's project cache.
> The *criteria* are portable; the *file formats* are not. Porting it to another harness means
> replacing two functions: `collect()` and `analyze()`.

## Usage

```bash
node session-signals.cjs                 # compact, exactly 2 lines (for a session-start hook)
node session-signals.cjs --full          # full table + the reasoning behind every threshold
node session-signals.cjs --self-test     # 23 assertions on synthetic logs (never touches real data)
node session-signals.cjs --verify-cache  # audit the cache: recompute 5 sessions and compare
node session-signals.cjs --json          # machine-readable
```

Options: `--dir <path>` (session root), `--me <id>` (mark "this session"), `--tier1/--tier2 <MB>`
(context-size tiers), `--thresh <N>`, `--recent <H>`, `--no-cache`, `--no-titles`.

## What it measures

| Signal | How | Threshold used |
|---|---|---|
| **self-pressure trend** | count of *quick / now / immediately / must / don't ramble* per 1k chars of reasoning; compare last quintile to first (≥10 turns only) | ≥ 3× **and** last-quintile density ≥ 1.0/1k |
| **stalls** | turns whose final step has reasoning but no text/tool call; clustered into episodes (gap ≤ 3 turns, ≥ 2 stalls per cluster) | stage L3 when a 2nd episode appears or an episode has not remitted for 5 turns |
| **self-prompt loops** | max repeats of the same ≤6-char line inside one reasoning block, after stripping fenced code | ≥ 30 → L3; ≥ 100 → L4 |
| **context size** | compressed log bytes (tiers) | reported for *visibility only* — **not** a risk score |

> ⚠️ **The `≥ 30 → L3` half of the loop rule is a mistake, kept here for honesty.**
> A `maxRep` threshold can identify a **block** that is repeating (that is the L4 case: the block
> repeated *and delivered nothing* — it proves its own failure). It **cannot** advance a **session's**
> stage: repeat count and stall rate are uncorrelated (r = −0.0076), and a live session with **zero
> episodes** was once scored L3 purely because one **healthy, fully delivered** 6,178-character block
> contained 63 repetitions of its own punctuation word. See **`../FINDINGS.md` §12**.
> ⇒ **Use the episode rule for session staging. Do not copy the `maxRep` line.**

## Notes from building it

Four traps we hit, all of which cost real debugging time:

1. **Multi-frame zstd.** `zstdDecompressSync` decodes only the first frame. Cut frames on the magic
   bytes `28 B5 2F FD`; when a cut fails, extend to the next magic instead of discarding — the
   magic sequence can occur *inside* compressed data, and a naive split silently drops a whole frame.
2. **Fenced code blocks.** Without stripping them, a JSON `}` is the most-repeated "short line" in
   every session, and every session looks terminally ill.
3. **Bigger tool results are not the cause.** We checked: median result size before a stall was
   1853 chars vs 1269 before a normal step — a 1.46× difference, far too weak to use.
4. **A cache is part of your criterion.** File-size-keyed caching is safe (logs are append-only),
   but the cache **version must change whenever the algorithm or a threshold does** — otherwise a
   stale entry reports yesterday's score with today's rules. We shipped that bug and caught it.

## Boundaries

- Thresholds are separation bands measured on **one machine** (~400 sessions). Re-measure before
  trusting them, and prefer `--full` output (which prints the raw numbers) over the grade.
- The tool **does not diagnose anything**. It reports observations, and its own output says so.
- `--self-test` builds synthetic logs in a temp dir and removes them; it never reads or writes your
  real session data.

## "Already finished" sessions are not reported (the `rested` mechanism)

Every long-running monitor hits the same trap: **the alert only asks "is there an anomaly in
the logs?", never "is this subject still alive?"** — so a session that has ended keeps being
reported forever, and each newcomer assumes it is *still* struggling.

> **Design rule: the lifetime of a signal must match the lifetime of the thing it signals.**

This implementation reads a local roster (DSH keeps one) to learn which sessions have finished:

- they are **excluded from the human-facing summary** (the two-line startup output);
- they are **kept in `--json`**, each entry gaining `"rested": true` —
  *the raw data stays complete; only the display layer filters*;
- if the roster cannot be read, it falls back to the old behaviour and **reports more, never
  less** (when uncertain, always choose the conservative side).

---

## Corpus survey scripts (added 2026-10-18)

`session-signals.cjs` scores **one** session. These four scan a **whole session store** and answer
population questions — what is normal, what is rare, and whether two signals move together.

| script | measures | output |
|---|---|---|
| `spell-survey.cjs` | longest repeat of a short line (≤6 chars, inside one reasoning block, fenced code stripped) | one row per session |
| `two-axes-survey.cjs` | the same repeat **plus** the stall rate, per session | one row per session |
| `blocklen-survey.cjs` | longest single reasoning block, in characters | one row per session |
| **`block-repeats.cjs`** | the longest repeated short line **per session**, with turn/step, block size, and **whether that block emitted any text or tool call** — the tool behind `../FINDINGS.md` §11 and §13 | a top-N table on stdout (`--min`, `--top`, `--recent`, or one log path) |

Run the three surveys with `node <script> --out <file.tsv>`; all three default to `~/.dsh/sessions`
and finish the whole store in about ten seconds. `block-repeats.cjs` prints its table directly
(`--recent` restricts to the last 24h; pass a single `session.v4.jsonl.zstd` to inspect one session).
Between them they are what produced the population numbers in `../FINDINGS.md` §7 — including the
negative results (repeat count and stall rate are uncorrelated, r = −0.0076), which is the main
reason they are worth keeping.

> ⚠️ They assume this harness’s log format (multi-frame zstd, cut on the magic bytes
> `28 B5 2F FD`), and they hardcode the `~/.dsh/sessions` root. If your store lives elsewhere,
> the `root` constant and the frame-splitting helper are the two things to change.

---

## Per-session drill-down (the *method* ships; the two helper scripts do not)

The surveys above answer **population** questions. Reading **one** session's shape is a different
job — it is how the case studies in §7 were read, and how the "it knew, it wrote the rule down, and
it still stopped" observation was found.

> ⚠️ **`analyze-stall.cjs` and `dump-step.cjs` appeared in earlier revisions of this file but are
> NOT included in this repository** — they lived on one machine and were never kept. If you came
> here looking for them: they are not missing, they are absent by accident, and the method is small
> enough to re-derive in a few lines: open one `session.v4.jsonl.zstd`, group events by `turn`,
> and print the block types (`reasoning` / `text` / `tool-call`) of a single `assistant/message`.
> ⚠️ Whatever you print this way is **raw reasoning text** — redact before pasting it anywhere public.

**Why drill-down rather than more surveys.** A population statistic tells you a signal is
uninformative (e.g. repeat count vs stall rate, r = −0.0076). It cannot tell you *what the step
looked like*. The most useful single observation in §7 — a model writing
`(truncated here, next I should continue with the tool call)` and then continuing its loop instead —
only exists at this level, and no aggregate over 745 sessions would have surfaced it.
