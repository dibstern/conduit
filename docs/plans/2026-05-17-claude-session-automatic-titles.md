# Claude Session Automatic Titles Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Automatically replace default Claude sidebar titles after the first accepted Claude user message with a six-word Haiku-generated title.

**Architecture:** Conduit owns session titles in its SQLite event store. After the first Claude user message is persisted, the prompt handler starts a non-blocking `SessionTitleService` job that runs a separate short-lived Claude SDK query using Haiku, sanitizes the result, and persists a `session.renamed` event if the title is still default. The real Claude turn dispatch is never delayed by title generation.

**Tech Stack:** TypeScript, Effect, Claude Agent SDK, SQLite event store/projectors, Svelte WebSocket debug panel, Vitest

---

## Settled Decisions

- Generate titles only for sessions whose first accepted user message is sent while bound to Claude.
- Use only the first message text. Do not scan repo files, `CONTEXT.md`, or project docs.
- Use a separate short-lived Claude SDK query, not the live Claude session query.
- Use the Claude SDK `haiku` model alias by default.
- Run the title job in a background Effect fiber. Do not delay the assistant response.
- Cap titles at six words by truncating after word six.
- Preserve model casing and punctuation where safe. Do not force title-case.
- Treat empty/default-looking generated titles as generation failures.
- On failure, fall back to `Claude Session YYYY-MM-DD HH:mm` in the relay local timezone.
- Log title generation failures in the relay logs and send a debug-only `system_error` payload for the UI debug panel.
- Manual user renames always win.
- Persist only the new session name via `session.renamed`; do not add title provenance fields.
- Do not backfill existing sessions stuck as `Claude Session`.

## Current Bug

`src/lib/handlers/prompt.ts` already has an auto-rename path, but it runs after turn completion and calls `sessionManagerService.renameSession()`.

That rename currently delegates to `api.session.update(...)` in `src/lib/domain/relay/Services/session-manager-service.ts`, which is the OpenCode session API. Relay-owned Claude sessions live in Conduit's SQLite/event-store path, so the rename goes to the wrong owner.

There is a second bug: `persistUserMessage()` appends a `session.created` event titled `Claude Session` for Claude messages, and both session projectors currently update `title = excluded.title` on `session.created` conflict. That can overwrite a later rename back to `Claude Session`.

## Task 1: Fix Relay-Owned Claude Rename Semantics

**Files:**

- Modify: `src/lib/persistence/effect/read-query-effect.ts`
- Modify: `src/lib/domain/relay/Services/session-manager-service.ts`
- Modify: `src/lib/persistence/effect/projectors-effect.ts`
- Modify: `src/lib/persistence/projectors/session-projector.ts`
- Test: `test/unit/session/session-manager-effect.test.ts`
- Test: `test/unit/pipeline/projector-resilience.test.ts` or a new focused projector test if the existing file is too broad

**Step 1: Write failing tests**

Add focused tests proving:

1. `SessionManagerService.renameSession()` renames a SQLite-backed Claude session without calling `api.session.update`.
2. The rename persists through `session.renamed` projection.
3. A later duplicate `session.created` event does not overwrite an existing title.

Representative test shape:

```typescript
it.effect("renames relay-owned Claude sessions through the event store", () =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const api = yield* OpenCodeAPITag;
		const sessionManager = yield* SessionManagerServiceTag;

		yield* sql`
			INSERT INTO sessions (id, provider, title, status, created_at, updated_at)
			VALUES ('ses_claude', 'claude', 'Claude Session', 'idle', 1, 1)`;

		yield* sessionManager.renameSession("ses_claude", "Auth Token Refresh");

		const rows = yield* sql<{ title: string }>`
			SELECT title FROM sessions WHERE id = 'ses_claude'`;
		expect(rows[0]?.title).toBe("Auth Token Refresh");
		expect(api.session.update).not.toHaveBeenCalled();
	}),
);
```

**Step 2: Add `ReadQueryEffect.getSession()`**

Extend `ReadQueryEffect` with:

```typescript
readonly getSession: (
	sessionId: string,
) => Effect.Effect<SessionRow | undefined, ReadQueryEffectError | SqlError>;
```

Implement it with:

```typescript
const rows = yield* sql<SessionRow>`
	SELECT * FROM sessions WHERE id = ${sessionId}`;
return rows[0];
```

**Step 3: Route Claude renames through Conduit's event store**

In `session-manager-service.ts`, add a private helper that appends and projects `session.renamed`:

