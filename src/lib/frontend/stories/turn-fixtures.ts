// ─── Turn Fixtures ────────────────────────────────────────────────────────────
// A fake session for the Storybook stories: a tool-less turn, a long finished
// turn (narration, reads, edits, a failing then passing test run, a subagent),
// and a turn still in flight. Stamps are relative to load so live turns tick.

import type {
	AssistantMessage,
	ChatMessage,
	ResultMessage,
	ThinkingMessage,
	ToolMessage,
	UserMessage,
} from "../types.js";
import { mockToolSubagentCompleted } from "./mocks.js";

// Turns 0+1 take ~50s; starting here leaves the live turn ~12s old.
let clock = Date.now() - 62_000;
let seq = 0;

/** Returns the current fixture time, then advances it by `ms`. */
function stamp(ms: number): number {
	const t = clock;
	clock += ms;
	return t;
}

const uuid = () => `fixture-${++seq}`;

function user(text: string): UserMessage {
	return { type: "user", uuid: uuid(), text, createdAt: stamp(400) };
}

function thought(text: string, duration: number, done = true): ThinkingMessage {
	return {
		type: "thinking",
		uuid: uuid(),
		text,
		duration,
		done,
		createdAt: stamp(duration),
	};
}

function say(rawText: string, html: string, ms = 1500): AssistantMessage {
	return {
		type: "assistant",
		uuid: uuid(),
		rawText,
		html,
		finalized: true,
		createdAt: stamp(ms),
	};
}

function tool(
	name: string,
	input: Record<string, unknown>,
	result: string | undefined,
	opts: { ms?: number; error?: boolean; running?: boolean } = {},
): ToolMessage {
	const id = uuid();
	return {
		type: "tool",
		uuid: id,
		id,
		name,
		input,
		status: opts.running ? "running" : opts.error ? "error" : "completed",
		...(result !== undefined ? { result } : {}),
		isError: opts.error ?? false,
		createdAt: stamp(opts.ms ?? 900),
	};
}

function result(
	duration: number,
	cost: number,
	tokens: { in: number; out: number; cacheRead: number; cacheWrite: number },
): ResultMessage {
	return {
		type: "result",
		uuid: uuid(),
		duration,
		cost,
		inputTokens: tokens.in,
		outputTokens: tokens.out,
		cacheRead: tokens.cacheRead,
		cacheWrite: tokens.cacheWrite,
		context_window: 200_000,
		createdAt: stamp(200),
	};
}

const REPO = "/Users/dev/src/acme-api";

