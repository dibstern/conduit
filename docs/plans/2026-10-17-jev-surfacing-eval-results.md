# Jev surfacing eval: results (conduit-test-ahu8.1)

Date: 2026-10-17. Plan: `2026-09-26-jev-message-surfacing.plan.md`, decisions 4 and 5.

**Verdict: NO-GO.** Jev beats the keyword heuristic by 27.1 points on category accuracy, and its p95
latency is 288 ms. But when Jev says routine it is right only 77.4% of the time, and the gate needs
90%. Following the ticket's rule: close ahu8.4 as not now, keep Jev categorisation off by default, and
ship turn summaries alone under the split flag.

## Method

- **Sample.** 150 mid-turn assistant text parts, drawn with a seeded shuffle and at most 2 per session.
  A part is mid-turn when a tool call follows it in the same turn, which is the rule `segmentTurns`
  folds by. 90 parts are Claude, from top-level sessions in `~/.config/conduit/projects/*/events.db`.
  60 are OpenCode, from top-level sessions with more than 2k output tokens in OpenCode's own
  `~/.local/share/opencode/opencode.db`, because conduit's stores hold only one OpenCode text part.
  Both stores were opened read-only. Text is truncated as decision 4 says (request: first 1,000 chars;
  message: first 2,000 chars plus the last 500).
- **Labels (no human labels).** Two models labelled every part independently, from the same prompt
  and without seeing any Jev output: `claude -p --model opus` (resolved to `claude-opus-5-5`) and
  `codex exec -m gpt-6.1-sol` at high effort. Each call labelled 25 parts. The prompt used decision 4's
  instructions and the same criteria Jev gets. They **agreed on 129 of 150 parts (86.0%)**. Only the
  agreed parts are kept, so the target of 100 was met without labelling more.
- **Agreed label mix:** routine 68, finding 31, milestone 14, decision 4, replan 3, risk 3, blocked 3,
  correction 2, ask 1, scope 0. Claude 75, OpenCode 54. The most common disagreements were
  routine/milestone (4) and finding/blocked (3).
- **Jev.** One Choice per part on `jev-1.13.0`. The options are the 9 built-ins with their round-3
  `what` lines (Ask keeps its `not_for` and example), plus `routine` with the plan's text. The script
  sends decision 4's `instructions`. It ran twice: with `{request, message}` as state, and with
  `{message}` only (the question then drops its reference to `request`). It made 4 calls at a time,
  with one retry on 429/5xx. All 258 calls succeeded on the first attempt.
- **Heuristic (no AI).** Ask if the message contains a sentence-final `?` or a phrase like "should I"
  or "want me to". Blocked on "blocked", "can't proceed" or "permission denied". Risk on "risk",
  "regression" or "could break". Anything else is routine.
- **Levels (decision 5).** Jev's level is `max weight × p` over the active categories, with Key at 70 or
  more, Balanced at 40 or more, then All. It is Hidden when routine has the highest probability. A
  label's level is its category's weight with p = 1, and routine is Hidden. All weights are the
  defaults.

## Results

| Metric (129 agreed parts) | Jev + request | Jev, message only | Keyword heuristic |
|---|---|---|---|
| Category accuracy | **78.3%** | 76.7% | 51.2% |
| Accuracy on non-routine labels (61) | 59.0% | 57.4% | 0.0% |
| Routine precision | **77.4%** | 76.2% | 53.2% |
| Routine recall | 95.6% | 94.1% | 97.1% |
| Exact level agreement (Key/Balanced/All/Hidden) | 52.7% | 51.2% | 51.9% |
| Key agreement (at Key vs below) | 94.6% | 94.6% | 92.2% |
| Balanced-or-above agreement | 57.4% | 55.8% | 53.5% |
| Latency p50 / p95 / max | 217 / **288** / 436 ms | 213 / 247 / 302 ms | n/a |
| Input tokens per call: mean / p50 / p95 / max | 841 / 790 / 1,188 / 1,551 | 766 / 735 / 938 / 1,424 | n/a |

Category accuracy uses the Choice's top option. Decision 5's weighted category (argmax of weight × p)
gives the same numbers with the request, and 75.2% without it. At $0.042 per Mtok, a call costs about
$0.000035. Latency is wall-clock time from this machine.