```typescript
const renameRelayOwnedSession = (sessionId: string, title: string) =>
	Effect.gen(function* () {
		const eventStore = yield* EventStoreEffectTag;
		const projectionRunner = yield* ProjectionRunnerEffectTag;
		const sql = yield* SqlClient.SqlClient;
		const now = Date.now();

		const recovered = yield* projectionRunner.isRecovered();
		if (!recovered) {
			yield* projectionRunner.recover().pipe(Effect.provideService(SqlClient.SqlClient, sql));
		}

		const stored = yield* eventStore.append(
			canonicalEvent(
				"session.renamed",
				sessionId,
				{ sessionId, title },
				{ provider: "claude", createdAt: now },
			),
		);

		yield* projectionRunner
			.projectEvent(stored)
			.pipe(Effect.provideService(SqlClient.SqlClient, sql));
	});
```

Then update `renameSession(sessionId, title)`:

- If `ReadQueryEffectTag` is available and `getSession(sessionId)` returns provider `claude`, run `renameRelayOwnedSession`.
- Otherwise call `api.session.update(sessionId, { title })`.
- If SQLite services are missing or the session is unknown, keep the existing OpenCode path.

**Step 4: Stop `session.created` from overwriting existing titles**

Change both session projectors so `session.created` owns initial insert only and `session.renamed` owns title changes.

In `src/lib/persistence/effect/projectors-effect.ts` and `src/lib/persistence/projectors/session-projector.ts`, change the conflict update from:

```sql
title = excluded.title
```

to preserving the current title:

```sql
title = sessions.title
```

Keep provider and `updated_at` behavior unchanged unless a failing test shows otherwise.

**Step 5: Run focused tests**

```bash
pnpm exec vitest run test/unit/session/session-manager-effect.test.ts test/unit/pipeline/projector-resilience.test.ts
```

Expected: new tests fail before implementation, pass after implementation.

**Step 6: Commit**

```bash
git add src/lib/persistence/effect/read-query-effect.ts src/lib/domain/relay/Services/session-manager-service.ts src/lib/persistence/effect/projectors-effect.ts src/lib/persistence/projectors/session-projector.ts test/unit/session/session-manager-effect.test.ts test/unit/pipeline/projector-resilience.test.ts
git commit -m "fix: persist Claude session renames in event store"
```

## Task 2: Add Session Title Service

**Files:**

- Create: `src/lib/domain/relay/Services/session-title-service.ts`
- Modify: `src/lib/domain/relay/Layers/relay-layer.ts` if the service belongs in relay state
- Modify: `src/lib/relay/relay-stack.ts` if persistence-conditioned layer wiring is clearer there
- Test: `test/unit/session/session-title-service.test.ts`

**Step 1: Write failing service tests**

Add tests for:

- Six-word truncation: `Fix OAuth Callback Loop In`.
- Newlines/control chars collapse to spaces.
- Surrounding quotes/backticks are trimmed.
- Trailing periods are stripped.
- `Claude Session`, `Untitled`, and `New session` are rejected as default-equivalent.
- Overlong Haiku output is truncated, not treated as failure.
- Failed Haiku query falls back to `Claude Session YYYY-MM-DD HH:mm`.
- In-flight duplicate calls for the same session launch one job.
- Manual title wins: if the current title is no longer default before apply, no rename happens.

**Step 2: Implement helper functions first**

Implement small pure helpers in `session-title-service.ts` and export them for tests:

```typescript
export function sanitizeGeneratedTitle(raw: string): string | undefined {
	const cleaned = raw
		.replace(/[\u0000-\u001F\u007F]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^["'`]+|["'`]+$/g, "")
		.replace(/[.]+$/g, "")
		.trim();

	if (!cleaned) return undefined;

	const title = cleaned.split(/\s+/).slice(0, 6).join(" ");
	return isDefaultSessionTitle(title) ? undefined : title;
}
```

```typescript
export function isDefaultSessionTitle(title: string | undefined): boolean {
	const normalized = title?.trim().toLowerCase();
	return (
		!normalized ||
		normalized === "claude session" ||
		normalized === "untitled" ||
		normalized === "new session" ||
		normalized.startsWith("new session ")
	);
}
```

```typescript
export function formatClaudeTitleFallback(now = new Date()): string {
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	const hour = String(now.getHours()).padStart(2, "0");
	const minute = String(now.getMinutes()).padStart(2, "0");
	return `Claude Session ${year}-${month}-${day} ${hour}:${minute}`;
}
```

**Step 3: Add the service contract**

Use a normal Effect `Context.Tag` service:

```typescript
export interface SessionTitleService {
	readonly startForFirstClaudeMessage: (input: {
		readonly sessionId: string;
		readonly firstMessage: string;
	}) => Effect.Effect<void>;
}

export class SessionTitleServiceTag extends Context.Tag("SessionTitleService")<
	SessionTitleServiceTag,
	SessionTitleService
