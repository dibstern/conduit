# Stale Authentication Startup Recovery

## Problem

After a daemon restart, an open or service-worker-cached SPA can retain an invalid `relay_session` cookie. The project page renders, but `/p/:slug/api/status` returns `401` and every WebSocket upgrade fails with `auth_failed`. The frontend ignores the status response and retries forever, so the browser appears to start slowly even though the CLI server is ready.

## Evidence

- The daemon HTTP edge returned in 40-46 ms.
- An isolated no-PIN cold start reached `ws:open` in 1.09 s; warm reloads reached it in 140-213 ms.
- The real daemon log recorded repeated `auth_failed` WebSocket upgrades from the same browser client for hours.
- The debug panel reproduced `connect -> ws:create -> ws:error -> ws:close -> reconnect:schedule` without `ws:open`.

## Design

Treat `401` from the existing relay-status request as an authentication state transition. `fetchRelayStatus` will ignore responses from obsolete connection generations, then call `replaceRoute("/auth")`, which updates `slugState`, unmounts `ChatLayout`, and runs its WebSocket cleanup. The auth route replaces the broken project URL in browser history. Successful PIN entry keeps the existing behavior of navigating to the dashboard.

Other non-success status responses keep their current behavior. This change does not persist auth sessions, alter cookie security, or change service-worker caching.

## Testing

Add frontend store regression tests that run the real `connect(slug)` path with `401`, `200`, and stale deferred status responses. Add component lifecycle coverage proving that replacing the project route with `/auth` runs `ChatLayout` cleanup without reconnecting. Keep the existing reconnect-stream tests green, then rerun the browser timing loop and the visual acceptance gate.
