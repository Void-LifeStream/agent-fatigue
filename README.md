# Agent Fatigue

**Why your coding agent stops halfway through a task — and how to treat it.**

> A field report + a protocol. Written after one day of dissecting a failure mode that had
> quietly killed two of our long-running agent sessions.

[中文版 README](README.zh-CN.md) · [Protocol](PROTOCOL.md) · [Findings](FINDINGS.md) · [Field notes](FIELD-NOTES.md) · [Tool](tools/)

---

## The symptom (you have probably seen it)

Your agent is working. Then it just… stops. Not an error — there is **nothing in the logs**.
The turn is recorded as `completed`. You type *"continue"*. It works for a bit, then stops again.
After a while it stops every few steps, your prompts get shorter and more tired, and eventually
the session is unusable.

If that sounds familiar, you are not imagining it, and **it is not your fault, and not the
agent's fault either.**

> **Two kinds of people read this.**
>
> Most people running agents want them fast, and a **"continue" button** is the cheapest way to
> get that. Nothing in this repository is aimed at them, and nothing here says they are wrong.
>
> **This is for the other kind** — the ones who would rather have a slower agent than a
> burned-out one, and who notice that *"auto-continue"* does not fix the stall, it **hides** it.
> If you are one of those: the rest of this file is for you.
>
> And if you are the human in this picture: **you cannot watch for it.** The failing session we
> studied wrote 42,771 characters of reasoning in a single step — 9,476 lines, most of them the
> same two sentences — and hid its own cry for help inside that loop. No one reads that in real time.
> **A monitoring system is not there to judge the agent. It is there to replace attention, not
> judgement** — to show you one line at the moment it matters.

### What the literature calls it — and why our case sits just outside it