>() {}
```

The method should return quickly. It should start the title job in a background fiber and return `Effect.void`.

**Step 4: Implement Haiku title generation**

Use the Claude Agent SDK directly in this service:

```typescript
query({
	prompt: buildTitlePrompt(firstMessage),
	options: {
		cwd: config.projectDir ?? process.cwd(),
		env: makeClaudeSdkEnv(),
		model: "haiku",
		persistSession: false,
		maxTurns: 1,
		allowedTools: [],
		abortController,
		stderr: (data) => log.debug(`Claude title generation stderr: ${data}`),
	},
});
```

Prompt shape:

```text
Create a concise sidebar title for this coding-assistant session.

Rules:
- Summarize the domain and intent of the user's first message.
- Return only the title.
- Use at most six words.
- Do not include quotes.
- Do not use "Claude Session", "Untitled", or "New session".

First message:
<message>
...
</message>
```

Collect text from assistant messages and partial text deltas defensively. Prefer final assistant text if present.

**Step 5: Implement failure handling**

If the SDK call fails, times out, returns no text, or sanitizes to a default-equivalent title:

- compute `fallbackTitle = formatClaudeTitleFallback()`
- `log.warn("SESSION_TITLE_GENERATION_FAILED ...")`
- broadcast a debug payload:

```typescript
wsHandler.broadcast({
	type: "system_error",
	code: "SESSION_TITLE_GENERATION_FAILED",
	message: "Claude session title generation failed; using fallback title.",
	details: {
		sessionId,
		reason,
		fallbackTitle,
	},
});
```

The existing WS debug store records all WebSocket messages, so debug mode will show this in the UI debug panel.

**Step 6: Apply only if the title is still default**

Before applying either the Haiku title or fallback title:

- Re-read the current session with `ReadQueryEffect.getSession(sessionId)`.
- Confirm provider is still `claude`.
- Confirm `isDefaultSessionTitle(current.title)` is true.
- Call `sessionManagerService.renameSession(sessionId, title)`.
- Broadcast fresh dual session lists with `sessionManagerService.sendDualSessionLists(...)`.

If any check fails, return without logging a failure.

**Step 7: Guard duplicate jobs**

Inside the live layer, keep an Effect `Ref<HashSet.HashSet<string>>` or equivalent in-flight set.

Behavior:

- If `sessionId` is already in-flight, return.
- Add before starting the background fiber.
- Remove in `Effect.ensuring(...)`.

**Step 8: Run focused tests**

```bash
pnpm exec vitest run test/unit/session/session-title-service.test.ts
```

Expected: all helper and service behavior tests pass.

**Step 9: Commit**

```bash
git add src/lib/domain/relay/Services/session-title-service.ts src/lib/domain/relay/Layers/relay-layer.ts src/lib/relay/relay-stack.ts test/unit/session/session-title-service.test.ts
git commit -m "feat: add Claude session title service"
```

## Task 3: Wire Title Generation From Prompt Handling

**Files:**

- Modify: `src/lib/handlers/prompt.ts`
- Modify: `test/helpers/mock-factories.ts`
- Replace or rewrite: `test/unit/handlers/prompt-auto-rename.test.ts`

**Step 1: Replace the current low-signal helper test**

`test/unit/handlers/prompt-auto-rename.test.ts` currently duplicates the 60-character truncation helper outside production code. Replace it with behavior tests around `handleMessage()`:

- First Claude user message starts `SessionTitleService.startForFirstClaudeMessage(...)`.
- Non-first Claude message does not start title generation.
- OpenCode message does not start title generation.
- If Claude user-message persistence fails, title generation does not start.
- The real provider dispatch still happens when title generation starts.

**Step 2: Add test helper support**

Add `SessionTitleServiceTag` to the relevant mock layer factories in `test/helpers/mock-factories.ts`.

Default mock:

```typescript
const sessionTitleService = {
	startForFirstClaudeMessage: vi.fn(() => Effect.void),
};
```

**Step 3: Wire in `prompt.ts`**

In `sendMessageToSession`:

1. Load `SessionTitleServiceTag` as an optional service.
2. Compute first-message status before persisting the current user message:

```typescript
const isFirstClaudeMessage = providerId === "claude" && priorHistory.length === 0;
```

3. After `claudeEventPersistEffectOption.value.persistUserMessage(...)` succeeds, start the title job:

```typescript
if (
	isFirstClaudeMessage &&
	titleServiceOption._tag === "Some" &&
	persistResult._tag === "Right"
) {
	yield* titleServiceOption.value.startForFirstClaudeMessage({
		sessionId: activeId,
		firstMessage: text,
	});
}
```

4. Remove the old post-turn auto-rename block that slices `text` to 60 characters.

**Step 4: Run focused tests**

```bash
pnpm exec vitest run test/unit/handlers/prompt-auto-rename.test.ts
```

Expected: tests prove title generation starts after first persisted Claude user message and dispatch still happens.

**Step 5: Commit**

```bash
git add src/lib/handlers/prompt.ts test/helpers/mock-factories.ts test/unit/handlers/prompt-auto-rename.test.ts
git commit -m "feat: trigger Claude titles after first message"
```

## Task 4: Add Browser Console Logging For Debug System Errors

**Files:**

- Modify: `src/lib/frontend/stores/ws-dispatch.ts`
- Test: add or update the narrowest frontend store test under `test/unit/stores/` or `test/unit/frontend/`

**Step 1: Write failing test**

Add a test that dispatches:

```typescript
{
	type: "system_error",
	code: "SESSION_TITLE_GENERATION_FAILED",
	message: "Claude session title generation failed; using fallback title.",
	details: { sessionId: "ses_1", fallbackTitle: "Claude Session 2026-05-17 14:32" },
}
```

Assert `console.warn` is called.

**Step 2: Implement console logging**

In the existing `system_error` case, add:

```typescript
log.warn("System error:", msg.code, msg.message, msg.details ?? {});
```

Keep existing `INSTANCE_ERROR` scan cleanup behavior.

**Step 3: Run focused test**

```bash
pnpm exec vitest run test/unit/stores
```

If that is too broad, run the single new test file.

**Step 4: Commit**

```bash
git add src/lib/frontend/stores/ws-dispatch.ts test/unit/stores
git commit -m "chore: surface system errors in browser console"
```

## Task 5: Focused Integration Check

**Files:**

- Add or modify: `test/integration/flows/claude-session-title.integration.ts`

**Step 1: Write integration test**

Use a fake Claude title query factory that returns an assistant title like:

```text
OAuth Token Refresh Bug Investigation
```

Run through the real persistence layer and prompt handler enough to prove:

- a new Claude session starts as `Claude Session` or `Untitled`
- first message persistence starts title generation
- the title row eventually becomes `OAuth Token Refresh Bug Investigation`
- a second `session.created` event does not revert it

If wiring the full prompt handler is too heavy, test `SessionTitleService` with real `makePersistenceEffectLayer()` and a fake query factory.

**Step 2: Add manual rename race test**

Simulate:

1. title job starts
2. session title changes to `Manual Title`
3. title job completes

Expected final title: `Manual Title`.

**Step 3: Run integration test**

```bash
pnpm exec vitest run test/integration/flows/claude-session-title.integration.ts
```

Expected: integration proves DB projection, manual-title protection, and no title overwrite from `session.created`.

**Step 4: Commit**

```bash
git add test/integration/flows/claude-session-title.integration.ts
git commit -m "test: cover Claude automatic session titles"
```

## Task 6: Verification

**Files:**

- No new production files unless focused checks reveal issues.

**Step 1: Run static Effect guardrail**

Because this touches Effect services, provider SDK boundaries, and relay wiring:

```bash
pnpm exec vitest run test/unit/effect/runtime-boundary-grep.test.ts
```

Expected: no new app-internal runtime boundary violations.

**Step 2: Run focused unit and integration tests**

```bash
pnpm exec vitest run \
	test/unit/session/session-title-service.test.ts \
	test/unit/session/session-manager-effect.test.ts \
	test/unit/handlers/prompt-auto-rename.test.ts \
	test/integration/flows/claude-session-title.integration.ts