export const turnFixtureMessages: ChatMessage[] = [
	// ── Turn 0: quick answer, no tools ──────────────────────────────────────
	user("What's the refresh token TTL supposed to be?"),
	say(
		"One hour — `docs/auth.md` §3 says refresh tokens live for 60 minutes and access tokens for 15.",
		"<p>One hour — <code>docs/auth.md</code> §3 says refresh tokens live for 60 minutes and access tokens for 15.</p>",
		2200,
	),
	result(3_100, 0.0031, {
		in: 1_204,
		out: 88,
		cacheRead: 12_400,
		cacheWrite: 0,
	}),

	// ── Turn 1: long, finished ──────────────────────────────────────────────
	user(
		"Refresh tokens are expiring after 15 minutes in prod but the spec says an hour. Find out why, fix it, and add a regression test.",
	),
	thought(
		"The user says refresh tokens expire early. Most likely a hard-coded TTL somewhere in the auth module rather than a config problem. Find where refresh tokens are signed and check expiresIn before changing anything.",
		2_100,
	),
	say(
		"Let me look at how refresh tokens are issued before changing anything.",
		"<p>Let me look at how refresh tokens are issued before changing anything.</p>",
	),
	tool(
		"Read",
		{ filePath: `${REPO}/src/auth.ts` },
		"export function refreshToken(token: string) {\n  const payload = verify(token);\n  const ttl = 900; // 15 min\n  return jwt.sign(payload, SECRET, { expiresIn: ttl });\n}",
		{ ms: 1_100 },
	),
	tool(
		"Grep",
		{ pattern: "refreshToken|REFRESH_TTL", path: "src" },
		"src/auth.ts:12:export function refreshToken(token: string) {\nsrc/config.ts:31:  REFRESH_TTL_SECONDS: num(process.env.REFRESH_TTL_SECONDS, 3600),\nsrc/auth.test.ts:40:  it('refreshToken keeps the 15 minute ttl', () => {",
		{ ms: 700 },
	),
	tool(
		"Read",
		{ filePath: `${REPO}/src/config.ts` },
		"export const config = {\n  ACCESS_TTL_SECONDS: num(process.env.ACCESS_TTL_SECONDS, 900),\n  REFRESH_TTL_SECONDS: num(process.env.REFRESH_TTL_SECONDS, 3600),\n};",
		{ ms: 900 },
	),
	tool(
		"Glob",
		{ pattern: "src/**/*.test.ts" },
		"src/auth.test.ts\nsrc/config.test.ts\nsrc/middleware/auth.test.ts",
		{ ms: 400 },
	),
	tool(
		"Read",
		{ filePath: `${REPO}/src/auth.test.ts` },
		"it('refreshToken keeps the 15 minute ttl', () => {\n  const t = refreshToken(sign({ sub: 'u1' }));\n  expect(decode(t).exp - decode(t).iat).toBe(900);\n});",
		{ ms: 800 },
	),
	say(
		"Found it — `refreshToken()` hard-codes `ttl = 900`. `config.REFRESH_TTL_SECONDS` exists (default 3600) but is never read. I'll wire the config through and cover it with a test.",
		"<p>Found it — <code>refreshToken()</code> hard-codes <code>ttl = 900</code>. <code>config.REFRESH_TTL_SECONDS</code> exists (default 3600) but is never read. I'll wire the config through and cover it with a test.</p>",
	),
	tool(
		"Edit",
		{
			filePath: `${REPO}/src/auth.ts`,
			oldString: "  const ttl = 900; // 15 min",
			newString: "  const ttl = config.REFRESH_TTL_SECONDS;",
		},
		"--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -12,7 +12,7 @@\n export function refreshToken(token: string) {\n   const payload = verify(token);\n-  const ttl = 900; // 15 min\n+  const ttl = config.REFRESH_TTL_SECONDS;\n   return jwt.sign(payload, SECRET, { expiresIn: ttl });\n }",
		{ ms: 1_300 },
	),
	tool(
		"Edit",
		{
			filePath: `${REPO}/src/auth.ts`,
			oldString: "import { verify } from './jwt';",
			newString:
				"import { verify } from './jwt';\nimport { config } from './config';",
		},
		"--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1,3 +1,4 @@\n import { verify } from './jwt';\n+import { config } from './config';",
		{ ms: 600 },
	),
	tool(
		"Write",
		{
			filePath: `${REPO}/src/auth.refresh.test.ts`,
			content:
				"import { refreshToken } from './auth';\n\nit('honours REFRESH_TTL_SECONDS', () => {\n  process.env.REFRESH_TTL_SECONDS = '3600';\n  const t = refreshToken(sign({ sub: 'u1' }));\n  expect(decode(t).exp - decode(t).iat).toBe(3600);\n});\n",
		},
		"Wrote 8 lines to src/auth.refresh.test.ts",
		{ ms: 1_200 },
	),
	tool(
		"Bash",
		{ command: "pnpm vitest run src/auth", description: "Run auth tests" },
		" ✓ src/auth.refresh.test.ts (1)\n ✗ src/auth.test.ts (1)\n   × refreshToken keeps the 15 minute ttl\n     AssertionError: expected 3600 to be 900\n\n Test Files  1 failed | 1 passed (2)\n      Tests  1 failed | 1 passed (2)",
		{ ms: 6_200, error: true },
	),
	thought(
		"The existing test asserts the old 900-second value — it encodes the bug rather than the spec. Update the assertion, not the implementation.",
		1_400,
	),
	say(
		"The old test pinned the 15-minute value — it was asserting the bug. Updating it.",
		"<p>The old test pinned the 15-minute value — it was asserting the bug. Updating it.</p>",
	),
	tool(
		"Edit",
		{
			filePath: `${REPO}/src/auth.test.ts`,
			oldString:
				"it('refreshToken keeps the 15 minute ttl', () => {\n  const t = refreshToken(sign({ sub: 'u1' }));\n  expect(decode(t).exp - decode(t).iat).toBe(900);",
			newString:
				"it('refreshToken uses the configured ttl', () => {\n  const t = refreshToken(sign({ sub: 'u1' }));\n  expect(decode(t).exp - decode(t).iat).toBe(config.REFRESH_TTL_SECONDS);",
		},
		"--- a/src/auth.test.ts\n+++ b/src/auth.test.ts\n@@ -40,4 +40,4 @@\n-it('refreshToken keeps the 15 minute ttl', () => {\n+it('refreshToken uses the configured ttl', () => {\n   const t = refreshToken(sign({ sub: 'u1' }));\n-  expect(decode(t).exp - decode(t).iat).toBe(900);\n+  expect(decode(t).exp - decode(t).iat).toBe(config.REFRESH_TTL_SECONDS);",
		{ ms: 800 },
	),
	tool(
		"Bash",
		{ command: "pnpm vitest run src/auth", description: "Re-run auth tests" },
		" ✓ src/auth.refresh.test.ts (1)\n ✓ src/auth.test.ts (1)\n\n Test Files  2 passed (2)\n      Tests  2 passed (2)",
		{ ms: 5_100 },
	),
	{
		...mockToolSubagentCompleted,
		uuid: uuid(),
		id: `fixture-sub-${seq}`,
		createdAt: stamp(8_000),
	},
	say(
		"The refresh TTL was hard-coded to 900s in `refreshToken()`; the `REFRESH_TTL_SECONDS` config (default 3600) was never read.\n\n- `src/auth.ts`: read the TTL from config\n- `src/auth.refresh.test.ts`: new regression test\n- `src/auth.test.ts`: the old assertion pinned the bug, updated\n\nBoth test files pass. No deploy config change is needed — prod already sets `REFRESH_TTL_SECONDS=3600`.",
		"<p>The refresh TTL was hard-coded to 900s in <code>refreshToken()</code>; the <code>REFRESH_TTL_SECONDS</code> config (default 3600) was never read.</p><ul><li><code>src/auth.ts</code>: read the TTL from config</li><li><code>src/auth.refresh.test.ts</code>: new regression test</li><li><code>src/auth.test.ts</code>: the old assertion pinned the bug, updated</li></ul><p>Both test files pass. No deploy config change is needed — prod already sets <code>REFRESH_TTL_SECONDS=3600</code>.</p>",
		4_000,
	),
	result(42_300, 0.0412, {
		in: 2_311,
		out: 1_311,
		cacheRead: 41_900,
		cacheWrite: 3_100,
	}),

	// ── Turn 2: in flight ───────────────────────────────────────────────────
	user("Now do the same audit for access tokens."),
	thought(
		"Same shape of problem. Start where access tokens are minted and check whether ACCESS_TTL_SECONDS is actually read.",
		1_800,
	),
	say(
		"Same approach — starting with where access tokens are minted.",
		"<p>Same approach — starting with where access tokens are minted.</p>",
	),
	tool(
		"Read",
		{ filePath: `${REPO}/src/access-token.ts` },
		"export function issueAccessToken(sub: string) {\n  return jwt.sign({ sub }, SECRET, { expiresIn: 900 });\n}",
		{ ms: 1_000 },
	),
	tool(
		"Grep",
		{ pattern: "issueAccessToken|ACCESS_TTL", path: "src" },
		"src/access-token.ts:4:export function issueAccessToken(sub: string) {\nsrc/config.ts:30:  ACCESS_TTL_SECONDS: num(process.env.ACCESS_TTL_SECONDS, 900),\nsrc/middleware/auth.ts:18:    const token = issueAccessToken(user.id);",
		{ ms: 700 },
	),
	tool(
		"Read",
		{ filePath: `${REPO}/src/middleware/auth.ts` },
		"// middleware …",
		{ ms: 900 },
	),
	tool(
		"Edit",
		{
			filePath: `${REPO}/src/access-token.ts`,
			oldString: "{ expiresIn: 900 }",
			newString: "{ expiresIn: config.ACCESS_TTL_SECONDS }",
		},
		undefined,
		{ running: true },
	),
];
