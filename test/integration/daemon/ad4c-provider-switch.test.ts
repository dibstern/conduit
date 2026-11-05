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
// audit (failure catalogue 1-11) lives in the lane's audit.md; each step below
// names the entries it proves.
let harness: ProcessHarness | undefined;
const evidence: Record<string, unknown> = {};

afterEach(async ({ task }) => {
	const fixture = harness;
	harness = undefined;
	try {
		await fixture?.dispose();
	} finally {
		const artifact = `${JSON.stringify(
			{
				bead: "conduit-test-ad4c",
				result: task.result?.state,
				failures: task.result?.errors?.map(({ message }) => message),
				...evidence,
			},
			null,
			2,
		)}\n`;
		mkdirSync("test-results", { recursive: true });
		writeFileSync("test-results/ad4c-provider-switch.json", artifact);
		const scratch = process.env["AD4C_EVIDENCE_DIR"];
		if (scratch)
			copyFileSync(
				"test-results/ad4c-provider-switch.json",
				join(scratch, "ad4c-provider-switch.json"),
			);
	}
});

interface CursorCapture {
	kind?: string;
	data?: { prompt?: string | { text?: string }; agentId?: string };
}

it("round trips Claude, Cursor, Claude: Cursor gets a full handoff, Claude resumes and catches up", async () => {
	// A cross-driver switch runs the target account's default model (entry 10).
	harness = ProcessHarness.create({
		runnerLifecycle: { idleTimeoutMs: null },
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
	await fixture.restart({
		startupTimeoutMs: 90_000,
		runnerStartupTimeoutMs: 90_000,
		serviceEnvironment: {
			CONDUIT_CURSOR_SDK_TRACE: resolve(
				"test/fixtures/cursor-sdk-traces/basic.jsonl",
			),
			CONDUIT_CURSOR_SDK_CAPTURE: cursorCapture,
			CONDUIT_TEST_CURSOR_AUTH_STATE: cursorAuth,
		},
	});
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
	const sessionId = await browser.createSession("ad4c round trip", claude);
	await browser.send(sessionId, "ad4c-claude-one MARK-CLAUDE-1", 90_000);
	const store = () =>
		new Database(fixture.daemonStorePath(), { readonly: true });
	const receipt = (instanceId: string) => {
		const db = store();
		try {
			const row = db
				.prepare<[string, string], { value: string }>(
					"SELECT value FROM provider_state WHERE session_id = ? AND key = ?",
				)
				.get(sessionId, `nativeThread:${instanceId}`);
			return row
				? (JSON.parse(row.value) as {
						resumeSessionId: string;
						deliveredThrough: number;
					})
				: undefined;
		} finally {
			db.close();
		}
	};
	const handoffs = () => {
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
	};
	const firstReceipt = receipt(claude);
	if (!firstReceipt) throw new Error("Missing Claude receipt");

	// Round trip, part 1: Claude -> Cursor is a fresh full handoff.
	await fixture.requestRpc({
		_tag: "ContinueSession",
		sessionId,
		instanceId: cursor,
		expectedInstanceId: claude,
	});
	await browser.send(sessionId, "ad4c-cursor-two MARK-CURSOR-2", 90_000);
	const cursorSends = readFileSync(cursorCapture, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as CursorCapture)
		.filter(({ kind }) => kind === "send.options")
		.map(({ data }) =>
			typeof data?.prompt === "string"
				? data.prompt
				: (data?.prompt?.text ?? ""),
		);
	evidence["cursorPrompts"] = cursorSends;
	const cursorPrompt = cursorSends.at(-1) ?? "";
	expect(cursorPrompt).toContain("[Conduit context handoff]");
	expect(cursorPrompt).toContain("MARK-CLAUDE-1");
	expect(cursorPrompt.endsWith("ad4c-cursor-two MARK-CURSOR-2")).toBe(true);

	// Round trip, part 2: Cursor -> Claude resumes the old native thread and
	// catches up only what came after its receipt.
	await fixture.requestRpc({
		_tag: "ContinueSession",
		sessionId,
		instanceId: claude,
		expectedInstanceId: cursor,
	});
	await browser.send(sessionId, "ad4c-claude-three", 90_000);
	const back = fixture
		.claudeOptions()
		.filter(({ prompt }) => prompt?.endsWith("ad4c-claude-three"))
		.at(-1);
	evidence["claudeReturn"] = back;
	expect(back?.resumeId).toBe(firstReceipt.resumeSessionId);
	expect(back?.prompt).toContain("[Conduit context handoff]");
	expect(back?.prompt).toContain("MARK-CURSOR-2");
	expect(back?.prompt).not.toContain("MARK-CLAUDE-1");

	// Recorded: each handoff carries its strategy, range and input.
	const recorded = handoffs();
	evidence["handoffs"] = recorded;
	expect(recorded).toEqual([
		expect.objectContaining({
			instanceId: cursor,
			strategy: "fresh",
			afterSequence: 0,
		}),
		expect.objectContaining({
			instanceId: claude,
			strategy: "resume",
			afterSequence: firstReceipt.deliveredThrough,
		}),
	]);
	for (const handoff of recorded) {
		expect(handoff["inputId"]).toEqual(expect.any(String));
		expect(handoff["throughSequence"]).toBeGreaterThan(
			Number(handoff["afterSequence"]),
		);
	}
	expect(existsSync(cursorCapture)).toBe(true);
});