```

Expected: all pass.

**Step 3: Run typecheck and lint**

```bash
pnpm check
pnpm lint
```

Expected: both pass.

**Step 4: Decide whether broader tests are needed**

Do not run full E2E by default. Escalate only if the implementation changes WebSocket protocol shape beyond the debug-only `system_error`, or if relay startup wiring changes in a way focused tests do not cover.

**Step 5: Commit verification fixes if needed**

```bash
git add <focused files>
git commit -m "fix: stabilize Claude title verification"
```

## Implementation Notes

### Claude SDK Options

The installed Claude Agent SDK supports `query({ prompt, options })`, `model`, `maxTurns`, `persistSession`, `allowedTools`, `abortController`, and `stderr`.

Use:

```typescript
{
	model: "haiku",
	persistSession: false,
	maxTurns: 1,
	allowedTools: [],
	abortController,
	stderr,
}
```

Do not use the live `ClaudeProviderInstance` session context. The title query is Conduit-owned metadata work, not a provider turn.

### Timeout

Use a short timeout, for example 10 seconds. On timeout, abort the SDK query and apply the timestamp fallback.

### Default Title Detection

Default titles for this feature:

- empty string
- `Claude Session`
- `Untitled`
- `New session`
- strings beginning with `New session `

Do not treat arbitrary user titles as default.

### Debug Visibility

The `system_error` payload is for debug surfaces, not a normal chat message. The existing WS debug store records every WebSocket message; the new frontend console warning satisfies the browser console requirement.

### Existing Sessions

No backfill. The feature starts with new first Claude messages after this change ships.

