# OpenCode directory spike, 82tn.1

## Question

Can one OpenCode server and adapter per configured instance support sessions in
many independent directories? What directory, event routing, isolation and
permission policy should beads 82tn.7 and 82tn.11 follow?

This spike captures observations under [ADR-0002](../adr/0002-provider-contracts-are-pinned-by-captured-wire-traffic.md).
It informs [retiring per-project relays](2026-09-17-retire-per-project-relay-design.md)
without changing production behavior.

## Capture method

The test uses `spawnOpenCode`, `RecordingProxy` and the classic API that conduit
uses. A test-local spawn override supplies cwd because the shared helper has no
cwd option. The primary server boots in A. A and B are separate git repositories
with distinct initial commits. C is a plain directory, N is created after boot,
and E contains an unpredictable token that is never supplied in the prompt.

Directory targeting follows `src/lib/instance/sdk-factory.ts` and the installed
SDK's `v2/client.js`: GET uses `?directory=...`; POST uses the URI-encoded
`x-opencode-directory` default header. The proxy recording format does not retain
request headers or global SSE envelopes. The measurements retain request scopes
and per-session stream coverage, including global envelope directories.

Prompts use `POST /session/:id/prompt_async`. Fork and abort use the classic
session endpoints. Permission responses use conduit's
`POST /session/:id/permissions/:permissionId` with `{ "response": "once" }`.
No permission overrides are installed. Every model wait allows three minutes.
The default model is the credential-free OpenCode Zen `mimo-v2.6-flash-free`;
`E2E_MODEL` selects another OpenCode Zen model if that free model is retired.

## Scenarios

| Scenario | Evidence |
| --- | --- |
| S1, many directories | Create sessions in A, B and C on one server. Capture session metadata and project fields, bash `pwd`, first assistant text and idle latency, and delivery through `/global/event` and all subscribed directory streams. |
| S2, new directory | Create N after boot, immediately create a session without registration, and repeat the directory and stream probes. |
| S3, cross-directory resume | Prompt B while targeting C and C while targeting A. Capture admission, tool cwd, and session lookups at both the requested and original directory. |
| S4, cross-directory fork | Fork B while targeting C, inspect returned and fetched metadata, and prompt the fork once for `pwd`. The classic fork API has no destination-directory body field; request scope is the tested mechanism. |
| S5, hung-session isolation | Start `sleep 60 && echo hung-done` in A. Prompt B and C concurrently after the bash running event. Measure first assistant text and idle, abort A once peers finish or after 40 seconds, and capture A idle plus B/C follow-up turns and statuses. |
| S6, external access | Ask B to read E's token file by absolute path. Capture permission types, allow-once replies through conduit's endpoint, read output, and whether the assistant returns the token. |
| S7, cost | Capture CLI version, platform, boot RSS and RSS after first contact with 1, 5 and 10 additional directories. Measure cold and warm `/project/current` round trips without a model, then sum RSS of three simultaneously running servers after one directory contact each. |

S7 executes first to keep boot and first-contact measurements free of model
traffic and directory-stream initialization. Counts refer to additional cost
directories, excluding the server's cwd A. RSS comes from `ps -o rss=` in KiB
and measures the server PID, not its descendant processes. The one-server and
three-server samples share the same machine and run but are single observations,
not a controlled benchmark. Model first-reply timings are labelled
`model-dominated` and must not be treated as directory-routing overhead.

Only successful session creation and bash output containing the created
directory are asserted in S1/S2. Cross-directory admission, fork behavior,
permissions, stream coverage, latency and isolation outcomes are observations.
HTTP error bodies, model errors and model timeouts remain in the measurements.
Transport failures and failed deterministic assertions prevent fixture writes.

## Rerun

Requires `opencode` on PATH and network access to the free model. No credentials
or running conduit daemon are needed.

```sh
RUN_EXPENSIVE_E2E=1 npx --no-install vitest run --config vitest.e2e.config.ts \
  test/e2e/provider/opencode-directory-spike-capture.test.ts
```

Without `RUN_EXPENSIVE_E2E=1` the test skips without starting OpenCode. All servers
and temporary directories are cleaned up in `finally`, including failed runs.

After every scenario and assertion passes, the test writes seven
`test/fixtures/opencode-wire-traces/directory-s*.json` recordings and
`directory-spike-measurements.json`. Review them before committing. Recordings
keep the existing `OpenCodeRecording` shape. Temporary paths become `<A>`, `<B>`,
`<C>`, `<N>`, `<E>` and `<ROOT>`; server data paths and URLs get numbered labels.
The random token, IDs, project hashes, wall-clock timestamps and replay delays
are normalized. Measured durations and RSS remain numeric. Model wording and
event interleaving can still vary between captures.

