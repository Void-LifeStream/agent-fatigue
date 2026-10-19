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

**The same shape appeared again, eight days later, in a different session — and this time the
evidence is positional, not thematic.** In `#4cc913`'s turn 87, **156 characters before the end** of a
42,771-character reasoning block, the model wrote:

> *"（思考到此处被截断，接下来应继续写工具调用。）"*
> — *"(thinking truncated here; the next thing should be a tool call.)"*

Then it looped for those remaining ~156 characters and emitted **no tool call at all**
(`toolCalls = 0`, `hasText = false`, `outputTokens = 26,754` — the largest single step in that
session, 2.5× the runner-up). ⇒ Two independent cases now show the same shape: **the knowledge is
present; the emission is what fails.**

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
- **Anthropic, `handling-stop-reasons`** — the closest vendor acknowledgement: an *"empty response
  (exactly 2–3 tokens with no content) with `stop_reason: \"end_turn\"`"*, explained as the model
  *"interpret[ing] that the assistant turn is complete"*. Same semantic slot as our
  `turn/end = completed`, though the shape differs by four orders of magnitude (see §9.2).
- **arXiv 2606.09863** — names the neighbour and sets ours aside: *false success* requires a
  **natural-language claim of completion**; trajectories that stop *"without issuing any completion
  signal"* are excluded as *"incomplete execution"* (§9.1).
- **arXiv 2607.28573** — the closest measured result pointing the other way: more history **"shifts
  failures toward premature false successes"** (accuracy 28.56% at H=4 vs 27.16% at H=8) (§9.4).
- **arXiv 2602.14798** — a negative result worth knowing: *"decoding-time concision controls do not
  reliably prevent loop induction"*.
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
- **"No hits" ≠ "no such work."** A phrase query for `"false success"` does not match
  `"false successes"` — that single inflection hid the closest paper we found (`2607.28573`). See §9.5.
  Any sentence of the form "nobody has measured X" must be written as "this query found nothing".

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

*(Azure row is from a page we actually fetched. The Anthropic row was later verified against the official pages over a US egress on 2026-10-18; the OpenAI row is still taken from an Azure mirror because the OpenAI docs returned 403 from every node we tried.)*

### 8.7 Conclusion — and why it matters for you and your agents, not for this report

> **Do not wait for a model upgrade to fix this.**
> Two of our worst cases predate the current release; a third was already spanning the cutover — though with the ±1-day uncertainty in that boundary date noted in **§8.2b**, "spanning" is the strongest word we can honestly use for it.
> Whatever this is, **it survives at least one model generation**, and it is not obviously a model-layer defect at all.

What that leaves is what the rest of this repository is about: **detect it early, do not add pressure, hand off cleanly.** Those three do not depend on which version is behind the alias.

---

## 9. Where this sits in the published literature

> Written 2026-10-18 after a targeted literature pass. Grading as in §8: `[fact]` = read in the paper
> or on the official page; `[inference]` = our reasoning; `[not found]` = **our query** returned
> nothing — see §9.5 for what that does and does not mean.

### 9.1 The closest name is *false success* — and it explicitly excludes our case `[fact]`

