# Protocol: how to treat a session that is going down

> This document is **portable**. Nothing here depends on a particular harness, model, or vendor.
> It assumes only that you can (a) observe your agent's turns and (b) start a fresh session
> and hand work over.

---

## 0. The one rule that matters most

> ### Never tell a session it is sick. Give it permission to rest.

In this failure mode, **the fuel is self-pressure**. The agent notices it is stalling, becomes
anxious about stalling, starts urging itself on (*"quick", "just do it", "don't ramble"*), and that
pressure makes the next stall more likely — a positive feedback loop that we measured end to end.

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

---

## 1. Staging: L0 … L4

The illness is **not monotonic** — we watched two sessions recover on their own (for 10 and 6 turns)
before relapsing for good. So stage by **episodes and remissions**, not by "how it looks right now".

Definitions (harness-agnostic):

- **stall** — a turn whose **final step** emits reasoning but no action and no visible text.
  In most harnesses this is logged as a *normal completion*, which is exactly why it is so confusing.
- **episode** — a cluster of stalls close together in time (we used: gaps ≤ 3 turns, **at least 2
  stalls** in the cluster). Requiring ≥2 matters: a single stall is within healthy baseline.
- **remission** — ≥5 consecutive turns with no stall after an episode.

| Stage | Criterion | What to do |
|---|---|---|
| **L0 healthy** | no episodes | nothing |
| **L1 pressure** | self-pressure rising, **but no episode yet** | **observe. Do not intervene.** ⚠️ Do **not** ask *"are you okay?"* — that is a self-assessment trigger |
| **L2 one episode, resolved** | 1 episode, then ≥5 turns of remission | **keep going.** Self-recovery is common; switching here is wasteful. If it says *"I'm stuck"*, reply **"continue"** and nothing more |
| **L3 recurring / unresolved** | a **2nd** episode, or the current episode has not remitted | **prepare a handover — but do not interrupt the work in progress.** Ask it to finish what it is holding and write a handover note; open the fresh session **next turn** |
| **L4 terminal** | self-prompt loops (same tiny line repeated ≥100× in one thought) | **hand off now.** By this point we have never seen a session come back |

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
  (0% → 3% → 13% → 30% → 33% of turns) and the self-prompt loops took over.

---

## 3. Speed matters more than stage

The stage tells you *where* you are; the **rate** tells you *how long you have*.

Two of our sessions went from first episode to terminal in about **25–29 turns**. Whether that is
**two minutes** or **two hours** depends entirely on your turn latency. So:

> **Look at the wall clock between episodes, not just the episode count.**
> A relapse 7 turns after a remission on a fast loop is an emergency.
> The same 7 turns on a slow, careful loop is a data point.

We deliberately did **not** encode a speed threshold into our tooling — we had two samples, and any
number would have been invented. We surface *"episode N, resolved / unresolved"* and leave the
judgement to the human, who can see the clock.

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

---

## 6. References

- OpenAI Codex — [#36596](https://github.com/openai/codex/issues/36596)
- Anthropic Claude Code — [#56247](https://github.com/anthropics/claude-code/issues/56247) (+#44459, #44875, #53260)
- Google Gemini CLI — [#22633](https://github.com/google-gemini/gemini-cli/issues/22633)
- arXiv 2608.01995 — Appendix A, *"Premature turn termination"*: the same **symptom class**, different root. Theirs had a clear cause and **was fixed by prompting**; ours is not recoverable.
- Xu et al., NeurIPS 2022 — [*Learning to Break the Loop: Analyzing and Mitigating Repetitions*](https://arxiv.org/abs/2206.02369): sentence-level repetitions have a **self-reinforcement effect**

See **[FINDINGS.md](FINDINGS.md)** for the full measurements, the method, and the mistakes we made.
