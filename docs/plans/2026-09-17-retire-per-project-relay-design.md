# Retiring the per-project relay: harness-scoped runtimes

**Status: PARKED. NOT DECIDED. NOT READY TO IMPLEMENT.**

> ⚠️ **This whole document is a design TODO.** It records a direction, the evidence
> gathered for it, and the questions that are still open. It is *not* an approved plan.
> Every section below carries at least one unresolved decision, and several of them are
> load-bearing enough that answering them differently changes the shape of everything
> downstream.
>
> **Nothing here may be decomposed into tickets until a design round has closed the
> open questions in §6.** When that round closes, this document must be split into
> tickets: it is far too large for one, and §7 sketches the seams where it should be cut.
>
> Written 2026-09-17 during the `conduit-test-ni8` grill, when the typed-streaming epic
> kept colliding with the per-project relay boundary. Parked deliberately so the ni8 epic
> could proceed without waiting on it.

---

## 1. Why this exists

Conduit runs one daemon that builds a **separate relay stack per project**: its own Effect
`ManagedRuntime`, its own WebSocket transport, its own `PtyManager`, its own SQLite handle.
They share only the HTTP port.

**This was never a decision.** A history dig across `docs/adr/`, `docs/plans/`, and the git
log found no ADR, no design doc arguing for it, and no commit message justifying it. The
shape arrives fully formed in the squash commit `3f062f12` ("Progress from private repo"),
inherited from the predecessor tool `claude-relay` (referenced at
`docs/old-plans-docs/tickets/3.1-daemon-process.md`). It then survived two large rewrites
by being explicitly scoped *out* of them, not by winning an argument:

