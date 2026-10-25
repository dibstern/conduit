# Amendment 2026-10-25: send scope owns its assignment (Q21 = A)

Approved 2026-10-25. This file wins over every other file in this folder, including
`AMENDMENT-2026-10-25-SEND-SCOPE.md` (SEND-SCOPE), which it tightens.

User-facing behaviour is unchanged.

## Why

After SEND-SCOPE, two review rounds in a row found six material bugs. None of them was the
old one (refused cleanup). All six sat on three edges of how the scope was wired in:

- **Mutable assignment.** `runnerId` and `dispatchedRunnerId` were fields on the scope
  that callers set and cleared. A path that forgot to set one leaked; evict and retry
  raced over them.
- **Identity by key.** Sends were found by `sinkId`, which is derived from the input id
  and attempt and can be reused. An abort or a close-wait that held only the key reached
  a replacement send.
- **Shared by lookup.** The provider instance and the process runner each called
  `open(sinkId)` and shared whatever was there, including a scope already closing.

## S5. The send handle

- **One handle per send, created once.** The provider instance opens the send's scope when
  it admits the send and passes the handle down to the runner. Nothing looks a send up by
  `sinkId` to obtain its scope. Every handle is new, so a reused `sinkId` always gets a
  fresh handle and a fresh scope.
- **Assignment is a typed state owned by the send module.**

  ```ts
  type Assignment =
    | { readonly _tag: "Queued" }
    | { readonly _tag: "Dispatched"; readonly runnerId: string }
    | { readonly _tag: "Closed" };
  dispatch(send, runnerId): void // Queued -> Dispatched, before the command frame is written
  requeue(send, runnerId): void  // Dispatched{runnerId} -> Queued, for an unaccepted retry
  ```

  Callers read it and never write it. Every path that writes a command frame for a send
  (ordinary dispatch, recovery replay, retry) calls `dispatch` first.
- **Everything that acts on a send holds its handle.** An abort, a close-wait, a
  `release-sink` check and `closeRunner` all go through the handle (or the module's list
  of open handles), never through the `sinkId` key alone. An abort for a closed handle
  does nothing.
- **Closing is one signal.** A handle exposes one "closed" signal that completes when its
  finalizers have run, whether the send's own close or the parent's close started them.
  Waiting on it never spins and never runs inside the scope's own finalizers.

S1 to S4 stand. S2's incarnation check reads the handle's `Dispatched.runnerId`.

## Tests

Through the provider instance's interface: a recovery replay's `release-sink` closes its
send; an abort queued for a closed send cannot cancel a replacement that reuses the
`sinkId`; a parent close while a resend waits does not spin and the resend is admitted
after the old send's finalizers finish; evict during retry closes nothing that was
requeued.

## Prior art

t3code keeps a generation per reused key so cleanup for an earlier holder is never lost
or applied to a later one (`apps/server/src/orchestration-v2/ProviderSessionManager.ts`,
the "reusing ids must not lose cleanup for earlier threads" comment near line 834, and the
generation checks near 1070-1186). A fresh handle per send gives the same guarantee
without a counter.
