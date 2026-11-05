import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { ProcessHarness } from "../../helpers/process-harness.js";

// ad4c: a provider switch hands the conversation to the next account. The
// audit (failure catalogue 1-11) lives in the lane's audit.md; each test below
// names the entries it proves. Every test leaves its JSON evidence under
// test-results/ad4c-<name>.json.
let harness: ProcessHarness | undefined;
let evidence: Record<string, unknown> = {};

afterEach(async ({ task }) => {
	const fixture = harness;
	harness = undefined;
	const recorded = evidence;
	evidence = {};
	try {
		await fixture?.dispose();
	} finally {
		const name = `ad4c-${String(recorded["name"] ?? "provider-switch")}.json`;
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			join("test-results", name),
			`${JSON.stringify(
				{
					bead: "conduit-test-ad4c",
					result: task.result?.state,
					failures: task.result?.errors?.map(({ message }) => message),
					...recorded,
				},
				null,
				2,
			)}\n`,
		);
		const scratch = process.env["AD4C_EVIDENCE_DIR"];
		if (scratch) copyFileSync(join("test-results", name), join(scratch, name));
	}
});

interface CursorCapture {
	kind?: string;
	data?: { prompt?: string | { text?: string } };
}

/** A daemon with one Claude and one Cursor account and a Claude session. */
const switchFixture = async (
	name: string,
	environment: Record<string, string> = {},
) => {
	evidence["name"] = name;
	// A cross-driver switch runs the target account's default model (entry 10).
	harness = ProcessHarness.create({
		runnerLifecycle: { idleTimeoutMs: null },
		// The stub reads rejected-resume-session-id beside its proof file.
		restartProof: true,
		relaySettings: {
			harnessDefaults: {
				cursor: {
					providerId: "cursor",
					modelId: "composer-2.5",
					contextWindow: "",
				},
				claude: {
					providerId: "claude",
					modelId: "sonnet",
					contextWindow: "200k",
				},
			},
		},
	});
	const fixture = harness;
	const cursorCapture = join(fixture.root, "cursor-capture.jsonl");
	const cursorAuth = join(fixture.root, "cursor-auth.json");
	writeFileSync(cursorAuth, JSON.stringify({ accounts: {} }));
	const start = () =>
		fixture.restart({
			startupTimeoutMs: 90_000,
			runnerStartupTimeoutMs: 90_000,
			serviceEnvironment: {
				CONDUIT_CURSOR_SDK_TRACE: resolve(
					"test/fixtures/cursor-sdk-traces/basic.jsonl",
				),
				CONDUIT_CURSOR_SDK_CAPTURE: cursorCapture,
				CONDUIT_TEST_CURSOR_AUTH_STATE: cursorAuth,
				...environment,
			},
		});
	await start();
	const claude = (
		await fixture.requestRpc({ _tag: "GetInstances" })
	).instances.find(({ driver }) => driver === "claude")?.id;
	if (!claude) throw new Error("Missing isolated Claude account");
	const cursor = (
		await fixture.requestRpc({
			_tag: "AddInstance",
			driver: "cursor",
			name: "Cursor A",
		})
	).addedInstanceId;
	if (!cursor) throw new Error("Missing Cursor account");
	writeFileSync(
		cursorAuth,
		JSON.stringify({
			accounts: {
				[cursor]: {
					status: { status: "logged-in" },
					credential: {
						apiKey: `[REDACTED:${cursor}]`,
						backendUrl: "https://api2.cursor.sh",
						createdAtMs: 0,
					},
				},
			},
		}),
	);
	const browser = await fixture.connect();
	const sessionId = await browser.createSession(`ad4c ${name}`, claude);
	const store = () =>
		new Database(fixture.daemonStorePath(), { readonly: true });
	return {
		fixture,
		browser,
		sessionId,
		claude,
		cursor,
		start,
		switchTo: (instanceId: string, from: string) =>
			fixture.requestRpc({
				_tag: "ContinueSession",
				sessionId,
				instanceId,
				expectedInstanceId: from,
			}),
		/** 82tn.52: what the next send will do, as the composer shows it. */
		plan: async () =>
			(
				await fixture.requestRpc({
					_tag: "GetResumePlan",
					sessionId,
				})
			).plan,
		cursorPrompts: () =>
			existsSync(cursorCapture)
				? readFileSync(cursorCapture, "utf8")
						.trim()
						.split("\n")
						.map((line) => JSON.parse(line) as CursorCapture)
						.filter(({ kind }) => kind === "send.options")
						.map(({ data }) =>
							typeof data?.prompt === "string"
								? data.prompt
								: (data?.prompt?.text ?? ""),
						)
				: [],
		claudeTurn: (ending: string) =>
			fixture
				.claudeOptions()
				.filter(({ prompt }) => prompt?.endsWith(ending))
				.at(-1),
		receipt: (instanceId: string) => {
			const db = store();
			try {
				const row = db
					.prepare<[string, string], { value: string }>(
						"SELECT value FROM provider_state WHERE session_id = ? AND key = ?",
					)
					.get(sessionId, `nativeThread:${instanceId}`);
				if (!row) throw new Error(`Missing receipt for ${instanceId}`);
				return JSON.parse(row.value) as {
					resumeSessionId: string;
					deliveredThrough: number;
				};
			} finally {
				db.close();
			}
		},
		handoffs: () => {
			const db = store();
			try {
				return db
					.prepare<[string], { sequence: number; data: string }>(
						"SELECT sequence, data FROM events WHERE session_id = ? AND type = 'session.handoff_delivered' ORDER BY sequence",
					)
					.all(sessionId)
					.map(
						({ sequence, data }): Record<string, unknown> => ({
							sequence,
							...(JSON.parse(data) as Record<string, unknown>),
						}),
					);
			} finally {
				db.close();
			}
		},
	};
};