- `docs/plans/2026-04-05-orchestrator-architecture-design.md:46` (under "What Doesn't
  Change"): *"The daemon, multi-project model, auth, and CLI stay the same"*
- `docs/plans/2026-05-11-effect-ts-mainline-completion-plan.md:77-78` (under Non-Goals):
  *"Keep each per-project relay as the deployment, scope, routing, and lifecycle unit"*,
  governed by `:52` *"Do not rewrite business behavior while migrating."*

The same plan names its own exit condition, at `:39`:

> *"Do not collapse into a global orchestration engine unless a product requirement appears
> that the per-project model cannot serve, such as daemon-wide search, a single canonical
> activity feed, or cross-project orchestration."*

**Three such requirements have now appeared.** They are the reason this document exists.

---

## 2. The requirements driving the change

**R1 — Credential and settings profiles.** One Claude + OpenCode runtime for work projects
and one for personal, with different OAuth accounts and different Claude settings. Several
projects map to one profile.

**R2 — Tab independence (hard constraint, non-negotiable).** Two browser tabs must be able
to view two different sessions without syncing. This is currently true only as an accident
of the firehose design and must survive explicitly.

**R3 — Projects spanning multiple code directories.** Stated as a firm future need. A
project becomes a *set* of directories, and directories may belong to more than one project.

---

## 3. What is already built (verified, and it is more than expected)

**R1's hard half is done.** Claude multi-account already works and is unit-tested.

- `query()` from `@anthropic-ai/claude-agent-sdk` (pinned 0.3.258) **spawns a subprocess**;
  it is not an in-process agent loop. Verified in the vendored `sdk.mjs`
  (`spawnLocalProcess`) and documented at `sdk.d.ts:1509-1515`: *"When set, this value
  REPLACES the subprocess environment entirely."*
- Conduit passes a **per-turn** `env` carrying that turn's `CLAUDE_CONFIG_DIR`
  (`src/lib/provider/claude/claude-provider-runtime.ts:933-978`, built by
  `claude-sdk-env.ts`, which also strips every `ANTHROPIC_*` key so auth can only come from
  the config dir).
- Distinct config dirs mean distinct accounts: credentials load from
  `<configDir>/.credentials.json`, and the macOS keychain service name is salted with a
  SHA-256 of the config dir.
- Proven by `test/unit/provider/claude/claude-provider-instance-send-turn.test.ts:272-296`,
  *"uses the turn's Claude config dir when creating the SDK query"*. The fixture is
  literally named `work-claude`.

**Consequence, and it removes the biggest risk in this design: harnesses do NOT need to be
separate daemon processes.** Credential separation is already achieved by separate *child*
processes, one per turn.

**The noun already exists too, under a different name: the provider instance.**
`{ id, name, driver: "claude" | "opencode", configDir, port, ... }`, persisted in
`daemon.json` (`src/lib/daemon/config-persistence.ts:57-66`), wired through IPC
(`contracts/ipc-requests.ts:246,289`), RPC (`server/ws-rpc.ts:459-477`), and the settings
UI (`SettingsPanel.svelte`, Instances tab). Designed in
`docs/plans/2026-07-27-provider-instance-model-design.md`; its Phase 4 appears complete.

**Session-level instance binding partly exists.**
`src/lib/domain/relay/Services/opencode-instance-clients.ts:1-10`: *"A session bound to a
named OpenCode instance runs on that instance's real server."*

> **TODO 3a.** Do not invent a "harness" type. Confirm that `ProviderInstance` is the right
> home for the profile concept and extend it, or state explicitly why it is not.

---

## 4. Proposed shape (PROPOSAL, NOT DECIDED)

Four scopes, each with exactly one owner.

| scope | owns | lifecycle | exists today? |
|---|---|---|---|
| **instance** | credentials, provider settings | daemon-level, long-lived | yes, `ProviderInstance` |
| **project** | event store, directory set, command gate | data + a queue, **no runtime** | partly; drags a runtime |
| **session** | provider session id, PTY, cwd | per session | yes |
| **connection** | subscriptions | one browser tab | no, implicit today |

**What gets deleted:** the per-project `ManagedRuntime` (`relay-stack.ts:860`), the
per-project WS transport (`relay-stack.ts:831`), the relay cache, the relay-factory
callback bundle (`relay-factory-layer.ts:183-265`), and the `createRelayStack`-vs-daemon
duplication.

**What survives, relocated:** the per-project command gate becomes a map inside one runtime
rather than a runtime each. Its requirement is unchanged
(`2026-05-11-effect-ts-mainline-completion-plan.md:86`: *"No command should race a
half-started relay"*).

**Runtime count: from N-projects to roughly one, plus the OpenCode server processes that
`InstanceManager` already owns at daemon level.**

> **TODO 4a.** The command gate is per-event-store, and the event store is per-project. If
> §5 moves the event store, re-derive what the gate is keyed by.
>
> **TODO 4b.** `PtyManager` is per-relay today (`pty-manager-layer.ts:25`). Proposal: a PTY
> belongs to a **session** and inherits that session's cwd. Unverified against the PTY
> lifecycle code.
>
> **TODO 4c.** "Connection" does not exist as a modelled scope today. Decide whether it is a
> real service or just the RPC socket's scope.

---

## 5. The event store problem (the hardest open question)

`<project>/.conduit/events.db` was introduced inline in a bug-fix commit (`ef03174d`) with
no recorded discussion of the location choice.

**R3 breaks it.** If a project spans directories, and directories can belong to more than
one project, per-directory storage is ambiguous: two projects sharing directory A both want
the same file.

**The cost of moving it is real and should not be waved away.** Today the history lives in
the repo, travels with the checkout, is git-ignorable, and deletes with the directory.
Moving to daemon config space (`~/.config/conduit/projects/<id>/events.db`) loses all four.

> **TODO 5a. UNRESOLVED, BLOCKS EVERYTHING ELSE.** Pick one: (a) daemon-space DB keyed by
> project id; (b) designate a primary directory per project and keep the DB there;
> (c) per-directory DBs with the project as a query-time union. (c) looks expensive; (a) and
> (b) both need a migration path costed.
>
> **TODO 5b.** Whichever wins, write the migration for existing `<project>/.conduit/events.db`
> files, including the case where a user has projects conduit has never opened.
>
> **TODO 5c.** Decide whether a session picks its cwd from the project's directory set at
> creation and keeps it, or whether the project designates a primary. Recommended: pick at
> creation, it is more honest and costs nothing now. Not decided.

---

## 6. Open questions that must close before any ticket is cut

> **TODO 6a.** §5's storage question. Blocks everything.
>
> **TODO 6b.** Does an instance bind to a **project** (today's `setProjectInstance`), to a
> **session**, or both with session overriding project? R1 is satisfiable at project level;
> the OpenCode code already does it at session level. Two mechanisms currently coexist.
>
> **TODO 6c.** `setProjectInstance` currently rebuilds the relay
> (`daemon-layers.ts:491-498`, `updateEffectProject` then `replaceEffectRelay`). Under typed
> streaming subscriptions, a relay swap mid-subscription is a **new failure mode**: today
> the client papers over it with the `onConnect` refetch of seven RPCs
> (`ChatLayout.svelte:340-395`), which ni8.16 deletes. Decide how subscriptions survive an
> instance rebind.
>
> **TODO 6d.** Claude **settings** are not per-instance, only auth is.
> `src/lib/provider/orchestration-wiring.ts:115-118` registers one `ClaudeProviderInstance`
> per relay with `claudeSettingsOverrides: () => loadRelaySettings(options.configDir)
> .claudeSettings`, where `options.configDir` is conduit's own config dir, not the
> instance's. **R1's settings half is therefore NOT met.** Fix is to key the overrides by
> instance id at the query edge, but that interacts with open bead `conduit-test-d7o6`
> (replacement semantics lose concurrent edits).
>
> **TODO 6e.** OpenCode named instances carry a long accepted-degradation list
> (`opencode-instance-clients.ts:1-10`): *"status/message pollers, pending
> permission/question recovery lists, file ops, model discovery, PTY, REST history stay on
> the project-default instance."* Under R1 these all run under the wrong account. Decide
> whether making named OpenCode instances first-class is in scope or a follow-on.
>
> **TODO 6f.** `evictOldestSessions` is a permanent stub
> (`project-registry-service.ts:585-593`, *"Stub implementation until relay access is
> available"*). It is the canonical daemon-wide operation. Confirm this design unblocks it.
>
> **TODO 6g.** Two multi-project entry points still coexist and the question of which is
> canonical is recorded as open (`2026-05-16-effect-ts-remaining-ownership-breakdown.md:675`).
> This design should close it or explicitly defer it.
>
> **TODO 6h.** Retire or rename "project". It currently means three things: a directory, a
> view, and a storage home. Every doc and ADR using the word needs disambiguating.

---

## 7. Suggested ticket seams (for when this unparks)

Do **not** cut these yet. Recorded so the split is not re-derived from scratch.

1. **Storage relocation + migration** (TODO 5a, 5b). Must land first; everything else
   assumes its answer.
2. **Project as a directory set** (R3, TODO 5c). Schema plus the session-cwd rule.
3. **Instance binding unification** (TODO 6b). One mechanism, project-default with optional
   session override.
4. **Per-instance Claude settings** (TODO 6d, R1's remaining half). Independently
   shippable and independently valuable; see §8.
5. **Collapse the relay runtime** (§4). The large one. Depends on 1 and 3.
6. **Connection scope + subscription re-establishment across rebind** (TODO 4c, 6c).
   Couples to the ni8 epic; must not land before ni8.16.
7. **Named OpenCode instances first-class** (TODO 6e). Probably its own epic.

---

## 8. Bugs found while writing this (independently fixable, not blocked on the design)

- **Session title generation is billed to the daemon account.**
  `src/lib/domain/relay/Services/session-title-service.ts:251` calls `makeClaudeSdkEnv()`
  with no `configDir`. A real billed Haiku call for a personal project runs under the work
  account, or vice versa. Directly violates R1.
- **The Claude capabilities probe cache is unsound across accounts.**
  `claude-capabilities-probe.ts:229` also omits `configDir`. Worse, its module-level cache
  was justified in `docs/plans/2026-05-11-claude-capabilities-probe.md:575` on the grounds
  that *"the probe queries the local `claude` binary which is shared across all projects"* —
  which stops being true once config dirs differ, since capabilities and available models
  are account-dependent.
- **Named OpenCode instances likely 401.** `instance.env["OPENCODE_SERVER_PASSWORD"]` is
  honoured by `instance-health-service.ts:32-33` and `session-prefetch-layer.ts:82`, but
  neither `createSdkClient` call site passes `auth`
  (`relay-core-layers.ts:32-38`, `opencode-instance-clients.ts:113-118`), so
  `sdk-factory.ts:52` falls back to the global password. Inferred from reading, not run.

---

## 9. Relationship to the `conduit-test-ni8` epic

ni8 (typed streaming subscriptions) **proceeds now and is not blocked by this document.**
One constraint adopted in ni8's Round 2 exists specifically to keep it cheap:

> A subscription takes its scope as an **explicit argument**, never inherited ambiently from
> the relay, runtime, or connection it runs inside.

With that in place, retiring the per-project relay changes an argument rather than an
architecture. Fork 2.5 was settled as **C (fan out across subscribers, inlined loop, no
named abstraction)** for the same reason: C is the shape that shrinks to a deletion when
this design lands, whereas the rejected option A invests in the boundary being removed.
