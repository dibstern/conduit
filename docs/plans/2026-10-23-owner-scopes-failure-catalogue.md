# Owner Scopes: failure catalogue (conduit-test-82tn.38)

Written before implementation. Each numbered failure is exercised through the
Owner Scopes service, its checked acquisition boundary, or the source guard.
The referenced 2026-10-22 Run Ledger catalogue is absent from this checkout;
this follows the existing daemon-store import failure-mode table style.

An Owner Scope is a daemon-owned lifetime, separate from the session list Scope
and browser connections. Project Provenance resolves sessions through
`SessionDirectory`. Tests use Deferred gates, never elapsed-time assumptions.

## Opening and acquisition

| Id | Failure | Expected |
|---|---|---|
| OS01 | Concurrent project or session lookups create duplicate owners | One lazy handle per identity in the current owner generation. |
| OS02 | A cold session is attached to the browser's current project | Its stored Project Provenance selects its parent, including a non-first project. |
| OS03 | Session provenance is unknown or its read fails | Typed provenance failure; no guessed owner. Preserve a directory read error. |
| OS04 | A retained handle acquires after close | Typed `OwnerScopeClosedError`, before the acquisition's side effects. |
| OS05 | Reconnect looks up a closing or unregistered project | Opens fail typed during close; every project lookup checks current registration, including cached owners. A registered project can open a fresh generation after close completes. |
| OS06 | Acquisition is in flight when close starts | Close fences new acquisition immediately and waits for the admitted acquisition and its release. |
| OS07 | Provenance lookup completes after its project is removed | Session opening rechecks registration and fails typed; stale provenance cannot resurrect an unregistered project. |
| OS08 | Acquisition fails after registering an earlier resource | The registered resource still releases on owner close; later acquisition remains usable. |
| OS09 | Project removal happens before the first lookup | Unregistered projects fail with `OwnerScopeProjectNotRegisteredError`; re-registration permits opening. Explicitly closed session ids remain fenced. |
| OS25 | Reconnect finds a cached open handle after its provenance disappears or changes | Typed provenance failure; a cached lifetime must not bypass current stored ownership. Added during review, before the regression test and fix. |
| OS26 | Removing and re-adding the same directory reuses its project id within one daemon lifetime | Re-registration opens fresh project and session owners after close completes. Old handles stay closed, new owners acquire successfully, and old finalizers run exactly once. Added before the follow-up regression test and fix. |
| OS27 | An explicit session close after project re-registration targets a retired session entry | Explicit session-id closes remain fenced across project generations, before or after the fresh parent opens; old finalizers never run twice. Added during follow-up review, before its regression test and fix. |

## Closing

| Id | Failure | Expected |
|---|---|---|
| OS10 | Removing a project skips sessions or affects another project | All descendants release, sibling projects survive. Sequential scopes unwind in hierarchical LIFO order, with child scopes ordered where they were acquired. |
| OS11 | Removing one session closes its siblings or project | Only that session releases. Parent and sibling handles remain usable. |
| OS12 | Restart detaches server attachments but kills detached owners | Finalizers receive `detach` in the close Exit; runner, PTY and OpenCode stand-ins remain running. |
| OS13 | Removal accidentally uses restart semantics | Finalizers receive `remove` and stop those stand-ins. |
| OS14 | A second close returns before the first teardown finishes | Both await the same teardown, each release runs once. |
| OS15 | Detach and remove race, or arrive in opposite orders | First close wins per owner, including an in-flight close. Later callers join it. |
| OS16 | A release defects | Remaining releases still run; close reports a typed error retaining the cause. Repeated close reports the same failure. |
| OS17 | The caller of close is interrupted | Teardown finishes, and subsequent close joins the completed result. |
| OS18 | Session close is already running when project close starts | Project close awaits the child's existing teardown. No early completion or duplicate release. |
| OS19 | Server work outlives its owner | Fibers acquired with `forkScoped` end on close, including detach. Detached process survival is the resource finalizer's reason-dependent policy. |

A remove racing daemon detach leaves detached project owners running; post-restart reconciliation in 82tn.14/15 must stop owners of projects no longer registered.

## Daemon, reconnect and run ordering

| Id | Failure | Expected |
|---|---|---|
| OS20 | Daemon scope closes, including startup failure | Every opened owner closes with `detach`; retained handles and lookups reject new work. |
| OS21 | A replacement daemon reuses closed handles | A fresh service generation opens fresh handles and can adopt still-running detached resources. |
| OS22 | A browser's request scope ends during a run | Its owner remains open; reconnect returns the same handle. No browser scope owns execution. |
| OS23 | A process-loss callback races owner close before the Run Ledger lands | Only scope closure is implemented. One marked `82tn.32.12` seam immediately before teardown reserves settlement with `projectInactive`; there is no premature ledger implementation. |
| OS24 | Moved daemon modules start unowned fibers or raw timers | The guards project scans daemon domain Services and Layers recursively, rejects detached forks/runtime launches/raw timers, and detects synthetic violations, including ordinary aliases added during review before extending the guard. Existing unrelated calls have exact, counted exemptions. |

OS23 intentionally tests the reserved integration seam, not run settlement or
tombstone semantics. Those require 82tn.32.12. Resource migrations and real
runner/PTY/OpenCode registration in these scopes belong to 82tn.10.6, 10.7, 12
and 14. Existing isolated daemon process tests remain the restart regression
proof for those detached owners.
