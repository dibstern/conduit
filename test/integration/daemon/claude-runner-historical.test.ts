import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import type { ProcessMark } from "../../helpers/fake-claude-process-sdk.js";
import {
	historicalRunnerBundle,
	launchHistoricalRunners,
} from "../../helpers/historical-runner-bundle.js";
import {
	type ProcessBrowser,
	ProcessHarness,
	responseChunks,
} from "../../helpers/process-harness.js";

function answer(
	browser: ProcessBrowser,
	kind: "question" | "permission",
	request: Record<string, unknown>,
	text: string,
) {
	return kind === "permission"
		? browser.answerApproval(request, "allow")
		: browser["run"](
				browser.rpc.AnswerQuestion({
					projectSlug: "process-test",
					originId: browser.originId,
					commandId: randomUUID(),
					toolId: String(request["toolId"]),
					answers: { "0": text },
				}),
			);
}

function runnerCommands(harness: ProcessHarness) {
	const path = join(harness.root, "historical-runner-commands.ndjson");
	return existsSync(path)
		? readFileSync(path, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map(
					(line) =>
						JSON.parse(line) as {
							pid: number;
							commandId: string;
							type: string;
						},
				)
		: [];
}

function sdkProof(harness: ProcessHarness): ProcessMark[] {
	const path = join(harness.root, "sdk-proof.ndjson");
	return existsSync(path)
		? readFileSync(path, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as ProcessMark)
		: [];
}

function durable(harness: ProcessHarness, sessionId: string) {
	const db = new Database(harness.daemonStorePath(), { readonly: true });
	try {
		return {
			turns: db
				.prepare("SELECT state FROM turns WHERE session_id = ? ORDER BY rowid")
				.all(sessionId),
			commands: db
				.prepare(
					"SELECT command_id, status FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'send_turn' ORDER BY request_sequence",
				)
				.all(sessionId),
			events: db
				.prepare(
					"SELECT type FROM events WHERE session_id = ? ORDER BY sequence",
				)
				.all(sessionId) as Array<{ type: string }>,
		};
	} finally {
		db.close();
	}
}

// Failures: an unchanged historical peer is rejected, an answer is acknowledged
// without releasing canUseTool, raw answers change, duplicate native delivery,
// or a stale runner survives its idle boundary or consumes the next send.
it("adopts a pinned historical runner, delivers both answers, and replaces it at idle", async (context) => {
	const evidence: Record<string, unknown> = { passed: false };
	let harness: ProcessHarness | undefined;
	const sessions: string[] = [];
	try {
		const historical = await historicalRunnerBundle();
		evidence["historical"] = historical;
		if (!historical.available) context.skip(historical.reason);
		if (!historical.available) return;
		const currentDist = resolve(process.env["CONDUIT_TEST_DIST"] ?? "dist");
		const { buildId: currentBuildId } = JSON.parse(
			readFileSync(join(currentDist, "build-ready.json"), "utf8"),
		) as { buildId: string };
		expect(currentBuildId).not.toBe(historical.buildId);
		evidence["currentBuildId"] = currentBuildId;
		evidence["phase"] = "historical-startup";
		harness = ProcessHarness.create({
			dist: currentDist,
			buildId: historical.buildId,
			restartProof: true,
			logLevel: "info",
		});
		const useCurrentRunners = launchHistoricalRunners(harness, historical);
		await harness.restart({
			startupTimeoutMs: 60_000,
			runnerStartupTimeoutMs: 25_000,
		});
		const fixture = harness;
		const cases = [];
		for (const kind of ["question", "permission"] as const) {
			evidence["phase"] = `historical-${kind}-request`;
			const browser = await harness.connect();
			await browser.setAutoSettle(null);
			const sessionId = await browser.createSession(
				`Historical ${kind} answer`,
			);
			sessions.push(sessionId);
			await browser.preWarmSession(sessionId);
			const prompt = `${kind === "question" ? "question" : "approval"}-fixed-historical-answer`;
			const pending = browser.send(sessionId, prompt).catch(() => undefined);
			const request = await browser.waitFor(
				(frame) => frame["type"] === `${kind}_pending`,
			);
			const old = harness.marks.find(
				(mark) =>
					mark.kind === "runner-started" && mark.sessionId === sessionId,
			);
			if (old?.kind !== "runner-started")
				throw new Error("Missing historical runner hello");
			expect(old).toMatchObject({
				buildId: historical.buildId,
				settlesAnswers: false,
				answerDialect: "legacy",
			});
			const argv = JSON.parse(
				readFileSync(join(harness.root, `runner-argv-${old.pid}.json`), "utf8"),
			) as string[];
			expect(argv).toContain(
				join(historical.dist, "src/bin/claude-session-runner.js"),
			);
			cases.push({ kind, sessionId, prompt, pending, request, old, argv });
		}
		evidence["initialRunners"] = cases.map(({ old, argv }) => ({
			...old,
			argv,
		}));
		useCurrentRunners();
		await harness.kill();
		await Promise.all(cases.map(({ pending }) => pending));
		evidence["phase"] = "current-adoption";
		await harness.restart({
			buildId: currentBuildId,
			startupTimeoutMs: 60_000,
			runnerStartupTimeoutMs: 25_000,
		});
		const observations = [];
		for (const item of cases) {
			const { kind, sessionId, prompt, request, old } = item;
			evidence["phase"] = `legacy-${kind}-answer`;
			const browser = await harness.connect(sessionId);
			const recovered = await browser.waitFor(
				(frame) => frame["type"] === `${kind}_pending`,
			);
			expect(recovered[kind === "question" ? "toolId" : "requestId"]).toBe(
				request[kind === "question" ? "toolId" : "requestId"],
			);
			const cursor = browser.frames.length;
			const rawAnswer = "Continue with the original unredacted answer";
			await answer(browser, kind, recovered, rawAnswer);
			await browser.waitForTurnEnd(sessionId, cursor);
			const answers = sdkProof(harness).filter(
				(mark) => mark.kind === "prompt-answer" && mark.prompt === prompt,
			);
			expect(answers).toHaveLength(1);
			expect(answers[0]).toMatchObject({
				pid: old.pid,
				requestId: "0",
				response: {
					behavior: "allow",
					...(kind === "question"
						? { updatedInput: { answers: { "Continue?": rawAnswer } } }
						: { updatedInput: { command: "printf harness-approved" } }),
				},
			});
			const adopted = [...harness.marks]
				.reverse()
				.find((mark) => mark.kind === "runner-started" && mark.pid === old.pid);
			expect(adopted).toMatchObject({
				settlesAnswers: false,
				answerDialect: "legacy",
			});
			evidence["phase"] = `legacy-${kind}-upgrade`;
			await vi.waitFor(
				() => {
					expect(
						sdkProof(fixture).some(
							(mark) =>
								mark.kind === "runner-upgrade" &&
								mark.phase === "switched" &&
								mark.oldPid === old.pid,
						),
					).toBe(true);
					expect(fixture.remainingRunnerPids()).not.toContain(old.pid);
				},
				{ timeout: 15_000 },
			);
			const nextPrompt = `${kind === "question" ? "question" : "approval"}-fixed-current-after-historical`;
			evidence["phase"] = `current-${kind}-next-send`;
			const explicitAnswer = `answer-${kind}`;
			const legacyAnswers = runnerCommands(harness).filter(
				({ type }) => type === explicitAnswer,
			);
			expect(legacyAnswers).toHaveLength(1);
			const nextCursor = browser.frames.length;
			const next = browser.send(sessionId, nextPrompt);
			void next.catch(() => undefined);
			const currentRequest = await browser.waitFor(
				(frame) => frame["type"] === `${kind}_pending`,
				nextCursor,
			);
			await answer(browser, kind, currentRequest, rawAnswer);
			expect((await next).chunks.join("")).toBe(
				responseChunks(nextPrompt).join(""),
			);
			expect(
				runnerCommands(harness).filter(({ type }) => type === explicitAnswer),
			).toEqual(legacyAnswers);
			const enqueue = sdkProof(harness).find(
				(mark) => mark.kind === "enqueue" && mark.prompt === nextPrompt,
			);
			if (enqueue?.kind !== "enqueue")
				throw new Error("Missing next native send");
			const query = sdkProof(harness).find(
				(mark) => mark.kind === "query" && mark.queryId === enqueue.queryId,
			);
			if (query?.kind !== "query") throw new Error("Missing replacement query");
			expect(query.pid).not.toBe(old.pid);
			const currentAnswers = sdkProof(harness).filter(
				(mark) => mark.kind === "prompt-answer" && mark.prompt === nextPrompt,
			);
			expect(currentAnswers).toHaveLength(1);
			expect(currentAnswers[0]).toMatchObject({
				pid: query.pid,
				response: { behavior: "allow" },
			});
			expect(
				[...harness.marks]
					.reverse()
					.find(
						(mark) => mark.kind === "runner-started" && mark.pid === query.pid,
					),
			).toMatchObject({
				buildId: currentBuildId,
				settlesAnswers: true,
				answerDialect: "runner",
			});
			await vi.waitFor(() => {
				const state = durable(fixture, sessionId);
				expect(state.commands).toEqual([
					expect.objectContaining({ status: "completed" }),
					expect.objectContaining({ status: "completed" }),
				]);
				expect(
					state.events.filter(({ type }) => type === "turn.completed"),
				).toHaveLength(2);
				expect(
					state.events.filter(
						({ type }) => type === "turn.error" || type === "turn.interrupted",
					),
				).toEqual([]);
			});
			for (const text of [prompt, nextPrompt])
				expect(
					sdkProof(harness).filter(
						(mark) => mark.kind === "enqueue" && mark.prompt === text,
					),
				).toHaveLength(1);
			observations.push({
				kind,
				sessionId,
				old,
				adopted,
				answers,
				currentAnswers,
				replacementQuery: query,
				durable: durable(harness, sessionId),
			});
		}
		evidence["observations"] = observations;
		evidence["phase"] = "completed";
		evidence["passed"] = true;
	} catch (cause) {
		evidence["error"] = cause instanceof Error ? cause.stack : String(cause);
		throw cause;
	} finally {
		try {
			if (harness) {
				const fixture = harness;
				try {
					evidence["sdk"] = sdkProof(fixture);
					evidence["runnerCommands"] = runnerCommands(fixture);
					evidence["beforeCleanup"] = fixture.proof();
					evidence["durable"] = sessions.map((sessionId) => ({
						sessionId,
						...durable(fixture, sessionId),
					}));
				} finally {
					try {
						await fixture.dispose();
						expect(fixture.remainingRunnerPids()).toEqual([]);
					} finally {
						evidence["cleanup"] = {
							remainingRunnerPids: fixture.remainingRunnerPids(),
							proof: fixture.proof(),
						};
					}
				}
			}
		} finally {
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/u1y3i-1-nu48u-historical-runner.json",
				JSON.stringify(evidence, null, 2),
			);
		}
	}
}, 420_000);
