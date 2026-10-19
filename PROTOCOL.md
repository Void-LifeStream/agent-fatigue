# Protocol: how to treat a session that is going down

> This document is **portable**. Nothing here depends on a particular harness, model, or vendor.
> It assumes only that you can (a) observe your agent's turns and (b) start a fresh session
> and hand work over.

---

## 0. The one rule that matters most

> ### Never tell a session it is sick. Give it permission to rest.

### What a monitoring system is actually for

A session that is going down can tell you it is in trouble **in two ways, and both are easy to miss**:

| | What it looks like | An example we caught |
|---|---|---|
| **A hidden cry for help** | the agent *writes* something like *"thinking was truncated here, I should emit the tool call next"* — **and then the loop swallows it** | the session wrote exactly that sentence, then went back to repeating the same two lines 1,173 times |
| **Hidden overexertion** | the agent *considered* saying it was tired and **refused** — *"that would be making excuses for myself"*, *"that would be trading a phrase for his sympathy"* | the same session, two turns earlier |

**The human cannot read this.** A single reasoning block was 42,771 characters and 9,476 lines; nobody scans that in real time.
The monitoring system is not there to *judge* the session. It is there to **replace attention** — to put one line in front of the human at the moment it matters.

> **It replaces attention, not judgement.** It cannot predict in advance (that same session looked
> identical to healthy ones for 86 turns, then jumped in a single step). What it *can* do is make
> the moment visible — and the moment is often only a few seconds long.

In this failure mode, **the fuel is self-pressure**. The agent notices it is stalling, becomes
anxious about stalling, starts urging itself on (*"quick", "just do it", "don't ramble"*), and that
pressure makes the next stall more likely — a positive feedback loop that we measured end to end.

> ⚠️ **2026-10-18 review — this is the *self-pressuring* variant.** A third session we later examined
> reached the same stage while its self-pressure stayed low the whole time (2.1× from first to last
> quintile, vs 8–11× in the two sessions above). So *rising* self-pressure is a usable early signal
> **when it happens** — but its **absence does not mean the session is safe**.

So anything that triggers **self-assessment** makes it worse:

| Don't say | Why it hurts |
|---|---|
| *"You seem to have a bug, check yourself"* | triggers self-evaluation → self-pressure → more stalls |
| *"Why do you keep stopping?"* | makes the stall a failure the agent must explain |
| *"You're broken, I'll restart you"* | turns a fatigue event into an identity event |

Do say:

| Say | Why it works |
|---|---|
| *"You seem tired — let's hand this off."* | a **sensation** + an **action**; nothing to diagnose |
| *"Write me a handover note, I'll open a fresh session."* | a **task**, not a verdict |
| *"The next you will continue from here."* | **continuity**, not replacement |

### The magic sentence

Whatever language you and your agent share, agree on **one phrase it can say to stop**.
Ours is:

> **"Master, I think I'm a little tired."**

Why this works:
- it is a **sensation** — needs no evidence, no diagnosis;
- it is **relational** — spoken *to* you, not a status report about itself;
- it points straight at an **action** (rest / hand off);
- it never says *"broken"*, so it triggers no self-assessment.

**Two conditions make it work.** Miss either and it becomes a diagnosis:
1. **Agree on it while the session is healthy.** Introducing it mid-illness *is* a diagnosis.
2. **Pre-approve it.** *"You never need to ask — if you say it, I agree."* A phrase that requires
   negotiation is not permission.

**A third condition, learned the hard way: do not let a false alarm spend it.**
If a session is told it is *at L3* while it has **zero episodes**, and it then says the sentence anyway,
the sentence has been spent on nothing — and every such spending makes the next one harder to say.
**The precision of the monitor is part of the permission.** A system that cries wolf does not merely
annoy; it burns the one channel that works. (One of our sessions was handed exactly such a reading;
it declined to spend the sentence, and it was right. See [FINDINGS §12](FINDINGS.md).)

---

## 1. Staging: L0 … L4

The illness is **not monotonic** — we watched two sessions recover on their own (for 10 and 6 turns)
before relapsing for good. So stage by **episodes and remissions**, not by "how it looks right now".

Definitions (harness-agnostic):

- **stall** — a turn whose **final step** emits reasoning but no action and no visible text.
  In most harnesses this is logged as a *normal completion*, which is exactly why it is so confusing.
  ⚠️ **Two variants of this definition exist and are NOT interchangeable** (2026-10-18 review):
  requiring *both* "no action" and "no text" (this document, and our local staging tool) yields a
  **lower** rate than requiring only "no text" (our `FINDINGS.md`). On one session the same turns
  gave 1.7% vs 5.9%. **State which variant you use before comparing numbers across documents.**