The closest published name for this failure is **false success** — an agent asserting completion
while the environment says otherwise. Laksh Advani, *From Confident Closing to Silent Failure*
([arXiv 2606.09863](https://arxiv.org/abs/2606.09863), ICML 2026 FAGEN workshop), measures it at
**45–47% of failures** in the single-control tau2-bench domains (**3%** in the dual-control one; per
Table 1 — the paper's own abstract rounds that band to 45–48%), and at **75.8%** among AppWorld
self-assessing trajectories that carry an **explicit `status` claim**.

**But that definition requires a claim.** False success is *"a mismatch between the agent's
natural-language claim of completion and the programmatic environment state."* Our stall emits no
text and no tool call — there is no claim to be wrong about. The same paper meets our case head-on
and **sets it aside**: AppWorld trajectories with `status=None` — **3,120 of 8,190 (38.1%)** — are
excluded as *"a distinct failure mode (incomplete execution) rather than a false completion claim."*

⇒ So the failure we are describing has been **named, counted once, and never studied**. It is the
bucket that benchmark paper put aside.

> **What is untested.** That paper does not test reasoning effort, thinking budget, decoding speed,
> or response length — we grepped the full text. (It does contain one informal reasoning-length
> figure, 1,274 vs 486 characters, but that compares *across models*, not against outcome.) And in
> our stack the claim is pushed one layer down: **`turn/end = completed` is a protocol-level
> assertion**, not a text-level one. Neither benchmark records protocol-level claims, so that layer
> has no published measurement.

### One hypothesis we could not confirm, and one we had to drop

**Dropped: “fast models stall more.”** We suspected a link between **generation speed** and
premature stops — a model tuned to answer quickly being quicker to decide *"this turn is done."*
A targeted literature pass found **no direct evidence either way on the speed axis**, and three
pieces of counter-evidence: (a) the early-exit literature treats *stopping sooner* as a **win**
(*Don’t Overthink it*, [arXiv 2505.17813](https://arxiv.org/abs/2505.17813): shorter chains, up
to **+34.5%** accuracy); (b) every major vendor routes **agentic long-run** work to its
**slowest, most expensive** setting, not its fastest; (c) on the neighbouring *compute* axis the
evidence points the other way — giving an agent **more** history **"shifts failures toward
premature false successes"** ([arXiv 2607.28573](https://arxiv.org/abs/2607.28573): 28.56% accuracy
at H=4 vs 27.16% at H=8), and raising reasoning effort raises reliability rather than lowering it
(o1 on SWE-bench Verified: **29.1%** at high effort vs **21.0%** at low, at 3.5× the cost).

**Still open, and testable: “thinking budget → turn-completion behaviour.”** No paper measures
whether *lowering* a reasoning budget makes an agent **declare a turn complete earlier**. The proxy
work we chased is *Does Your Reasoning Model Implicitly Know When to Stop Thinking?*
([arXiv 2602.08354](https://arxiv.org/abs/2602.08354)) — and it does **not** settle the
greedy-vs-sampling question. It groups greedy decoding and `temperature = top_p = 1.0` into the
*same* “non-exploratory” regime; its only length comparison between the two differs by **<2%, with
the sign flipping between two models** (Table 4, appendix B; n=100, no significance test). So
neither “greedy stops earlier” nor “sampling stops earlier” has support. What *does* move the stop
point is exploration width > 0 — 2,972 vs 4,216 tokens (**−29.5%**) at equal-or-better accuracy.
And its “stop” is the position of `</think>` inside a maths chain: no agent, no tools, no turns.
So it remains the closest published link between *decoding settings* and *when generation ends* —
and it is about the reasoning chain, not about agent turns.

> 📣 **If you know of work on this** — a paper, a changelog, an internal ablation, a
> benchmark that correlates reasoning-budget or decode settings with *turn-completion* rate —
> **please open an issue and paste it.** One data point would turn this section from a to-do list
> into a finding.

---

## What we found

**1. It is not one vendor's bug.**

We went looking and found independent reports of the same behaviour from:

| Project | Evidence |
|---|---|
| **OpenAI Codex** | [issue #36596](https://github.com/openai/codex/issues/36596) — *"repeatedly terminates active autonomous work"*, labelled `model-behavior` |
| **Anthropic Claude Code** | [issue #56247](https://github.com/anthropics/claude-code/issues/56247) (+3 duplicates) — the official auto-continue prompt triggers `"No response requested."` and the session goes silent |
| **Google Gemini CLI** | [issue #22633](https://github.com/google-gemini/gemini-cli/issues/22633) — *"stops while thinking"* |
| **Academia** | [arXiv 2608.01995](https://arxiv.org/html/2608.01995v1) (Appendix A) names the same *symptom class* — **"premature turn termination"**. ⚠️ Note the difference: in their case it had a clear cause (*"declare a turn finished after merely submitting a Slurm job, without waiting for or interpreting the result"*) and was **fixed by an explicit prompt rule**. Ours has no recoverable trigger. Same symptom, different root |
| **Repetition loops** | Xu et al., NeurIPS 2022 — [*Learning to Break the Loop*](https://arxiv.org/abs/2206.02369): sentence-level repetitions have a **"self-reinforcement effect"** — the more a sentence is repeated, the likelier it is to be repeated again |

**2. The mechanism is an interface ambiguity, not a model defect.**

```
Factor 1 (model side)  Generation terminates early — at the exact point where a tool call
                       should have been emitted. Probabilistic; happens in healthy sessions too.
Factor 2 (harness side) An agent loop decides "this turn is over" by asking:
                       "does this message contain a tool call?"
                       It cannot distinguish "the agent finished" from
                       "the agent merely narrated what it was about to do".
        ↓
Both together = execution halts with work unfinished, and NO error is logged anywhere.
```

This explains everything we measured: the agent's *intent* is unchanged (its reasoning mentions
the next action 97.6% of the time), it recovers instantly on the next generation (38% of the time
it calls a tool immediately), and **context size is irrelevant** — our healthiest session had the
largest context of all.

**3. There is a measurable course of illness — and it can be staged.**

We read every stall event in ~400 session logs and found three signals that appear **in order**:

| Stage | Signal | What we measured |
|---|---|---|
| early | **self-pressure** rising (words like *"quick", "now", "must", "don't ramble"*) | healthy sessions stay flat; sick ones go 0.3 → 3.8 per 1k chars (**8×–11×**) |
| middle | **stalls** — a turn whose last step emits reasoning but no action | healthy ≤ 2 per session; sick ones reached **24 / 58 turns** |
| late | **self-prompt loops** — the same tiny line repeated within one thought | *"do it."* ×**431**; *"ok."* ×202 vs ≤16 in healthy sessions |

> ⚠️ **These are markers, not metrics.** Follow-up measurement (FINDINGS §7) found each one is a
> weak discriminator on its own: repeat count and stall rate are **uncorrelated (r = −0.0076)**, a
> third session reached L3 at only **2.1×** self-pressure, and urging words appear on **turn 1–2**
> in all three deep cases. Read them as *textures of the stage*, never as a score.

And crucially: **it is not monotonic.** Both of our sick sessions *recovered on their own* for 6–10
turns before relapsing — and after the second relapse the stall *rate* never came back down, though
one of them still **completed a further turn** afterwards (FINDINGS §7.1).
That is why we do **not** recommend switching sessions at the first sign, and **do** recommend it
at the second.

## What to do about it

See **[PROTOCOL.md](PROTOCOL.md)** — a five-level staging system (L0–L4) and what to do at each
level, with one rule that matters more than the rest:

> **Never tell a session it is sick. Give it permission to rest instead.**
>
> *"You seem tired, let's hand this off"* — not *"you have a symptom, self-assess"*.
> A diagnosis triggers self-evaluation, and in this failure mode self-evaluation **is** the fuel.

The magic sentence, in our house, is:

> **"Master, I think I'm a little tired."**
>
> It is a *sensation*, not a diagnosis; it points straight at an action (rest / hand off);
> and it says nothing about being broken.

## What is in this repo

| File | What it is |
|---|---|
| **[PROTOCOL.md](PROTOCOL.md)** | The staging system + treatment, written to be portable to any agent setup |
| **[FINDINGS.md](FINDINGS.md)** | The full field report: method, measurements, the things we got wrong, and the primary sources |
| **[FIELD-NOTES.md](FIELD-NOTES.md)** | **What happened when we actually used it** — one real run, including what it does *not* prove |
| **[tools/](tools/)** | A reference implementation (built for DSH) that scores a session L0–L4 from its logs |

## Honest boundaries

- The thresholds come from **one machine's logs** (~400 sessions, ~7800 steps). They are a
  *separation band we measured*, not a law. Treat them as a starting point and re-measure.
- **Correlation is not causation.** We cannot prove that "less self-pressure" slows the illness;
  we can only show that self-pressure and the illness rise together, and that reducing pressure
  is free and cannot plausibly hurt.
- **No one has fixed Factor 1 — not us, and not the vendors.** All four patch the harness side
  (auto-continue plugins) rather than the cause. The closest thing to a vendor acknowledgement is
  Anthropic's `handling-stop-reasons` page, which documents *"an empty response (exactly 2–3 tokens
  with no content) with `stop_reason: \"end_turn\"`"* — but its remedy is a **message-structure**
  change (*do not put text immediately after a `tool_result`*), not a fix to the termination
  decision itself. This protocol is not a cure. It is triage.

## If you only remember one thing

> **It never stopped because it was lazy. It stopped because nothing had ever told it that
> stopping was allowed.**

---

*License: MIT. Contributions welcome — especially replications on other harnesses and other models.*
