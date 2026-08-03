# Stale Authentication Startup Recovery Plan Audit

Audit complete for `2026-08-03-stale-auth-startup-plan.md`. One auditor reviewed the single implementation task.

## Amend Plan

- Guard status responses by connection generation before handling `401`.
- Add component lifecycle coverage for `replaceRoute("/auth")` cleanup.
- Reset singleton router state and specify positive-control assertions.
- Update comments that describe the status request as UI-only.

## Accept

- `401` is unambiguous for the protected project status endpoint.
- The existing router and `App` wiring require no new registration.
- `replaceRoute("/auth")` updates `slugState` and triggers `ChatLayout` cleanup.

## Amendments Applied

| Finding | Task | Amendment |
|---|---|---|
| Stale status response race | Task 1 | Pass and validate the connection generation before handling responses; add a deferred-response test. |
| Cleanup not proven | Task 1 | Add a `ChatLayout` lifecycle test using the real router. |
| Singleton state leakage | Task 1 | Reset router state and add explicit `200` and `401` assertions. |
| Reconnect timer claim | Task 1 | Add a fake-timer test proving `disconnect()` cancels a scheduled reconnect. |
| Outdated comments | Task 1 | Update comments to include authentication recovery. |
| Delayed response-body race | Task 1 | Re-check slug and generation after JSON parsing; add a controllable `ReadableStream` response-body test. |

No user decision was required. The amended plan must be re-audited before execution.
