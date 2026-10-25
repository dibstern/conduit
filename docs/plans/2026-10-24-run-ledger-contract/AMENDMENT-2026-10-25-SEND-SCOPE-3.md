# Amendment 2026-10-25: one admission path (Q22 = A)

Approved 2026-10-25. This file wins over every other file in this folder, including
`AMENDMENT-2026-10-25-SEND-SCOPE-2.md` (SEND-SCOPE-2) and
`AMENDMENT-2026-10-25-SEND-SCOPE.md` (SEND-SCOPE), which it tightens.

User-facing behaviour is unchanged.

## Why

After SEND-SCOPE-2, review rounds 2 and 3 found material bugs only on recovery. Recovery
replays sends that were pending when a runner died, and it admitted them on its own,
outside the provider instance:

- It opened handles in the process runner, so a send could get a handle that no ordinary
  path knew about.
- The Claude resume fallback replaced the send's `sinkId` but kept the old handle, so the
  binding check missed and the recovered message could end with no terminal.
- A recovered send refused at the admission timeout was closed by nobody. Each closer
  excluded recovered sends, so its handle stayed `Queued` for good.

Handles were opened in five places (the provider instance, recovery, adoption on
reattach, and two `send ?? open(...)` fallbacks). Every place that admits a send has to
repeat the close-on-refusal rules, and recovery did not.

## S6. One admission path

- **The provider instance is the only admitter.** It alone opens send handles. Every send
  enters through its one admission, with an origin:

  ```ts
  type SendOrigin =
    | { readonly _tag: "Fresh" }      // a user's send
    | { readonly _tag: "Recovered" }  // a persisted pending command replayed after a runner restart
    | { readonly _tag: "Adopted" };   // a send a reattached runner still holds
  ```

  Recovery and adoption read what needs admitting and hand it to that admission through
  a capability the provider instance gives the runner. They do not open, close or
  re-key handles themselves.
- **A send command always carries its handle.** The runner's send command takes the
  handle as a required argument. There is no `send ?? open(...)` fallback.
- **Admission owns every refusal.** Any exit before the runner accepts the send (failure,
  admission timeout, cancel, interruption, shutdown) closes the handle, whatever the
  origin. The user-visible result of a refusal is chosen once, by origin, inside
  admission: a `Recovered` refusal records the failed message and restores the draft, as
  recovery does today.
- **A new `sinkId` is a new send.** A resume fallback or retry that changes the `sinkId`
  closes the current handle (writing nothing to history) and is admitted again as a new
  send with a new handle. The ordinary path already works this way.

S1 to S5 stand.

## Tests

Through the provider instance's interface:

- a recovered Claude send that falls back to a fresh native session is delivered once and
  gets exactly one terminal;
- a recovered send refused at the admission timeout closes its handle, releases its sink,
  account demand and pending entry once, and shows the refusal once;
- an undelivered send cancelled during adoption is cancelled through its handle;
- an adopted send closes on its runner's `release-sink`.

## Prior art

t3code has one admission path. Work that needs redelivering is offered back into the same
request queue as new work (`apps/server/src/orchestration-v2/Orchestrator.ts`, the
`continuationRequests.offer` call near line 1220), and runs cut off by a restart are
settled as interrupted (`settleInterruptedRun`, near line 9196), not replayed below the
orchestrator. Conduit replays pending sends at the runner level, which t3code does not;
it keeps that replay but sends it through the same admission. Evidence: t3code
main@2026-10-24, 24c80f34a1.