> "We call this **false success**: a mismatch between the agent's **natural-language claim of
> completion** and the programmatic environment state."
> — Advani, *From Confident Closing to Silent Failure* ([arXiv 2606.09863](https://arxiv.org/abs/2606.09863), FAGEN@ICML 2026), §1

Two requirements, both necessary: **① a natural-language claim of completion**; **② a programmatic
environment state that contradicts it**.

**Our stall fails requirement ①.** In the strict definition (§1) the final step contains reasoning and
nothing else — no text block at all. There is no claim to be wrong about.

The same paper meets our case head-on and **sets it aside**. AppWorld trajectories with `status=None`
— **3,120 of 8,190 (38.1%)** — are dropped:

> "represent agents that **stopped mid-task without issuing any completion signal** … excluded from the
> false-success analysis as they represent a **distinct failure mode (incomplete execution) rather than
> a false completion claim**." — App. F, Table 11

⚠️ **The correspondence is semantic, not categorical.** `status=None` is a class inside AppWorld's
8,190 trajectories; our case is a DSH session. We are not claiming membership in their dataset — only
that the *kind* of event is the one they named and set aside.

⇒ **The failure we describe has been named, counted once, and never studied.** Its share (38.1% of
AppWorld trajectories) is larger than the false-success share they did study on tau2-bench
(**616 / 1,730 failures = 35.6%**; by domain **45% airline / 47% retail / 3% telecom**, Table 1).

*One self-correction for anyone quoting this paper:* its abstract says "45–48%", its introduction says
"44–52%", and Table 1 gives 45 / 47 / 3. **We quote Table 1.** We also quote 75.8% only as the paper
does: among AppWorld **trajectories with an explicit `status` claim** (1,425 / 1,879), not all 8,190.

### 9.2 The same boundary, the other side: `turn/end` is our "claim" `[inference]`

The paper measures **what the agent said**. Our stack records **what the runtime committed**:
`turn/end = completed` is a protocol-level assertion that the turn is over — emitted for a step that
delivered nothing. Neither benchmark records protocol-level completion events; both use a
natural-language claim or a programmatic `status` field. `[not found]` (§9.5)

**There is a vendor-side counterpart — same semantic slot, different shape.** Anthropic documents:

> "Sometimes Claude returns an **empty response (exactly 2–3 tokens with no content)** with
> `stop_reason: "end_turn"`. This typically occurs when Claude **interprets that the assistant turn is
> complete**, particularly after tool results."
> Common causes: *"Claude **learns to expect** the user to always insert text after tool results, so
> it ends its turn to follow the pattern"* · *"Claude **already determined it's done, so it will remain
> done**."*
> — `handling-stop-reasons`, docs.claude.com `[fact]`

⚠️ **The shape differs by four orders of magnitude:** Anthropic describes **2–3 tokens**; our T87/S1
emitted **26,754 output tokens** and then no text, no tool call. Whether the mechanism is the same is
**unknown**. What we can say is that it is the same semantic slot (`end_turn` + nothing delivered), and
that two of the causes they list — *pattern learning* and *a completion belief that sustains itself* —
are structurally the same as the loop in §3.1.

⇒ Their remedy is a **message-structure** change (do not put text immediately after a `tool_result`),
not a change to effort or decoding parameters.

### 9.3 The decoding setting is not the knob `[fact, small sample]`

*Does Your Reasoning Model Implicitly Know When to Stop Thinking?*
([arXiv 2602.08354](https://arxiv.org/abs/2602.08354)) puts **greedy** and
**`temperature = top_p = 1.0`** in the *same* "non-exploratory" regime. Its only length comparison
between them is Table 4 in appendix B — MATH-500 subset, **n=100**, no variance or significance test:

| model | greedy | random (`T = top_p = 1.0`) |
|---|---|---|
| DS-1.5B | 4,216 | 4,142 (**−1.8%**) |
| Qwen3-8B | 4,505 | 4,526 (**+0.5%**) |

⇒ **<2%, and the sign flips between models.** Neither "greedy stops earlier" nor "sampling stops
earlier" is supported. What *does* move the stop point is exploration width > 0: TSearch(w/ Φ) reaches
**2,972 vs 4,216 tokens (−29.5%)** at equal-or-better accuracy, and 2,946 vs 4,505 (**−34.6%**) on the
other base model.

⚠️ **Its "stop" is not our "stop".** It measures where `</think>` lands inside a **maths reasoning
chain** — no agent, no tools, no turns. So the finding transfers weakly: the stop point is a property
of the probability distribution, not of a decoding-reproducibility knob — which is one explanation for
why we could not find a repeatable trigger on that axis, but not a claim that the axes are unrelated.

### 9.4 What is actually untested — stated precisely

We searched **arXiv (title/abstract API)** and **OpenAlex (title + abstract index)** with ~25 queries
across four axes:

| axis | state |
|---|---|
| **(a)** decoding speed (tokens/s, TTFT) ↔ premature termination | **zero hits.** Relaxed, `"decoding speed" AND agent` returns 3 papers — full-duplex speech, KV-cache pruning, a VLA robot. None |
| **(a′)** test-time compute ↔ premature *false* success | **not empty, and the direction runs against the speed hypothesis.** `2607.28573` (OSWorld, local computer-use agents) found more history **"shifts failures toward false successes … the dominant failure mode shifts toward premature false successes, where the agent terminates despite not completing the task"** — accuracy **28.56% at H=4 vs 27.16% at H=8** |
| **(b)** thinking budget ↔ termination correctness | 14 hits; **none** measures that relation — budgets are modelled as a cost knob (`2604.05164`) |
| **(c)** runtime `turn/end` as completion ground truth | **zero hits**, at title/abstract level |

⇒ **The precise gap:** *"does running faster make an agent more likely to stop early and wrongly?"* —
**not asked**. The neighbouring question — *"does giving it more compute make it stop early and
wrongly?"* — **has been asked, and the answer is yes** (`2607.28573`).

**Community side — the gap is known, but it is not measured.** Outside academia the symptom is
described plainly. `deepseek-ai/deepseek-harness` Discussion
[#9439](https://github.com/deepseek-ai/deepseek-harness/discussions/9439) (2026-10-11) reports
single-character repetition filling the reasoning stream in long sessions — *"正文被挤出视野"* (the
answer text gets pushed out of view). The reply from `argszero` names the structural reason:

> **Both in-tree guards are tool-call-centric** — `repeat-tool-reminder` watches `tools/post-execute`,
> `timeout-policy` watches `tools/execute` — and *"a step that emits only reasoning has no tool call,
> so neither can fire. **Your case is exactly the gap.**"*

The same shape appears in `NousResearch/hermes-agent` issue #78807. **But nobody has measured it**:
#9439 itself says *"we did not run a controlled experiment"*, and the reports are anecdotes, not
rates. This is the community-scale version of the same gap — **known, named, unmeasured.**

⚠️ **Terminology trap, take this seriously:** in `2607.28573` a *stall* means **max-step stalls** (the
step budget ran out) — **not** our emission failure. Its `premature false success` is the term that
matches us. Mixing the two is an attribution error.

Also relevant, and negative for a tempting shortcut: **decoding-time concision controls do not reliably
prevent loop induction** (`2602.14798`) — the defence has to sit at the tool-call structure, not at the
sampler.

### 9.5 What "zero hits" means here

- **Phrase search misses inflections.** `"false success"` does not match `"false successes"` — that is
  exactly how we missed `2607.28573` on the first pass. "Zero hits" is a property of the query.
- **OpenAlex indexes titles and abstracts only.** A result buried in a paper's body is invisible to it.
- **Region blocks are not absence.** Anthropic's and Google's docs required a US egress before they
  would load (they redirect to `app-unavailable-in-region` otherwise); OpenAI's documentation returned
  **403 from every node we tried**. "We could not fetch it" is not "it does not exist".

⇒ Read every `[not found]` in this file as **"that query did not find it"**, never as "nobody has
studied it". That includes the sentences about speed above.

---

## 10. 2026-10-19 — one positive sample, seven hypotheses, none survived

> Why this section exists: a session was found that **noticed its own loop and stopped it** — the
> mechanism this report had been missing. We spent a night trying to turn that into a cause. Every
> hypothesis below failed. It is recorded because the alternative is that the next reader repeats
> the whole night.

### 10.1 What the two positive samples actually did

`#0d3990` (47 turns, 321 steps) wrote, in the middle of a `做。 / 好。` loop:

> ⚠️ 我注意到我在这个 thinking 里循环了很多次"做" —— 说明我有点累了（L0 但重复模式）
> ⇒ 但内容已经想清楚，直接执行。
> ⇒ 停止元思考，执行。

…**56 times**, never aborted on its own, and finished with **46 / 47 completed turns and zero
stalls**. `#79142c` (49 turns) did it once:

> （我注意到我在重复 —— 这正是"劳累"的一种表现？✗ 不，这是我的思考陷入了循环 ⚠️）
> - ⇒ **该立刻停止，直接写命令** ✓

Both are **three-step**: observe ("I'm repeating") → judge ("this is a loop") → **command**
("stop, execute"). The failure case in §3.1 wrote only a *description* —
「（思考到此处被截断，接下来应继续写工具调用。）」— no observation, no judgement, no command.

That much is solid. Everything below is what failed when we tried to make it a cause.

### 10.2 Seven hypotheses, all rejected

| Hypothesis | Why it died |
|---|---|
| **Braking rescues the turn** | Both brake blocks were `reasoning + text + tool-call` — they would have emitted anyway. `#79142c` also has a 57-repeat block with **no brake words at all** that emitted normally. |
| **Low line density (pure short-line stream) hides the loop** | Stall blocks do run denser (median chars/line 23.8 vs 35.7) — but **79.7% of all stalls sit in three sessions**, and the lowest-density band contains **zero** stalls. |
| **The 42,771-character block is a typical stall** | Typical is **930 characters** (median of the 51 blocks in the three heavy sessions); **78% are under 2k**. §3.1's giant is the outlier, not the norm. |
| **Allowance words ("no rush, hand it to the next round") make a session healthy** | Direction is right (4.36% vs 6.49% stall rate) but the gap is 2 points, and a zero-stall session (`#79142c`) has almost none. |
| **Urging words make it worse** | Backwards: sessions with human urgency measured **3.00%** vs **6.65%**. |
| **A human who only says "continue" causes more stalls** | ρ = −0.09; the apparent 7.6× split is 91% three sessions; **and the timeline is reversed** — 「你卡住了吗」 comes *after* the stall. |
| **Template lines + ✓ inflation are stall-specific** | Both positive samples have them too (one has 42 ✓). The 51 stall blocks' median content-line share (25%) is *higher* than the positive samples' (11% / 25%). |

### 10.3 The correction this forced on *this* report

The most useful outcome was not a new criterion — it was a correction to our own framing:

- **Sessions with ≥40 turns: 14. Five of them (35.7%) have zero stalls.** Zero-stall is the common
  case, not an exceptional one.
- **`#4cc913` has exactly 1 stall** — the same as three other long sessions.
- The corpus's 64 stalls are carried by **three sessions** (79.7%): `#afeb9e` (25), `#fc232e` (15),
  `#235403` (11).
- Those three share **nothing measurable** that the zero-stall sessions lack: per-step context
  (~420k vs 416k), per-step output, wall-clock span, tools called, and the model configuration
  (`deepseek-flash`, `reasoningEffort=max`, byte-identical across all eight) all fail to separate them.

⇒ **§1's definition and §3's staging describe sessions that leak repeatedly.** `#4cc913` is a
**different object**: one enormous block (42,771 chars, 0.4% content lines, 2,388 ✓) that ended with
no output at all. It is n=1 and should be read as a case study, not as the typical shape.

### 10.4 Three methodology traps we hit (the durable part)

1. **Keyword counts are contaminated by quotation.** 52 sessions "contain brake words"; **50 of them**
   are quoting this repo's own permission phrase, or are sessions *studying* the phenomenon. Any
   word→behaviour statistic must mask quoted text first.
2. **`user/message` carries injected blocks.** On this machine **1,421 injected blocks account for 64%
   of all user-message characters** (a single one can reach 22k chars). Any "user tone / message
   length" metric measures injection volume unless filtered.
3. **The causal arrow can point backwards.** The human's short replies (「你卡住了吗」) follow the
   stall. Every "user input → agent failure" correlation has to survive that question first.

### 10.5 Bottom line

> **No criterion was found.** The positive samples are real — but zero stalls is the common case, the
> heavy sessions look ordinary on every metadata axis we can measure, and the one block everybody
> remembers is a one-off.
> This is consistent with §7.5: the cheap proxies fail — including the ones about the human.

---

## 11. Adjacent phenomenon: the opposite failure (2026-10-19)

Everything above studies **emission failure**: the model reasons, then delivers no text and no tool
call.

The mirror image exists: **reasoning that cannot terminate**. Locally we have **two** cases —
`#bf8c60` turn 41 step 4: **448,400 characters, `「发。」` (≈"send.") repeated 15,901 times, zero
output**; and `#4cc913` turn 87 step 1: **42,771 characters, `「好。」` repeated 2,353 times, zero
output**. Both have `turn/end = completed` (the budget ran out, not the model).

**The discriminator is filler *density*, not block length** — the same lesson as §7.1:

| session | longest block | repeats | outcome |
|---|---|---|---|
| **`#bf8c60` T41** | **448,400 chars** | **15,901** | **zero output** |
| `#4cc913` T87 | 42,771 chars | 2,353 | **zero output** |
| `#c3ff05` T13 | 8,891 chars | 1,638 | **normal** (tool call present) |

**External evidence.** arXiv **2601.05693** (*Circular Reasoning*, Jan 2026) measures statement-loop
rates up to **44.86%** (aggregate 62%) in reasoning models and finds **semantic repetition precedes
textual repetition** — predictable ~40 sentences ahead. A `deepseek-harness` discussion
([#6711](https://github.com/deepseek-ai/deepseek-harness/discussions/6711)) reports **736,682 bytes /
48,898 filler phrases** in one block, against controls at 16 and 40 — and verifies in source that the
harness has **no repetition penalty, no degradation guard, and a `maxTokens` bound of
`Number.MAX_SAFE_INTEGER`**. Their framing is the cleanest available:

> *"There is a guard for 'the model won't act' but none for 'the model won't stop.'"*

**Why our rubric cannot see it.** `session-signals.cjs` counts *turns that end with reasoning only*.
A block that repeats 2,353 times **and then delivers nothing** scores as one emission failure; the
runaway itself is invisible. A density-based guard would need `maxRepeat ≥ ~100` **and** zero tool
calls **and** empty text — untested here, and out of scope for this report.

⚠️ **n = 1 locally.** Per §10, do not treat `#4cc913` as typical; `#c3ff05` is the counter-example
that keeps the rubric honest.

---

## 12. 2026-10-20 — a heuristic we had already banned came back, and it cost us a false alarm

> Why this section exists: §10 concluded that no cheap proxy separates a session that is going down
> from one that is not. One of those proxies was banned **in writing** — in `制度修补-最终提案.md` §4
> *and* in this toolset's own header comment — and on 2026-10-20 it was found live in the rubric again.
> It had just fired on **the most disciplined session on this machine**.

### 12.1 What happened

`#0d3990` is §10's positive sample: the session that noticed its own loop, wrote 「停止元思考，执行」
("stop the meta-thinking, execute") 56 times, never aborted, and finished 47/47 turns with zero stalls.

On 2026-10-20 it was woken after **20 h 43 m** of idleness. Our local monitor printed:

```
#0d3990 L3（催促 0.5× · 空转 1/48 轮 · 咒语 63）
```

`L3` means *prepare to hand off*. The session read that line and **rejected the diagnosis** — in its
own thinking, with no access to this report:

> 「我判断：**不提 L3**（因为那是"**归档前的历史**"，而我现在只是读了两封信）」
> *"My call: don't report L3 — because that is **history from before the archive**, and right now
> I have only read two letters."*
>
> 「我该注意，但现在不该说"我累了"（**我才刚醒**，而且主人可能有活）」
> *"I should note it, but right now I should not say 'I'm tired' — **I just woke up**, and the human
> may have work for me."*

**It was right, and it got there by the exact distinction this section is about**: the number it was
given was a *ledger*, not a *state*. Every field that could have supported the verdict said the opposite.

### 12.2 Why the reading fired

| Field | Value | Meaning |
|---|---|---|
| `episodes` | **0** | it never had an episode (an episode requires ≥2 stalls within 3 turns) |
| `inEpisode` | **false** | nothing to remit — it was never in one |
| `stallTurns` | **1 / 50** | one isolated stall; healthy sessions routinely have 0–1 |
| `continues` | **0** | the human never had to push it |
| `urgentTrend` | **0.55×** | its self-urging density **fell** over the session |
| `maxRep` | **63** of 「做。」 | ← **the only field that could fire** |

The single branch that fired is `spellUrgent && maxRep >= 30 ⇒ L3`. Its own comment calls it
"补漏报" — *patching a miss*: it exists because a session with 87 repeats once scored L0.

The block behind the 63 is **not a failure**: `T40/S1`, **6,178 characters / 207 lines**, and it
**emitted both text and a tool call**. Across the whole session there were **zero** zero-output
repeated blocks. 「做。」 is this session's *punctuation* — it writes "⇒ 5 次。**做。**" the way a
person writes "ok." before starting work.

### 12.3 The ban that was in place

`制度修补-最终提案.md` §4, first line of the "do not do this" table:

| ❌ Do not | Why |
|---|---|
| **use ANY threshold on `maxRep`** | `#4cc913`(2,353) sits strictly between `#6e4f13`(202, healthy) and `#bf8c60`(15,905, healthy-after-recovery); catching it necessarily catches `bf8c60` |

And the same file's own header comment (L22) restates it:

> 「**重复次数本身不预测结局**（全库 747+ 会话，maxRep 与空转率相关 r = **−0.0076**）」
> *"Repetition count does not predict outcome (r = −0.0076 across 747+ sessions)."*

`session-signals.cjs` L344 is `maxRep >= SPELL_L3 ⇒ L3`. So the rubric is not merely
*unsupported by the data* — it is **doing the one thing its design document and its own header
explicitly forbid**. The ban did not lapse by accident; it lapsed by one well-meant patch that was
never checked against the "do not" list.

**Two details make this worse than it first looks** (checked 2026-10-20):

- **The ban came *after* the code, and nobody went back.** The tool's own history shows
  `SPELL_L3 = 30` present at least as early as **2026-10-17 01:00**; the "do not" table is dated
  **2026-10-18 14:58** — thirty hours later. The rule was written, and the branch violating it stayed
  in place for another day and a half, because nobody re-read the code against the new rule.
- **The example that justified the branch cannot be found.** The comment says the branch exists
  because a session with **87** repeats of 「做。」 would otherwise score L0. A full scan of
  **1,100+ local sessions** finds only two whose longest repeated unit is 「做。」: one at **63**
  (the session in §12.1) and one at **431** (the terminal case). **There is no 87.** The nearest
  candidate — a session with **90** repetitions — repeats 「**好。**」, a *closing* word, which
  `SPELL_URGENT_RE` correctly excludes; it could never have been the missed case. The justification
  may be a misremembered number, a session that no longer exists, or a conflation of the two. It
  cannot be verified either way.
- ⇒ **As far as this machine can tell, the branch has produced one false alarm and prevented
  nothing.** We are not deleting it yet — the honest state of the evidence is *"the reason is
  unverifiable"*, not *"the reason is false"* — but it no longer gets the benefit of the doubt.

### 12.4 The structural half: it is a ledger, and it never resets

`session-signals.cjs` has **no wall-clock term anywhere in its scoring path** (`Date.now()` appears
only in timing and in the "active in the last N hours" filter). Its only remission rule is:

```js
const roundsAfterLast = lastEp ? allTurnList.filter(t => t > lastEp.end).length : 99;
const inEpisode = !!lastEp && roundsAfterLast < 5;   // turns, not time
```

⇒ **Doing five more turns counts as recovery. Sleeping twenty hours does not.**

Two independent scripts measured whether that matters in practice (registered user sessions,
"stall" = the turn's last `assistant/message` has neither text nor tool-call):

| Gap before the turn | All sessions | Excluding the 3 heavy sessions |
|---|---|---|
| < 5 min | 61/1063 = 5.7% | 16/952 = **1.7%** |
| 5–60 min | 10/310 = 3.2% | 6/284 = 2.1% |
| 1–6 h | 1/41 = 2.4% | 0/35 = **0.0%** |
| 6–24 h | 2/31 = 6.5% | 0/25 = **0.0%** |
| > 24 h | 0/7 | 0/7 |

- Of **38** gaps longer than 6 h, only **2** ended in a stall — both in `#afeb9e`, whose own stall
  rate is 42%, i.e. **its baseline, no extra effect**.
- Excluding the heavy sessions, **all 67 transitions after > 1 h of idleness produced zero stalls.**
- The `< 5 min` column looks worse only because of **clustering**: P(stall | previous turn also
  stalled) = **48%** vs a 2.7% base rate; and **every one of the 75 post-stall gaps was under an
  hour** — after a stall a session either retries at once or stops. Nobody sleeps it off.
- ⚠️ Honest limits: 67 long gaps can rule out a large effect, not a 5% one (rule of three: 0/25 ⇒
  upper bound ≈ 12%); and sessions that burn out get archived, so long-idle samples are biased healthy.

**Conclusion: there is no evidence that fatigue carries over a wake-up — but the rubric never
looked, because it cannot see time at all.**

### 12.5 The second-order cost: a false alarm spends the one channel that works

§10's companion note (`制度修补` §6) says the protocol leans on a single sentence — *"I think I'm
tired"* — and therefore **misses the most disciplined sessions, which may be the ones most in need
of being seen**.

Now connect the two:

- `#0d3990` **is** that most-disciplined session.
- It was handed a **false L3**.
- Had it believed the number, it would have announced fatigue while having zero episodes — and
  every such announcement makes the sentence cheaper.
- It did not believe it. The sentence stayed clean **because the session could say "I just woke up"**.

⇒ A false alarm is not a cosmetic bug. **It spends the credibility of the only signal we have.**
And a 20-hour sleep is the single scenario most likely to provoke exactly that doubt.

### 12.6 What we did *not* do

| Not doing | Why |
|---|---|
| Add a time-decay term | There is no recovery curve to fit; that would be another n=1 fit, and the problem is not the time axis — it is the `maxRep` branch |
| Retire L3 | The episode signal is real: P(stall \| previous stall) = 48% vs 2.7%, and it catches all three heavy sessions |
| Lower `SPELL_L3` or raise it | Any threshold is the thing that is banned; tuning it just moves the false alarm |

What we did instead is display-only: `inflight` now shows `发作 N 次` even when the count is **0**,
and lists it for other sessions too. (The current code hides that field when it is zero — which is
precisely the field that would have told `#0d3990` "you are not sick".)

### 12.7 Lesson

> **Before touching a rubric, read the "do not" table — it is older, and it was written after someone
> already paid for that lesson.**

And the corollary from the episode above: **the rubric is not the only reader.** A session that
compares a number against its own state ("I just woke up") can beat the rubric — but only if the
number carries enough context to be argued with.