### GO/NO-GO rule (ticket notes, applied exactly, with request in state)

| Gate | Needed | Measured | Pass |
|---|---|---|---|
| Jev category accuracy minus heuristic | ≥ 10 points | 78.3 − 51.2 = **27.1** | yes |
| Routine precision | ≥ 0.90 | **0.774** (65 of 84) | **no** |
| p95 latency | ≤ 5 s | **288 ms** | yes |

The message-only run fails the same gate (routine precision 76.2%).

## Where it fails

19 of the 84 parts Jev hides as routine carry a real category: 8 milestone, 6 finding, 2 decision,
1 replan, 1 blocked and 1 correction. One of them (blocked) is a Key-level message. Most share a
shape: a result followed by the next step, e.g. "All green: **534 files, 7023 tests**. Reviewing the
full working tree before staging…" or "Gate green. Committing 21ge, then rebasing onto main."
(p(routine) 0.98). The trailing narration is enough to pull these parts to routine.

When Jev picks a real category it is mostly right. Finding is 24 of 31, risk 3 of 3, ask 1 of 1.
Milestone is the weak one at 4 of 14. Only 3 of 68 routine parts were promoted to a category.

## Recommendations

- **Thresholds 70/40.** Keep Key at 70: Key agreement is 94.6%. The weak exact-level agreement (52.7%)
  is mostly structural. Finding and Milestone weigh 40, so `40 × p` stays below 40 unless p = 1.0, and
  33 of the 54 Balanced-labelled parts land on All. Moving Balanced to 30 lifts exact agreement to
  67.4%. The sweep's best pair (Key 45, Balanced 10, 80.6%) just merges All into Balanced, so it
  doesn't count. Round 3 already draws a p 0.80 Milestone as All, which means the design may intend
  this. Settle it in one place: either Balanced moves to 30, or Finding and Milestone are All by
  default. Change nothing while the verdict is NO-GO.
- **Default weights.** No change. The failing gate is the Hidden decision, which compares raw
  probabilities and ignores weights, so no weight can fix it.
- **Request in state.** It helps a little (+1.6 points of accuracy, +1.2 points of routine precision)
  for about 75 more input tokens. Keep it if this is revisited.
- **If revisited (not part of this verdict):** hiding only when p(routine) ≥ 0.8 would give 93.8%
  precision at 88.2% recall on this set. At 0.7 it gives 89.9% / 91.2%, and at 0.9 it gives 98.2% /
  82.4%. That cutoff was tuned on the same 129 parts, with only 68 of them routine. A second fix would
  be to sharpen the criteria: give Milestone examples like "All green: N tests", and add a `not_for`
  to routine for "a completed gate or new fact, even when followed by the next step". Either change
  needs a fresh, held-out labelled set before it could reverse this verdict.

## Limitations

- The labels come from two models, not a person, and the 21 parts they disagreed on are dropped,
  which tilts the set towards easier cases. The rare categories are thin (ask 1, correction 2,
  scope 0), so accuracy per category means little outside routine, finding and milestone.
- The OpenCode parts come from OpenCode's own store, not conduit's. They are real sessions, mostly
  conduit's predecessor (opencode-relay).

## Reproduce

```bash
# 1. Sample and label (needs claude and codex on PATH; work files go to JEV_EVAL_WORK, default /tmp/jev-surfacing-eval)
node --import tsx scripts/spikes/jev-surfacing/build-fixture.ts
# 2. Score Jev and the heuristic
export TYPESAFE_API_KEY="$(zsh -ic 'printenv TYPESAFE_API_KEY' 2>/dev/null | tail -n1)"
node --import tsx scripts/spikes/jev-surfacing/eval.ts > scripts/spikes/jev-surfacing/results.json
# Recompute metrics from saved verdicts without calling Jev
RESULTS_IN=<copy of results.json> node --import tsx scripts/spikes/jev-surfacing/eval.ts
```

Files: `test/fixtures/jev-surfacing/labelled-parts.json` holds the 129 agreed parts, scrubbed of
paths, names, hosts, emails and secrets. `scripts/spikes/jev-surfacing/{rubric,build-fixture,eval}.ts`
are the scripts. `scripts/spikes/jev-surfacing/results.json` holds the summary, the confusion matrices
and every per-part probability.
