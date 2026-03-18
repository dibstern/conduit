# AGENTS.md Progressive Disclosure Design

## Goal

Reduce the size and instruction load of the root AGENTS.md while preserving enough universal context for reliable onboarding in every session.

## Decision

Use the hybrid approach:

- Keep AGENTS.md limited to universally relevant project context.
- Move deeper architecture and verification guidance into `docs/agent-guide/*.md`.
- Use explicit read triggers in AGENTS.md so the agent knows when the deeper docs are required.

## Root AGENTS.md Content

The root file should contain only:

- a one-line environment fact that matters in most sessions,
- a short project purpose statement,
- a compact runtime architecture map,
- a short source tree map,
- default verification guidance,
- pointers to deeper docs with clear conditions for when to read them.

The root file should not contain:

- the full test command matrix,
- exhaustive per-layer architecture narration,
- long examples,
- duplicated implementation-plan guidance already covered by `docs/plans/`.

## Progressive Disclosure Rules

- Read `docs/agent-guide/architecture.md` before changing daemon, routing, relay wiring, SSE flow, session flow, instance management, or PTY behavior.
- Read `docs/agent-guide/testing.md` before choosing verification beyond the default `check` + `lint` + unit-test path.
- Read relevant files in `docs/plans/` before implementing a feature that appears to have an existing design or plan.

## Expected Outcome

- Smaller root AGENTS.md with better signal-to-noise ratio.
- Lower staleness risk because detailed guidance lives in focused docs.
- Better agent behavior than a pure index because the root file still provides immediate architecture and verification defaults.