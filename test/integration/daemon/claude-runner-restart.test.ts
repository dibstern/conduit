import {
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ProcessHarness,
	responseChunks,
} from "../../helpers/process-harness.js";

function persisted(harness: ProcessHarness, sessionId: string) {
	const db = new Database(join(harness.projectDir, ".conduit/events.db"), {
		readonly: true,
	});
	try {
		return {
			events: db
				.prepare(
					"SELECT type, data FROM events WHERE session_id = ? ORDER BY sequence",
				)
				.all(sessionId) as Array<{ type: string; data: string }>,
			commands: db
				.prepare(
					"SELECT command_id, status FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'send_turn'",
				)
				.all(sessionId) as Array<{ command_id: string; status: string }>,
		};
	} finally {
		db.close();
	}
}

function comparable(
	events: Array<{ type: string; data: string }>,
	root: string,
) {
	const ids = new Map<string, string>();
	return JSON.parse(
		JSON.stringify(
			events.map(({ type, data }) => ({
				type,
				data: JSON.parse(data) as unknown,
			})),
			(key, value: unknown) => {
				if (
					/^(createdAt|startedAt|completedAt|timestamp|durationMs)$/.test(key)
				)
					return "<clock>";
				if (typeof value !== "string") return value;
				return value
					.replaceAll(root, "<root>")
					.replace(
						/ses_[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
						(id) => {
							if (!ids.has(id)) ids.set(id, `id-${ids.size}`);
							return ids.get(id) ?? id;
						},
					);
			},
		),
	) as unknown;
}

function sdkProof(harness: ProcessHarness): Array<Record<string, unknown>> {
	return readFileSync(join(harness.root, "sdk-proof.ndjson"), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function settled(harness: ProcessHarness, sessionId: string) {
	await vi.waitFor(
		() => {
			const { events, commands } = persisted(harness, sessionId);
			expect(commands.map(({ status }) => status)).toEqual(["completed"]);
			expect(events.at(-1)).toMatchObject({ type: "session.status" });
			expect(JSON.parse(events.at(-1)?.data ?? "{}")).toMatchObject({
				status: "idle",
			});
		},
		{ timeout: 10_000 },
	);
}

describe("Claude runners survive server replacement through built dist", () => {
	const harnesses: ProcessHarness[] = [];
	const cleanupProofs: unknown[] = [];
	afterEach(async () => {
		for (const harness of harnesses) {
			await harness.dispose();
			expect(harness.remainingRunnerPids()).toEqual([]);
			cleanupProofs.push({
				root: harness.root,
				runnerPids: harness.runnerPids(),
				remainingPids: harness.remainingRunnerPids(),
			});
		}
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/85kb-9-cleanup.json",
			JSON.stringify({ proofs: cleanupProofs }, null, 2),
		);
		harnesses.length = 0;
	});

	it("replays a full turn exactly once after SIGKILL, including a committed output whose ack was lost", async () => {
		const sequences: unknown[] = [];
		const proofs: unknown[] = [];
		for (const restart of [false, true]) {
			const harness = await ProcessHarness.start({
				dist: "dist",
				claudeRunner: "process",
				restartProof: true,
				holdRunnerAck: restart,
			});
			harnesses.push(harness);
			let browser = await harness.connect();
			const sessionId = await browser.createSession("Restart proof");
			const pending = browser
				.send(sessionId, "restart-stream")
				.catch(() => undefined);
			await browser.waitFor((message) => message["type"] === "delta");
			const runner = harness.marks.find(
				(mark) => mark.kind === "runner-started",
			);
			if (runner?.kind !== "runner-started")
				throw new Error("Missing verified runner");
			let spooledBytes = 0;
			if (restart) {
				await harness.kill();
				expect(() => process.kill(runner.pid, 0)).not.toThrow();
				await vi.waitFor(() =>
					expect(statSync(`${runner.socketPath}.spool`).size).toBeGreaterThan(
						0,
					),
				);
				await vi.waitFor(() =>
					expect(
						sdkProof(harness).filter((mark) => mark["kind"] === "emit"),
					).toHaveLength(3),
				);
				spooledBytes = statSync(`${runner.socketPath}.spool`).size;
				await harness.restart();
				browser = await harness.connect(sessionId);
			} else await pending;
			await settled(harness, sessionId);
			await browser.view(sessionId);
			const history = await browser.history(sessionId);
			expect(JSON.stringify(history)).toContain(
				responseChunks("restart-stream").join(""),
			);
			await vi.waitFor(() =>
				expect(statSync(`${runner.socketPath}.spool`).size).toBe(0),
			);
			expect(
				sdkProof(harness).filter(
					(mark) =>
						mark["kind"] === "enqueue" && mark["prompt"] === "restart-stream",
				),
			).toHaveLength(1);
			const stored = persisted(harness, sessionId);
			expect(
				stored.events.filter(
					({ type, data }) =>
						type === "text.delta" &&
						responseChunks("restart-stream").includes(
							String((JSON.parse(data) as { text?: string }).text),
						),
				),
			).toHaveLength(3);
			sequences.push(comparable(stored.events, harness.root));
			proofs.push({
				restart,
				runner,
				spooledBytes,
				spoolAfterAck: statSync(`${runner.socketPath}.spool`).size,
				sdk: sdkProof(harness),
				history,
				...stored,
				process: harness.proof(),
			});
		}
		expect(sequences[1]).toEqual(sequences[0]);
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/85kb-9-restart.json",
			JSON.stringify({ sequences, proofs }, null, 2),
		);
	}, 60_000);

	it.each([
		"crash",
		"graceful",
		"uncommitted-ask",
		"committed-answer",
	] as const)("restores a Session Approval across %s restart", async (scenario) => {
		const harness = await ProcessHarness.start({
			dist: "dist",
			claudeRunner: "process",
			restartProof: true,
			...(scenario === "uncommitted-ask"
				? { holdRunnerOutput: "permission-request" as const }
				: scenario === "committed-answer"
					? { holdRunnerOutput: "answer-permission" as const }
					: {}),
		});
		harnesses.push(harness);
		const before = await harness.connect();
		const sessionId = await before.createSession("Approval restart proof");
		const pending = before
			.send(sessionId, "approval-restart")
			.catch(() => undefined);
		const request =
			scenario === "uncommitted-ask"
				? undefined
				: await before.waitFor(
						(message) => message["type"] === "permission_request",
					);
		if (scenario === "committed-answer" && request)
			await before.answerApproval(request, "allow_always");
		if (scenario === "uncommitted-ask" || scenario === "committed-answer")
			await vi.waitFor(
				() =>
					expect(
						sdkProof(harness).some((mark) => mark["kind"] === "held-output"),
					).toBe(true),
				{ timeout: 15_000 },
			);
		const runner = harness.marks.find((mark) => mark.kind === "runner-started");
		if (runner?.kind !== "runner-started")
			throw new Error("Missing verified runner");
		if (scenario === "graceful") {
			await before.restartServer();
			await harness.waitForExit();
		} else await harness.kill();
		await pending;
		expect(existsSync(runner.socketPath)).toBe(true);
		await harness.restart();
		const after = await harness.connect(sessionId);
		await after.view(sessionId);
		if (scenario !== "committed-answer") {
			const recovered =
				request ??
				(await after.waitFor(
					(message) => message["type"] === "permission_request",
				));
			await after.answerApproval(recovered, "allow");
		}
		if (scenario !== "committed-answer")
			await after.waitFor((message) => message["type"] === "done");
		await settled(harness, sessionId);
		expect(JSON.stringify(await after.history(sessionId))).toContain(
			responseChunks("approval-restart").join(""),
		);
		expect(
			sdkProof(harness).filter((mark) => mark["kind"] === "enqueue"),
		).toHaveLength(1);
		const approvals = sdkProof(harness).filter(
			(mark) => mark["kind"] === "approval",
		);
		expect(approvals).toHaveLength(1);
		expect(approvals[0]).toMatchObject({
			kind: "approval",
			prompt: "approval-restart",
			behavior: "allow",
		});
		if (scenario === "committed-answer")
			expect(approvals[0]?.["updatedPermissions"]).toEqual([
				{
					type: "addRules",
					rules: [{ toolName: "Bash", ruleContent: "printf harness-approved" }],
					behavior: "allow",
					destination: "session",
				},
			]);
		const stored = persisted(harness, sessionId);
		expect(
			stored.events.filter(({ type }) => type === "permission.asked"),
		).toHaveLength(1);
		expect(
			stored.events.filter(({ type }) => type === "permission.resolved"),
		).toHaveLength(1);
		await vi.waitFor(() =>
			expect(statSync(`${runner.socketPath}.spool`).size).toBe(0),
		);
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			`test-results/85kb-9-approval-${scenario}.json`,
			JSON.stringify(
				{
					scenario,
					runner,
					...stored,
					sdk: sdkProof(harness),
					process: harness.proof(),
				},
				null,
				2,
			),
		);
	}, 60_000);

	it("expires an orphaned runner when no server reattaches during its grace period", async () => {
		const harness = await ProcessHarness.start({
			dist: "dist",
			claudeRunner: "process",
			restartProof: true,
			runnerReattachGraceMs: 1000,
		});
		harnesses.push(harness);
		const browser = await harness.connect();
		const sessionId = await browser.createSession("Orphan grace proof");
		void browser.send(sessionId, "approval-grace").catch(() => undefined);
		await browser.waitFor(
			(message) => message["type"] === "permission_request",
		);
		const runner = harness.marks.find((mark) => mark.kind === "runner-started");
		if (runner?.kind !== "runner-started")
			throw new Error("Missing verified runner");
		await harness.kill();
		await vi.waitFor(
			() => expect(() => process.kill(runner.pid, 0)).toThrow(),
			{ timeout: 5000 },
		);
		expect(existsSync(`${runner.socketPath}.json`)).toBe(false);
		expect(existsSync(runner.socketPath)).toBe(false);
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/85kb-9-orphan-grace.json",
			JSON.stringify(
				{ graceMs: 1000, runner, runnerExited: true, process: harness.proof() },
				null,
				2,
			),
		);
	}, 30_000);

	it("terminates a suspended runner when its test parent disconnects", async () => {
		const harness = await ProcessHarness.start({
			dist: "dist",
			claudeRunner: "process",
			restartProof: true,
		});
		harnesses.push(harness);
		const browser = await harness.connect();
		const sessionId = await browser.createSession("Parent disconnect proof");
		await browser.send(sessionId, "parent-disconnect");
		await settled(harness, sessionId);
		const runner = harness.marks.find((mark) => mark.kind === "runner-started");
		if (runner?.kind !== "runner-started")
			throw new Error("Missing verified runner");
		process.kill(runner.pid, "SIGSTOP");
		try {
			await harness.disconnectParent();
			expect(() => process.kill(runner.pid, 0)).toThrow();
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/85kb-9-parent-disconnect.json",
				JSON.stringify(
					{ runner, runnerExited: true, process: harness.proof() },
					null,
					2,
				),
			);
		} finally {
			// This PID was verified before this test suspended its runner.
			try {
				process.kill(runner.pid, "SIGKILL");
			} catch {
				/* Already exited. */
			}
		}
	}, 30_000);
});