it("round trips Claude, Cursor, Claude: Cursor gets a full handoff, Claude resumes and catches up", async () => {
	const s = await switchFixture("round-trip");
	await s.browser.send(s.sessionId, "ad4c-claude-one MARK-CLAUDE-1", 90_000);
	const firstReceipt = s.receipt(s.claude);
	// 82tn.52: the plan the composer shows before each send matches what the send then does.
	const plans = [await s.plan()];

	// Claude -> Cursor is a fresh full handoff.
	await s.switchTo(s.cursor, s.claude);
	plans.push(await s.plan());
	await s.browser.send(s.sessionId, "ad4c-cursor-two MARK-CURSOR-2", 90_000);
	plans.push(await s.plan());
	const cursorPrompt = s.cursorPrompts().at(-1) ?? "";
	evidence["cursorPrompts"] = s.cursorPrompts();
	expect(cursorPrompt).toContain("[Conduit context handoff]");
	expect(cursorPrompt).toContain("MARK-CLAUDE-1");
	expect(cursorPrompt.endsWith("ad4c-cursor-two MARK-CURSOR-2")).toBe(true);

	// Cursor -> Claude resumes the old native thread and catches up only what
	// came after its receipt.
	await s.switchTo(s.claude, s.cursor);
	plans.push(await s.plan());
	await s.browser.send(s.sessionId, "ad4c-claude-three", 90_000);
	plans.push(await s.plan());
	evidence["plans"] = plans;
	expect(plans).toEqual([
		"current",
		"handoff",
		"current",
		"catch_up",
		"current",
	]);
	const back = s.claudeTurn("ad4c-claude-three");
	evidence["claudeReturn"] = back;
	expect(back?.resumeId).toBe(firstReceipt.resumeSessionId);
	expect(back?.prompt).toContain("[Conduit context handoff]");
	expect(back?.prompt).toContain("MARK-CURSOR-2");
	expect(back?.prompt).not.toContain("MARK-CLAUDE-1");

	// Recorded: each handoff carries its strategy, range and input.
	const recorded = s.handoffs();
	evidence["handoffs"] = recorded;
	expect(recorded).toEqual([
		expect.objectContaining({
			instanceId: s.cursor,
			strategy: "fresh",
			afterSequence: 0,
		}),
		expect.objectContaining({
			instanceId: s.claude,
			strategy: "resume",
			afterSequence: firstReceipt.deliveredThrough,
		}),
	]);
	for (const handoff of recorded) {
		expect(handoff["inputId"]).toEqual(expect.any(String));
		expect(handoff["fallback"]).toBeUndefined();
		expect(handoff["throughSequence"]).toBeGreaterThan(
			Number(handoff["afterSequence"]),
		);
	}
});

it("starts Claude fresh with a full handoff when it rejects the resume (entry 3)", async () => {
	const s = await switchFixture("rejected-resume");
	await s.browser.send(s.sessionId, "ad4c-claude-one MARK-CLAUDE-1", 90_000);
	const firstReceipt = s.receipt(s.claude);
	await s.switchTo(s.cursor, s.claude);
	await s.browser.send(s.sessionId, "ad4c-cursor-two MARK-CURSOR-2", 90_000);
	writeFileSync(
		join(s.fixture.root, "rejected-resume-session-id"),
		firstReceipt.resumeSessionId,
	);
	await s.switchTo(s.claude, s.cursor);
	await s.browser.send(s.sessionId, "ad4c-claude-three", 90_000);
	const attempts = s.fixture
		.claudeOptions()
		.filter(({ prompt }) => prompt?.endsWith("ad4c-claude-three"));
	evidence["claudeAttempts"] = attempts;
	expect(attempts[0]?.resumeId).toBe(firstReceipt.resumeSessionId);
	const fresh = attempts.at(-1);
	expect(fresh?.resumeId ?? null).toBeNull();
	expect(fresh?.prompt).toContain("MARK-CLAUDE-1");
	expect(fresh?.prompt).toContain("MARK-CURSOR-2");
	const recorded = s.handoffs();
	evidence["handoffs"] = recorded;
	expect(recorded.at(-1)).toEqual(
		expect.objectContaining({
			instanceId: s.claude,
			strategy: "fresh",
			afterSequence: 0,
			fallback: "resume_rejected",
		}),
	);
});