## Results

Captured 2026-10-19 with OpenCode 1.18.34 on darwin arm64 (25.6.0), model
`opencode/mimo-v2.6-flash-free`, primary server cwd A. Every request below
returned 2xx. Each figure is a single observation.

| Item | Observed result |
| --- | --- |
| S1, session directory/project and tool cwd | A and B (git) get separate project ids, `path: ""`. C (plain) gets project `global`; its `path` is C relative to worktree `/`. `pwd` printed each session's own directory. |
| S1, global versus directory stream routing | `/global/event` carried every session, each envelope tagged with that session's directory. `/event?directory=X` carried only X's sessions, with zero cross-talk. Its envelopes have no directory. |
| S2, setup required for a new directory | None. `mkdir` then `POST /session` worked (project `global`, `pwd` = N), with events on the global stream tagged N. |
| S3, admission, actual cwd and cross-directory lookup | Prompting B scoped to C was accepted (204), but the tool ran in B and events went only to B's stream. Same for C scoped to A. **The request scope is silently ignored, with no error.** Lookups from either scope return the original directory. |
| S4, fork directory/project and actual cwd | Forking B scoped to C returned a fork in B (B's project). Its `pwd` was B and its events went to B's stream. **Forks inherit the parent's directory.** |
| S5, overlap, peer latency, abort and post-abort behavior | While A ran `sleep 60`, B went idle in 3.6 s and C in 4.8 s, both before A was aborted. Abort at 4.8 s after tool start returned 200 in 191 ms. A ended with `MessageAbortedError`, its tool output read "User aborted the command", and A went idle. Follow-ups on B and C succeeded, and every status read idle. |
| S6, permission type, allow-once outcome and token return | With default config, reading E by absolute path raised one `external_directory` ask, pattern `<E>/*`. Allowing it once (scope B) returned 200. The read succeeded and the assistant returned the token. |
| S7, boot and 1/5/10-directory RSS, cold/warm latency | Boot 456,256 KiB. After 1/5/10 extra plain directories: 467,056 / 474,432 / 476,960 KiB (+20.7 MiB total, about 1 MiB per directory after the first). First-ever contact 120 ms, later cold contacts 6–27 ms, warm 1–11 ms. |
| S7, three-server summed RSS and comparison limits | Separate servers in A, B and C, each contacted once: 688,944 + 693,376 + 414,112 = 1,796,432 KiB (1.71 GiB). One server holding 11 directories used 476,960 KiB. The cost directories were plain, and git-repo servers ran about 270 MiB heavier, so **per-repo cost on a shared server is unmeasured**. It is bounded above by a separate server's. RSS excludes child processes. |
| Model-dominated first-reply latency | First text 1.9–6.2 s; idle 3.6–12.6 s. S6 took 47.3 s to first text and 59.1 s to idle, including the permission round trip. |
| Surprises or disagreement with code assumptions | (1) A session's directory is fixed at creation; prompt and fork accept any scope without error. (2) Non-git directories share project `global`, with a root-relative `path`. (3) Session lookup works from any directory scope. (4) Streamed text deltas can split a path, so a few temp-path fragments survive normalization in the recordings. |

## Policy for 82tn.7 and 82tn.11

Decision: **one OpenCode server and adapter per configured instance serves every
directory.** No per-project or per-directory servers.

1. **Create** scopes `POST /session` to the session's Effective Working
   Directory. This is the only point where OpenCode sets the directory, and it
   never changes afterwards. No registration step is needed for new directories.
2. **Every later request** (prompt, abort, permission and question replies,
   revert) uses the session's stored directory. A wrong scope would not move the
   cwd, but OpenCode loads config, project and permission rules per directory, and
   it never rejects a mismatch. So conduit must keep its stored directory equal to
   OpenCode's `session.directory` and treat any disagreement as a bug.
3. **Resume and fork never change directory.** Forks inherit the parent's
   workspace, which matches `session-workspace.ts`. Moving a conversation to
   another workspace needs a new session.
4. **Events** come from one `/global/event` subscription per server, routed by
   `sessionID`, with the envelope directory as a cross-check. Per-directory
   streams scale linearly and miss directories created later.
5. **Approvals (82tn.11)** are answerable from any view. A reply needs only the
   instance, the provider session and the provider permission id, mapped from
   conduit's own approval id (82tn.26) and sent in the session's directory scope.
   `external_directory` asks are real gates on paths outside the session's
   directory.
6. **Isolation**: a hung tool or an abort in one session left its peers on the
   same server unaffected. Untested: server crash and CPU or memory exhaustion. A
   crash affects every directory on that instance, so recovery must re-attach all
   of the instance's sessions. Separate servers are not required. The configured
   instance stays the unit of hard isolation.
