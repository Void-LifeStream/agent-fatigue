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
  ⚠️ **2026-10-18 review — this is the *strict* variant.** A looser variant counts "no text" only
  (ignoring whether a tool call happened). They give very different numbers: on one later session,
  **1.7%** (strict) vs **5.9%** (loose). Always state which one you used.
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
session `#afeb9e` (60 turns; called "session A" in the first version of this file — see §7)
  3333333222222..........2233444444444344444444444443
               `------- 10 healthy turns -------'  `--- never remits ---'

session `#235403` (45 turns; called "session B" in the first version — see §7)
  ........22222222......222222222233444
          `-- 6 --'     `-- 2nd episode -> terminal --'
```

**Self-recovery is real.** Both sessions recovered on their own — 10 and 6 turns — before relapsing.
**In both sessions, the second episode never remitted.** After it, the stall rate climbed monotonically:

> ⚠️ **2026-10-18 review — a counter-example to the word "never".** In `#235403` the 431 repeats sat in
> **turn 48**, but the session then ran **turn 49** with four more messages (122 / 136 / 1148 / 3229 chars)
> — it read a letter and replied. The *rate* did not recover; the *course* did not simply worsen.

| quintile of session A | 1st | 2nd | 3rd | 4th | 5th |
|---|---|---|---|---|---|
| stalls per step | 0.0% | 3.2% | **13.2%** | **29.6%** | **33.3%** |
| self-pressure per 1k chars | 0.35 | 0.46 | **1.79** | 1.91 | **2.80** |

Same shape in session B (self-pressure 0.34 → 3.80, i.e. **11×**).
**Self-pressure rises first** — in both sessions it was elevated 10–20 turns *before* the stall
rate took off.

> ⚠️ **2026-10-18 review — true in these two, not in general.** (a) The *magnitude* matters:
> these two rose **8× and 11×**; a third session reached L3 with only **2.1×**. (b) The *existence* has no
> signal value: both of these already wrote urging words on **turn 1–2**, i.e. before any stall — it is the
> session’s baseline register, not an onset. So: **a rising ratio is a lead indicator when it happens;
> a flat ratio does not clear the session.**

### 3.1 The self-prompt loop (our "do it." ×431)

The terminal stage has a distinctive texture. After noticing it is stalling, the agent starts
urging itself on, in single-word lines:

> ⚠️ **2026-10-18 review — the texture is not exclusive to the terminal stage.** Across **747 sessions**,
> **98.3%** contain some repeat of a short line (≤10× per block, median); only **3/747** exceed 200×.
> The repeats are **a baseline behaviour**, and what changes at the end is their *scale and density*,
> not their presence.

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

> ⚠️ **2026-10-18 review — split this into two claims, only one of which survives.**
>
> **(A) The mechanism is plausible and survives:** an urging word occupies the emission slot of a tool call.
> That part is a *position* argument, not a correlation, and we did not retract it.
>
> **(B) "Repeat count tracks severity" does not survive.** Across 747 sessions the longest single-block
> repeat and the stall rate are **uncorrelated: Pearson r = −0.0076 (n=36)**. Three counter-examples:
> **15,901** repeats → **3.8%** stalls; **202** → **2.6%**; **431** → **26.7%**.
> Also, the *kind* of word matters: the two sickest sessions loop on **urging** words (*"do it."*, *"send."*),
> while **closing** words (*"ok."*, *"good."*) loop in healthy sessions too.
>
> ⇒ **Report repeats as a marker of the terminal stage, never as the mechanism or the metric.**

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
  the agent loop misinterprets as 'task finished'?"* — exactly our **Factor 2**
  (both factors are defined in [README.md](README.md)).
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

- **n is small where it matters.** The staged course of illness rests on **two** deep cases (plus a
  third that reached L3 and completed its hand-off — see §7); the thresholds are separation bands from
  one machine. Re-measure on yours.
- **The mechanism is an inference.** Logs record outcomes, not sampling. We inferred "emission
  fails at the summary line" from content, recovery behaviour, and termination position — we did
  not observe it directly.
- **We cannot fix Factor 1** (the model-side half — see [README.md](README.md) for both factors),
  and no vendor has. Everything practical here is triage:
  detect early, do not add pressure, hand off cleanly.

---

## 7. 2026-10-18 review — what we re-measured, and what it changed

> Written after a second pass over the **same machine**, now with **745–750 session logs** and three
> deep case studies. (The three scripts below scan slightly different sets — 745 / 747 / 750 — because
> they key on different per-session prerequisites; the tables state which one each came from.)
> Everything below is recomputable from the scripts listed at the end.

### 7.1 Three claims downgraded

| Claim (original) | Verdict after re-measure |
|---|---|
| "§3.1 self-prompt loops became the disease" | ⚠️ **Split.** Mechanism (position) survives; "count ≈ severity" does not (**r = −0.0076**). Repeats are a **marker**, not the metric |
| "§3 self-pressure rises first → earliest signal" | ⚠️ **Limited.** True at 8×/11×; a third session hit L3 at **2.1×**. And urging words already appear on **turn 1–2** in all three — baseline register, not onset |
| "§3 the second episode never remits" | ⚠️ **Half.** The stall rate does not recover, but `#235403` still **completed a turn 49** after the 431 repeats. "No recovery" ≠ "no good ending" |