it("starts Claude fresh when the catch-up does not fit (entry 4)", async () => {
	const s = await switchFixture("over-budget", {
		CONDUIT_CONTEXT_HANDOFF_TOKEN_CAP: "1024",
	});
	await s.browser.send(s.sessionId, "ad4c-claude-one MARK-CLAUDE-1", 90_000);
	await s.switchTo(s.cursor, s.claude);
	await s.browser.send(
		s.sessionId,
		`ad4c-cursor-two ${"long ".repeat(400)}`,
		90_000,
	);
	await s.switchTo(s.claude, s.cursor);
	await s.browser.send(s.sessionId, "ad4c-claude-three", 90_000);
	const back = s.claudeTurn("ad4c-claude-three");
	evidence["claudeReturn"] = back;
	expect(back?.resumeId ?? null).toBeNull();
	expect(back?.prompt).toContain("[Conduit context handoff]");
	const recorded = s.handoffs();
	evidence["handoffs"] = recorded;
	expect(recorded.at(-1)).toEqual(
		expect.objectContaining({
			instanceId: s.claude,
			strategy: "fresh",
			afterSequence: 0,
			fallback: "catch_up_too_long",
		}),
	);
});

it("hands Cursor only the kept history after a rewind, and a later Claude turn starts fresh (entry 5)", async () => {
	const s = await switchFixture("rewind");
	await s.browser.send(s.sessionId, "ad4c-claude-one MARK-KEPT", 90_000);
	await s.browser.send(s.sessionId, "ad4c-claude-two MARK-CUT", 90_000);
	const cut = (await s.browser.history(s.sessionId))
		.filter(({ role }) => role === "user")
		.at(-1)?.id;
	if (!cut) throw new Error("Missing the second user message");
	await s.fixture.requestRpc({
		_tag: "RewindSession",
		sessionId: s.sessionId,
		messageId: String(cut),
	});
	await s.switchTo(s.cursor, s.claude);
	await s.browser.send(s.sessionId, "ad4c-cursor-three", 90_000);
	const cursorPrompt = s.cursorPrompts().at(-1) ?? "";
	evidence["cursorPrompt"] = cursorPrompt;
	expect(cursorPrompt).toContain("MARK-KEPT");
	expect(cursorPrompt).not.toContain("MARK-CUT");
	await s.switchTo(s.claude, s.cursor);
	await s.browser.send(s.sessionId, "ad4c-claude-four", 90_000);
	const back = s.claudeTurn("ad4c-claude-four");
	evidence["claudeReturn"] = back;
	expect(back?.resumeId ?? null).toBeNull();
	expect(back?.prompt).toContain("MARK-KEPT");
	expect(back?.prompt).not.toContain("MARK-CUT");
	const recorded = s.handoffs();
	evidence["handoffs"] = recorded;
	expect(recorded.at(-1)).toEqual(
		expect.objectContaining({ instanceId: s.claude, strategy: "fresh" }),
	);
});

it("still owes Cursor the handoff after a crash between the switch and its first turn (entry 7)", async () => {
	const s = await switchFixture("crash");
	await s.browser.send(s.sessionId, "ad4c-claude-one MARK-CLAUDE-1", 90_000);
	await s.switchTo(s.cursor, s.claude);
	await s.fixture.kill();
	await s.start();
	const browser = await s.fixture.connect();
	await browser.send(s.sessionId, "ad4c-cursor-two", 90_000);
	const cursorPrompt = s.cursorPrompts().at(-1) ?? "";
	evidence["cursorPrompt"] = cursorPrompt;
	expect(cursorPrompt).toContain("[Conduit context handoff]");
	expect(cursorPrompt).toContain("MARK-CLAUDE-1");
	const recorded = s.handoffs();
	evidence["handoffs"] = recorded;
	expect(recorded).toEqual([
		expect.objectContaining({ instanceId: s.cursor, strategy: "fresh" }),
	]);
});