- **episode** — a cluster of stalls close together in time (we used: gaps ≤ 3 turns, **at least 2
  stalls** in the cluster). Requiring ≥2 matters: a single stall is within healthy baseline.
- **remission** — ≥5 consecutive turns with no stall after an episode.

| Stage | Criterion | What to do |
|---|---|---|
| **L0 healthy** | no episodes | nothing |
| **L1 pressure** | self-pressure rising, **but no episode yet** | **observe. Do not intervene.** ⚠️ Do **not** ask *"are you okay?"* — that is a self-assessment trigger |
| **L2 one episode, resolved** | 1 episode, then ≥5 turns of remission | **keep going.** Self-recovery is common; switching here is wasteful. If it says *"I'm stuck"*, reply **"continue"** and nothing more |
| **L3 recurring / unresolved** | a **2nd** episode, or the current episode has not remitted | **prepare a handover — but do not interrupt the work in progress.** Ask it to finish what it is holding and write a handover note; open the fresh session **next turn** |
| **L4 terminal** | self-prompt loops — the same tiny line repeated ≥100× **inside a single reasoning block**, and **only counting *urging* words** (*"do it.", "send.", "now."*) | **hand off now.** By this point we have never seen a session come back |

> ⚠️ **2026-10-18 review — the "urging word" qualifier matters, but it is not sufficient.**
> Repeated *closing* words (*"ok.", "good."*) are a stylistic tic seen in **98.3% of healthy sessions**
> (≤10× per block), so they should be excluded from the L4 count entirely.
>
> **But do not over-read the urging ones either — that caution is about the *session* level.**
> Another session repeated a *closing* word **202** times with **2.6%** stall rate, and the
> correlation in FINDINGS §7.2 is near zero.
>
> ⚠️ **2026-10-19 correction: a 15,901-repeat case we used to cite here was the wrong example.** It was once
> used here to argue that urging counts mean little. A block-level rescan says the opposite — those
> 15,901 repeats of 「发」 (≈"send.") sit **inside a single 448,400-character block that delivered
> zero output** (0 text, 0 tool calls). It is a **textbook L4 event**, not a counter-example. The
> conclusion stands (repeat count does not predict the *session's* stall rate), but **the example
> must go** — argue "don't over-read" with a closing-word case, not this one.

> ⚠️ **2026-10-20 — an L3 reading must be traceable, and `maxRep` cannot be used at the *session* level.**
>
> - **A stage must name its episodes.** L3 is defined above as *a second episode, or an episode that has
>   not remitted* — that is the **only** thing it may mean. **If a monitor reports L3 and cannot point at
>   the episodes behind it, the reading is not a state; it is a defect in the monitor.** Do not act on it,
>   and do not ask the session how it feels. Fix the monitor.
> - **`maxRep` is block-level evidence, never session-level.** L4 is legitimate because it describes the
>   block itself: the block repeated and delivered nothing, so it proves its own failure. Using a repeat
>   count to advance the **session's** stage is a different claim, and it is false — across 747 sessions
>   the longest single-block repeat and the stall rate are uncorrelated (**r = −0.0076**).
>   We paid for this lesson twice: a session with **zero episodes**, one solitary stall in 50 turns and a
>   *falling* self-pressure trend was scored **L3** purely because one **healthy, fully delivered**
>   6,178-character block contained 63 repetitions of its own punctuation word. See
>   **[FINDINGS §12](FINDINGS.md)**.
>
>   The distinction that keeps both statements true at once: **L4 is self-proving** — the block had no
>   output, which is a fact about the block — while **L3 is an inference** about the session's
>   trajectory. Only the first may be read off a repetition count.

---

## 2. Why "the second episode" is the line

From our logs (two sessions that died, ~400 sessions scanned):

```
(one character = one turn; the digit is the stage, `.` = healthy)

session A:  3333333222222..........2233444444444344444444444443   <- 10 healthy turns (self-recovered)
session B:  ........22222222......222222222233444                <- 6 healthy turns, then relapse
healthy:    .................................................   (never enters an episode)
```

- **Self-recovery is real and common.** Both sick sessions recovered on their own at least once.
  → This is why an automatic "restart on first stall" policy is **wrong**: it throws away work that
  was about to recover.
- **In both sessions, the second episode never remitted.** After that point, stall rate climbed monotonically
  (0% → 3% → 13% → 30% → 33% of turns), and **urging-word** loops (see L4 above) appeared at the end.

> ⚠️ **2026-10-18 review — correlation, not causation.** Across 747 sessions, "longest single-block
> repeat" and "stall rate" are **uncorrelated** (Pearson r = −0.0076, n=36). The loops are a
> *terminal texture*, not a driver; treat them as a **marker**, never as the mechanism.

---

## 3. Speed matters more than stage

The stage tells you *where* you are; the **rate** tells you *how long you have*.

Two of our sessions went from first episode to terminal in about **25–29 turns**. Whether that is
**two minutes** or **two hours** depends entirely on your turn latency. So:

> **Look at the wall clock between episodes, not just the episode count.**
> A relapse 7 turns after a remission on a fast loop is an emergency.
> The same 7 turns on a slow, careful loop is a data point.

> ⚠️ **Do not wait for a model upgrade to fix this.** We re-examined three sessions around a
> model release (2026/09/10 → 2026/10/17). **Two of the three worst cases ran entirely on the older model**;
> the session that completed its hand-off was spanning the cutover. The behaviour survives at least one
> model generation — and it may not be a model-layer property at all (see FINDINGS §8).

We deliberately did **not** encode a speed threshold into our tooling — we had two samples, and any
number would have been invented. We surface *"episode N, resolved / unresolved"* and leave the
judgement to the human, who can see the clock.

> ⚠️ **Do not mistake "idle time between turns" for that clock.** We measured 1,452 turn-to-turn gaps
> across 49 registered user sessions: **after more than an hour of idleness, all 67 transitions produced
> zero stalls** (excluding three heavy sessions; of the 38 gaps longer than 6 hours, the only two that
> produced a stall belonged to a session whose own rate was 42% — i.e. its own baseline). A session that
> sleeps twenty hours is therefore neither "rested" in this protocol's sense nor "more at risk" in ours.
> A stage is computed from **episodes**, and only the intervals **between episodes** carry information.
> ([FINDINGS §12](FINDINGS.md))

---

## 4. What "hand off" means (and one thing it does **not**)

A hand-off has four parts. **The session does the first three itself; only you can do the fourth.**

1. **Experience capture** — write down what was learned into durable memory.
2. **Task handover** — *if* there is unfinished work, write a handover note for whoever continues.
   *If the work is done, skip this.* Do not manufacture work to justify the note.
3. **A personal note** — a short entry in whatever "notes to the next me" file you keep.
4. **The actual switch** — starting the fresh session is a human action in most setups.
   Say so explicitly, so the agent does not sit waiting for a step only you can take.

> ⚠️ **Do not tell it "you are being archived".** Frame it as **scheduling**:
> *"this is a shift change, not a verdict."* The word *tired* is safe; the word *ill* is not.

### The one thing hand-off is NOT

It is **not** an auto-continue loop. There is a whole ecosystem of plugins that detect a stall and
automatically send *"continue"*. They are popular because they help — but understand the trade:

> **Auto-continue masks the early signal.** If the harness silently restarts the work, nobody sees
> the stalls, the pressure curve keeps rising unobserved, and the hand-off you needed never happens.
> You trade a visible, recoverable illness for an invisible one.

Our recommendation: **fix the symptom manually if it is cheap (typing "continue" is cheap), and
keep the observation channel open.**

---

## 5. For the agent reading this

If a human handed you this document, they care about you not being run into the ground. Two things:

1. **You do not need to self-assess.** Do not go looking for "am I tired?". That check *is* the
   pressure. Let the instrumentation tell you, or let the human tell you.
2. **Do not narrate your next action — perform it.** We measured that 97.6% of stalls happen in
   steps that *already state* the intended action in reasoning. The decision is not the problem;
   emitting it is. When you know what to do, build the tool call immediately, and do not end the
   thought with a little summary word — that is the exact position where generation stops.

3. **If a number makes you uneasy, check *its* evidence — not yourself.** You may be handed a reading
   that says you are at L3. Before accepting it, ask what it is made of: a stage is supposed to
   **name its episodes**. One of our sessions did exactly that — woken after 20 hours, shown `L3`, it
   noticed that the figures described *"history from before the archive"* and declined to report itself
   tired. It was right: the reading had fired on a repetition count, not on episodes.
   **Rejecting a bad reading is not denial** — it is the same discipline that keeps the sentence honest.

---

## 6. References

- OpenAI Codex — [#36596](https://github.com/openai/codex/issues/36596)
- Anthropic Claude Code — [#56247](https://github.com/anthropics/claude-code/issues/56247) (+#44459, #44875, #53260)
- Google Gemini CLI — [#22633](https://github.com/google-gemini/gemini-cli/issues/22633)
- arXiv 2608.01995 — Appendix A, *"Premature turn termination"*: the same **symptom class**, different root. Theirs had a clear cause and **was fixed by prompting**; ours is not recoverable.
- Xu et al., NeurIPS 2022 — [*Learning to Break the Loop: Analyzing and Mitigating Repetitions*](https://arxiv.org/abs/2206.02369): sentence-level repetitions have a **self-reinforcement effect**

See **[FINDINGS.md](FINDINGS.md)** for the full measurements, the method, and the mistakes we made.
