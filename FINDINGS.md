# Findings: the anatomy of a dying session

> Everything below was measured on **one machine, over ~400 session logs (~7,800 assistant steps)**,
> across a single day of investigation. Session identifiers are anonymised; quoted agent text is
> verbatim (it is the agents' own reasoning).

---

## 1. Method

Session logs were multi-frame `zstd` files; frames were cut on the magic bytes `28 B5 2F FD` and
decompressed one by one (Node's `zstdDecompressSync` only decodes the *first* frame — a trap:
you will see exactly one record and conclude the log is empty).

From the decoded records we extracted, per session:

- **stalls** — turns whose final step had reasoning but no text and no tool call;
- **self-pressure** — count of words like *quick / now / immediately / must / don't ramble /
  be brief*, per 1,000 characters of reasoning;
- **self-prompt loops** — the maximum number of times the *same short line* (≤6 chars) repeats
  inside a single reasoning block, after stripping fenced code blocks. (Stripping is essential:
  without it, a JSON `}` counts as a "repeated line" and every session looks sick.)

**Baseline:** across the whole machine, **1.04%** of steps (81 / 7,810) were stalls. Most sessions
had **0 or 1**. The distribution is heavily bimodal — which is what made staging possible at all.

---

## 2. The shape of the failure

### 2.1 It is "decided but not emitted", not "confused"

| Measurement | Stall steps | Normal steps |
|---|---|---|
| reasoning mentions the next **action** | **97.6%** | 86.1% |
| reasoning mentions **reporting back** | 76.8% | 65.6% |

The *content* is nearly identical. Stall steps are not steps where the agent lost the thread —
they are ordinary steps that failed to emit.

What the step does emit instead is a **tiny summary line**: across 35 stalls we read, **33 ended
with a line like "ok." / "do it." / "execute."** — the exact position where a tool call belongs.

### 2.2 It recovers instantly when generation resumes

The step *after* a stall:

| What came next | Share |
|---|---|
| reasoning + text + **tool call** | 23% |
| reasoning + **tool call** | 15% |
| reasoning only (stalled again) | 7% |
| others (multiple tool calls, text-only) | 55% |

**38% resume by calling a tool immediately.** The agent had not forgotten the plan. This is the single
strongest argument that the problem is at the *emission* boundary, not in planning.

### 2.3 Context size is not the cause

| Session | cumulative context reads | output tokens | steps | stalls |
|---|---|---|---|---|
| the machine's **largest** session | **370M** | 1.03M | 846 | **1** |
| a session that died | 306M | 0.66M | 688 | **11** |
| another healthy session | 170M | 0.72M | 366 | 1 |

**The biggest session was the healthiest.** (Note for anyone quoting "303M tokens" as a cause:
that figure is *cache-read* tokens — cumulative context re-reads, not output. The log of the
session that died was 4.9 MB on disk.)

### 2.4 Neither is context *pressure*

The sick sessions sat at 28–35% of the context window; healthy ones spanned 12–38%. The session
with the **highest** fill of all (38.3%) had zero stalls. Pressure is at most an accelerant.

---

## 3. Course of illness (the part that changed our protocol)

Scoring each session on an 8-turn sliding window and reading the stage per turn
(one character = one turn; the digit is the stage, `.` = healthy):

```
session A (58 turns)
  3333333222222..........2233444444444344444444444443
               `------- 10 healthy turns -------'  `--- never remits ---'

session B (44 turns)
  ........22222222......222222222233444
          `-- 6 --'     `-- 2nd episode -> terminal --'
```

**Self-recovery is real.** Both sessions recovered on their own — 10 and 6 turns — before relapsing.
**In both sessions, the second episode never remitted.** After it, the stall rate climbed monotonically:

| quintile of session A | 1st | 2nd | 3rd | 4th | 5th |
|---|---|---|---|---|---|
| stalls per step | 0.0% | 3.2% | **13.2%** | **29.6%** | **33.3%** |
| self-pressure per 1k chars | 0.35 | 0.46 | **1.79** | 1.91 | **2.80** |

Same shape in session B (self-pressure 0.34 → 3.80, i.e. **11×**).
**Self-pressure rises first** — in both sessions it was elevated 10–20 turns *before* the stall
rate took off. That is the earliest usable signal we found.

### 3.1 The self-prompt loop (our "do it." ×431)

The terminal stage has a distinctive texture. After noticing it is stalling, the agent starts
urging itself on, in single-word lines:

```
"you said 'it's stuck' — I stalled again ✓
**act now** ✓ — **upload + recheck** ✓
**do it.**
**one call** ✓
**do it.**
**stop thinking about what to do — I know what to do — just do it** ✓
**do it.**
```

The self-prompt frequency rose with the illness (1.1‰ → 74‰ of all characters in the final turn,
**431 occurrences** of "do it."). It is a *compensating behaviour* that became the disease:
a one-word imperative looks exactly like the summary line that ends generation
(§2.1), so urging harder made stalling more likely.

**A wrenching detail worth recording.** In one session the agent wrote, mid-thought:

> *"**Don't write any 'execute.' / 'ok.'** ✓ — go straight into the content ✓"*
> *"**ok.**"*  ← and then it wrote that word anyway, and stopped.

It knew. It wrote the rule down. And the thought still ended with the word, and the action was
never emitted. This is why we stopped looking for a "cognitive error" explanation.

---

## 4. Things we got wrong (kept deliberately)

1. **"Filler sentences are the cause."** Our first hypothesis was that reasoning ending in
   *"ok." / "execute."* tricks the model into thinking it already acted. **Falsified:** we measured
   the enrichment factor of "ends with a filler line" between stall steps and normal steps and got
   **1.2×** (44.4% vs 35.6%). Filler lines are a *writing habit*, not the cause — they merely mark
   where generation tends to stop. *(Any observation must be checked against its baseline rate
   before it becomes a criterion. We nearly shipped this one.)*
2. **"Context pressure is the driver."** Not supported (§2.4).
3. **"Counting user 'continue' messages measures the illness."** Wrong: of 18 "continue" messages
   on the machine, only **2** followed a stall. The rest followed `turn/end error`, an abort, or
   **the harness itself** auto-inserting a continuation prompt. It is a mixed signal, not a metric.
4. **"Once it starts, it is irreversible."** Falsified by our own timelines (§3) — recovery
   happened twice. This is what moved the intervention line from "first stall" to "second episode".
5. **A tooling bug worth repeating**: our cache keyed session scores by log-file byte size, but we
   changed the *scoring algorithm* without bumping the cache version — so a 5-turn session was
   reported with a stale 6.4× score. **A cache is part of your criterion:** if a cached false hit
   can make the instrument lie, the version must change whenever the algorithm does.

---

## 5. Primary sources (independent, external)

- **OpenAI Codex** [#36596](https://github.com/openai/codex/issues/36596) — the reporter's own
  diagnosis: *"a mismatch between model planning/state, tool execution, and turn
  termination/final-response behavior."* A commenter adds the crucial field observation:
  ***"Once a session enters this state, Codex may repeatedly stop after very short amounts of work"***
  and that **starting a fresh session or switching models** can restore execution — *"the repository,
  task registry and requested work can remain unchanged."*
- **Anthropic Claude Code** [#56247](https://github.com/anthropics/claude-code/issues/56247) —
  an auto-continue prompt triggers `"No response requested."` then silence; sometimes only killing
  the process recovers it. The reporter asks: *"is the assistant returning an empty completion that
  the agent loop misinterprets as 'task finished'?"* — exactly our Factor 2.
- **Google Gemini CLI** [#22633](https://github.com/google-gemini/gemini-cli/issues/22633)
- **arXiv 2608.01995** — Appendix A names the same **symptom class**: *"Premature turn termination. In early Phase 1 the agent would sometimes declare a turn finished after merely submitting a Slurm job, without waiting for or interpreting the result."* ⚠️ **The root differs, and this matters**: theirs had a clear cause and was *"Fixed by an explicit end-your-turn-after-submission instruction"*. Ours has no such fix — which is why we report both: the symptom is shared, the remedy is not.
- **Xu et al., NeurIPS 2022** — [*Learning to Break the Loop*](https://arxiv.org/abs/2206.02369):
  sentence-level repetitions have a **"self-reinforcement effect"** — *"the more times a sentence is
  repeated in the context, the higher the probability of continuing to generate that sentence."*
  This is the same mechanism as our §3.1 loop. (Apple ML hosts a copy of the same paper.)
- **Ecosystem**: we counted **15** plugins in one agent ecosystem whose entire purpose is
  auto-continuing a stopped turn. None of them claims to address the cause. That is the gap this
  repository is about.

---

## 6. Boundaries

- **n is small where it matters.** The staged course of illness rests on **two** sessions; the
  thresholds are separation bands from one machine. Re-measure on yours.
- **The mechanism is an inference.** Logs record outcomes, not sampling. We inferred "emission
  fails at the summary line" from content, recovery behaviour, and termination position — we did
  not observe it directly.
- **We cannot fix Factor 1**, and no vendor has. Everything practical here is triage:
  detect early, do not add pressure, hand off cleanly.