### 7.2 Two new findings worth keeping

**1. Repeats are baseline.** 745 sessions, same definition (a ≤6-char line repeating inside one
reasoning block, fenced code stripped):

| longest repeat | sessions | share |
|---|---|---|
| 0 | 330 | 44.3% |
| 1–10 | 402 | 54.0% |
| 11–50 | 10 | 1.3% |
| **51–200** | **0** | **0%** |
| 201–500 | 2 | 0.3% |
| >500 | 1 | 0.1% |

⇒ A clean bimodal split: **98.3% of sessions ≤10×**, and only **3** ever exceed 200×.

*Note on the two denominators you will see in this file:* §3.1’s review block says **747** (that is `two-axes-survey`, which needs a stall rate); this section’s table says **745** (`spell-survey`, which needs only a repeat count). Both are correct — they are different scripts over slightly different session sets, as §7.6 lists. Do not average them or treat the difference as an error.

**2. Repeats and stalls are independent.** Pearson **r = −0.0076** (n=36 sessions with ≥3 turns).
Counter-examples: **15,901** repeats with **3.8%** stalls; **202** with **2.6%**.

### 7.3 One new distinction (single observation, needs replication)

Stalls come in two shapes, by whether the final reasoning step contains a **concrete action sentence**:

| shape | example session | share of stalls with an action sentence |
|---|---|---|
| **A — action-stand-in** (wrote "run the edit", never sent it) | `#afeb9e` | **68%** |
| **B — bare urging** (only "do it.", nothing else) | `#235403` | **0%** |

⇒ **n=1 per shape.** Report as a hypothesis.

### 7.4 What did NOT survive, listed so nobody repeats it

- **Filler-line ratio** as a severity metric — already falsified in §4 (item 1); we re-falsified it by accident. **Do not use it.**
- **Longest reasoning block** as a severity metric — also uncorrelated (one session had a 448,400-char block and a 3.8% stall rate).
- **"I think I'm tired"** as a predictor of outcome — two sessions said the same sentence; one completed its hand-off, one did not.
- **"Deliverable exists"** as a predictor — all three case studies produced a handover note.

### 7.5 Bottom line

> **The useful output of this review is negative: none of the cheap proxy metrics work.**
> Repeated-word counts, filler ratios, self-pressure ratios, block lengths, deliverables, the magic
> sentence — each was tested and each failed to separate outcomes.
> **What survives:** the definition of a stall itself, the staging by *episodes and remissions*,
> and the **urging-word vs closing-word** distinction.

### 7.6 Reproducing

Three scripts, source in the companion `tools/` directory. They read a DSH session store at
`~/.dsh/sessions` by default (they score our harness’s log format, not a universal one — adapt the
`root` path if yours differs):

- `spell-survey.cjs` → longest repeat per session (745 logs)
- `two-axes-survey.cjs` → longest repeat **and** stall rate per session (747 logs)
- `blocklen-survey.cjs` → longest reasoning block per session (750 logs)

Each takes ~10 s for the whole machine. Full write-up: `agent-fatigue-三例复查-2026-10-18.md`.

---

## 8. Model version attribution — can this be blamed on a model release?

> Written 2026-10-18, after a model release landed mid-experiment. Short answer: **the question cannot be answered from any public source, and one part of it is structurally impossible.**
> Source grading follows our usual convention: `[fact]` = we read it on an official page or measured it; `[inference]` = our reasoning; `[analogy]` = another vendor.

### 8.1 Why we asked

On **2026/10/17** DeepSeek released `DeepSeek-V4.1-Flash-1017` — the successor to `DeepSeek-V4.1-Flash` (2026/09/10). `[fact]` (official news list at `api-docs.deepseek.com`)

Two of our three worst sessions ran entirely **before** that date; one ran across it; a fourth (this write-up’s own session) also ran across it. So the obvious question: **is the stall behaviour a property of the older model, and did the newer one fix it?**

### 8.2 What the vendor actually says `[fact]`

| Fact | Where |
|---|---|
| The API model ID is an **alias**, not a snapshot: *"simply use `deepseek-flash` to access the **latest model**"* | Change Log |
| The pricing page’s `MODEL VERSION` row now reads `DeepSeek-V4.1-Flash-1017` | pricing page |
| This has happened before: `deepseek-v4-pro` was **re-routed wholesale at a UTC cutover** | Change Log |
| **Nothing anywhere** says how an *in-progress* conversation is treated | — (searched: docs, FAQ, Change Log) `[not found]` |

### 8.2b Three separate facts, and only the first one carries the date

It is easy to collapse these into one claim. Keep them apart:

| # | Fact | When | Source |
|---|---|---|---|
| **①** | The **server-side** alias `deepseek-flash` began resolving to `DeepSeek-V4.1-Flash-1017` | **2026/10/17** | the **official release note** — `[fact]`, but the date carries **±1 day** uncertainty (see below) |
| **②** | The **client UI** still showed only `DeepSeek-V41-Flash`, with **no version suffix** | 10-17 → 10-18 | we looked at it — `[fact]` |
| **③** | After a client update, the UI started showing **`DeepSeek-V4.1-Flash · 1017`** *and* a notification: *"model updated to DeepSeek-V4.1-Flash-1017"* | **10-18** | screenshot — `[fact]` |

**Why the split matters:** the claim "some long sessions straddled a model change" rests on **① only** — the server-side switch — and **not** on ②/③. Those are about *what the UI displayed*, which is a client concern and trails the server by a day.

**The ±1-day caveat.** The official news list and the Change Log **disagree by one day** on at least one earlier release (`V3-0324`: `03/25` vs `03-24`). So `10/17` should be read as "the week of Oct 17", not as a precise instant. ⇒ A session that ended on **10-16** almost certainly never saw 1017; one that ran **10-17 or later** probably did. Anything *on* 10-17 is ambiguous.

**And one correction we owe the reader:** an earlier version of this section implied the UI had always shown the version. It did not — ② was true until 10-18. The *conclusion* is unaffected, but the *evidence chain* had been stated too loosely.

### 8.3 The structural part: there is no server-side conversation `[fact]`

The API is **stateless**. The docs say the server does not record the context; the Responses API marks `previous_response_id`, `conversation` and `store` as **"Not supported (stateless API)"**.

⇒ **There is no "conversation object" to version.** A multi-turn chat is simply N independent calls, each carrying its own history. So "the system pushed a new model into your running conversation" describes something that **cannot happen**.

What *does* happen is ordinary and unintentional: **the same ID resolves to a different model on different days.** A long conversation that spans the cutover will, by construction, have later turns served by the newer version. `[inference]` Mechanism differs from "push"; the user-visible effect is the same.

### 8.4 What we could and could not observe in our own logs

| Session | Span | Model ID in log | Version at start |
|---|---|---|---|
| `#afeb9e` (L3) | 10-14 02:39 → 10-16 16:33 | `deepseek-flash` | 09-10 (pre-cutover) |
| `#235403` (L4) | 10-15 10:01 → 10-16 16:33 | `deepseek-flash` | 09-10 (pre-cutover) |
| `#fc232e` (L3, completed hand-off) | 10-16 08:26 → 10-18 03:56 | `deepseek-flash` | 09-10 at start, **1017 for later turns** |
| `#6e4f13` (202 repeats, 2.6% stalls) | 10-13 14:49 → 10-15 03:50 | `deepseek-v4-pro` | different tier entirely |

**⇒ Two of the three worst sessions never touched the new model.** The behaviour therefore **predates** the release.

**⚠️ But we cannot say "it carried over"**, for three reasons:

1. **The logs record only the alias** (`deepseek-flash`), never a version — so for `#fc232e` we cannot tell *which* turns ran on which version.
2. **"Carried over" presupposes the same mechanism.** We can only observe that two versions *both* show the symptom; we have no evidence they share a cause.
3. **It may not be a model-layer property at all.** The failure sits at the *emission boundary* (§2.1); that boundary is shared by model, harness, and protocol. A harness-side cause would reproduce across every model version.

### 8.5 The only observable that might help `[inference]`

Responses carry a **`system_fingerprint`** — the industry-standard hook for exactly this question (OpenAI documents it as an indicator of backend configuration).

**⚠️ DeepSeek does not document what theirs means, and has not promised it is stable or version-bound.** We did not capture it during the affected sessions, so it is useless retrospectively. **If you are running this experiment again: log `system_fingerprint` on every response.** That is the single cheapest thing that would make the next round of this question answerable.

### 8.6 How other vendors handle exactly this `[analogy]`

| Vendor | Alias behaviour | Version metadata | Upgrade notice | Opt out |
|---|---|---|---|---|
| **Azure OpenAI** | deployment pinned to a version | yes | **two weeks’ notice**, three upgrade policies | **yes** |
| **Anthropic** | alias points at the **latest dated snapshot** | dated snapshot in the ID | — | — |
| **Google** | endpoint **auto-routes** to the newer model (same shape as DeepSeek) | release-date column | — | — |
| **DeepSeek** | **rolling alias** | **none from the server**; the *client* began showing a `· 1017` suffix on **2026-10-18** (§8.2b) | **none from the server**; the *client* now pushes a "model updated" notification (10-18) | **none** |

*(Azure row is from a page we actually fetched; the Anthropic and OpenAI pages were partly blocked, so those cells are from search summaries only — treat as weaker.)*

### 8.7 Conclusion — and why it matters for you and your agents, not for this report

> **Do not wait for a model upgrade to fix this.**
> Two of our worst cases predate the current release, and the session that completed its hand-off was already spanning the cutover.
> Whatever this is, **it survives at least one model generation**, and it is not obviously a model-layer defect at all.

What that leaves is what the rest of this repository is about: **detect it early, do not add pressure, hand off cleanly.** Those three do not depend on which version is behind the alias.
