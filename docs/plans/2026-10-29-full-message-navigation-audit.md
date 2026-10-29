# Full-session navigation audit synthesis

Three task audits identified ownership and ordering gaps in the initial plan. All are addressed in the amended plan; no user design decision is outstanding.

- Task 1: private drawer owners, primary object alias preservation, projection/session-effect separation, guarded cleanup and project capture, and real same-session subscriptions in tests.
- Task 2: a separate server-derived index, explicit bounded snapshot continuation frames, chronological bounds applied to bodies/checksums, historical refresh semantics, and scoped read sharing. No unary page/live-stream race.
- Task 3: requested versus observed placement, logical latest versus physical bottom, explicit replacement/prepend transitions, actual-view fork expansion and latest-only saved-cache writes.

Auditors recheck their amendments before implementation. Beads `conduit-test-lm8n7.1–3` record execution, reviews and validation. The main worktree's unrelated provider changes are excluded.
