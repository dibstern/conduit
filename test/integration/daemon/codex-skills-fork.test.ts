// Failure modes: skills leak between workspaces, malformed or disabled skills
// abort discovery, slash text changes in history, forks lose or repeat their
// hidden seed, a pending identity loses its seed after restart, or Codex tool
// parts disappear from another driver's context.
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	MessagePartRow,
	MessageWithParts,
} from "../../../src/lib/persistence/read-model-types.js";
import type { AppServerTraceReport } from "../../../src/lib/provider/codex/app-server/trace-player.js";
import {
	readCodexSessionIdentity,
	writeCodexSessionIdentity,
} from "../../../src/lib/provider/codex/codex-session-store.js";
import { renderForkDigest } from "../../../src/lib/provider/fork-digest.js";
import { connectRunner } from "../../../src/lib/provider/runner/runner-connection.js";
import type { RunnerSocket } from "../../../src/lib/provider/runner/runner-protocol.js";
import {
	codexModels,
	fixtureRows,
	rows,
	signedInCodexDiscoveryTrace,
	snapshot,
	type TraceRow,
} from "../../helpers/codex-app-server.js";
import {
	type ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";

const TIMEOUT = 90_000;
const MODEL = "gpt-6.1-sol";
type Driver = "codex" | "cursor" | "claude";

function inheritedMessages(fixture: ProcessHarness, sessionId: string) {
	const db = new Database(fixture.daemonStorePath(), { readonly: true });
	try {
		const messages = db
			.prepare<[string], MessageWithParts>(
				"SELECT * FROM messages WHERE session_id = ? AND is_inherited = 1 ORDER BY created_at, rowid",
			)
			.all(sessionId);
		for (const message of messages)
			message.parts = db
				.prepare<[string], MessagePartRow>(
					"SELECT * FROM message_parts WHERE message_id = ? ORDER BY sort_order",
				)
				.all(message.id);
		return messages;
	} finally {
		db.close();
	}
}

describe("Codex skills and digest forks through the daemon and detached runners", () => {
	let harness: ProcessHarness | undefined;
	let artifactRoot = "";
	let tracePath = "";
	let capturePath = "";
	let reportPath = "";
	let cursorCapture = "";
	let pendingRunner: ChildProcess | undefined;
	let pendingConnection: RunnerSocket | undefined;
	let evidence: Record<string, unknown> = {};
	const sessions = new Set<string>();

	function writeTrace(trace: TraceRow[], cwd = harness?.projectDir) {
		writeFileSync(
			tracePath,
			`${trace.map((row) => JSON.stringify(row).replaceAll("/workspace", cwd ?? "/workspace")).join("\n")}\n`,
		);
	}

	async function start(name: string, discovery = "model-list") {
		artifactRoot = resolve(`test-results/codex-skills-fork/${name}`);
		mkdirSync(artifactRoot, { recursive: true });
		reportPath = join(artifactRoot, "trace-report.jsonl");
		capturePath = join(artifactRoot, "capture.jsonl");
		writeFileSync(reportPath, "");
		writeFileSync(capturePath, "");
		evidence = { scenario: name };
		harness = ProcessHarness.create({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			restartProof: true,
			logLevel: "warn",
			relaySettings: {
				harnessDefaults: {
					codex: { providerId: "codex", modelId: MODEL, contextWindow: "" },
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
		tracePath = join(fixture.root, "codex-replay.jsonl");
		cursorCapture = join(artifactRoot, "cursor-capture.jsonl");
		writeFileSync(cursorCapture, "");
		const cursorTrace = join(fixture.root, "cursor-replay.jsonl");
		const cursorRows = rows<Record<string, unknown>>(
			resolve("test/fixtures/cursor-sdk-traces/basic.jsonl"),
		);
		cursorRows.splice(1, 0, {
			kind: "credential.store",
			data: {
				apiKey: "[REDACTED]",
				backendUrl: "https://api2.cursor.sh",
				createdAtMs: 0,
			},
		});
		writeFileSync(
			cursorTrace,
			`${cursorRows.map((row) => JSON.stringify(row)).join("\n")}\n`,
		);
		const discoveryRows = signedInCodexDiscoveryTrace();
		if (discovery === "skills-list") {
			const skills = fixtureRows(discovery);
			const signed = discoveryRows.find(
				(row) => row.message?.result?.["account"],
			)?.message?.result;
			const account = skills.find(
				(row) => row.message?.result && "account" in row.message.result,
			)?.message;
			if (!account || !signed) throw new Error("No recorded account response");
			account.result = signed;
			const listed = skills.find(
				({ message }) =>
					Array.isArray(message?.result?.["data"]) &&
					(message.result["data"] as { skills?: unknown }[]).some(
						({ skills }) => Array.isArray(skills),
					),
			)?.message?.result?.["data"] as
				| { skills: Record<string, unknown>[] }[]
				| undefined;
			const entry = listed?.find(({ skills }) => skills.length > 0);
			const valid = entry?.skills[0];
			if (!entry || !valid) throw new Error("No recorded skill descriptor");
			entry.skills.push(
				{ ...valid, name: "disabled-skill", enabled: false },
				{ ...valid, name: "malformed-skill", path: 42 },
				{ ...valid, name: "user-skill", scope: "user" },
			);
			writeTrace(skills);
		} else writeTrace(discoveryRows);
		const restartOptions = {
			startupTimeoutMs: TIMEOUT,
			runnerStartupTimeoutMs: TIMEOUT,
			serviceEnvironment: {
				CONDUIT_CODEX_APP_SERVER_TRACE: tracePath,
				CONDUIT_CODEX_APP_SERVER_CAPTURE: capturePath,
				CONDUIT_CODEX_APP_SERVER_TRACE_REPORT: reportPath,
				CONDUIT_CURSOR_SDK_TRACE: cursorTrace,
				CONDUIT_CURSOR_SDK_CAPTURE: cursorCapture,
			},
		};
		await fixture.restart(restartOptions);
		const browser = await fixture.connect();
		const accountId = await vi.waitFor(
			async () => {
				const accounts = (await browser.instances()).instances.filter(
					({ driver }) => driver === "codex",
				);
				expect(accounts).toHaveLength(1);
				const id = accounts[0]?.id;
				if (!id) throw new Error("No signed-in replay Codex account");
				return id;
			},
			{ timeout: TIMEOUT },
		);
		expect(await codexModels(browser, accountId)).toContainEqual(
			expect.objectContaining({ id: MODEL }),
		);
		return { fixture, browser, accountId, restartOptions };
	}

	async function create(
		browser: ProcessBrowser,
		driver: Driver,
		accountId?: string,
	) {
		const id = await browser.createSession(driver, accountId, driver, {
			modelId:
				driver === "codex"
					? MODEL
					: driver === "cursor"
						? "composer-2.5"
						: "sonnet",
			contextWindow: driver === "claude" ? "200k" : "",
			permissionMode: "full",
		});
		sessions.add(id);
		return id;
	}

	async function completed(fixture: ProcessHarness, id: string, count: number) {
		await vi.waitFor(
			() =>
				expect(snapshot(fixture, id).turns.map(({ state }) => state)).toEqual(
					Array.from({ length: count }, () => "completed"),
				),
			{ timeout: TIMEOUT },
		);
	}

	const requests = () =>
		rows<TraceRow>(capturePath).filter(
			({ dir, message }) => dir === "out" && message?.method === "turn/start",
		);
	const turnInput = (row: TraceRow | undefined) =>
		row?.message?.params?.["input"];
	const cursorPrompts = () =>
		rows<{ kind: string; data?: { prompt?: string } }>(cursorCapture)
			.filter(({ kind }) => kind === "send.options")
			.map(({ data }) => data?.prompt);

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		pendingConnection?.destroy();
		pendingConnection = undefined;
		if (pendingRunner) {
			pendingRunner.kill("SIGKILL");
			pendingRunner = undefined;
		}
		const state = Object.fromEntries(
			[...sessions].map((id) => [id, snapshot(fixture, id)]),
		);
		const logPath = join(fixture.configDir, "runners.log");
		const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
		try {
			await fixture.dispose();
			const reports = rows<AppServerTraceReport>(reportPath);
			evidence["traceReports"] = reports;
			expect(reports.length).toBeGreaterThan(0);
			for (const report of reports) {
				expect(report.consumed).toBe(report.total);
				expect(report.mismatches).toEqual([]);
				expect(report.unconsumed).toEqual([]);
			}
			expect(fixture.remainingRunnerPids()).toEqual([]);
		} finally {
			writeFileSync(
				join(artifactRoot, "events.json"),
				`${JSON.stringify(state, null, 2)}\n`,
			);
			writeFileSync(join(artifactRoot, "runners.log"), log);
			writeFileSync(
				join(artifactRoot, "evidence.json"),
				`${JSON.stringify({ ...evidence, result: task.result?.state, process: fixture.proof() }, null, 2)}\n`,
			);
			harness = undefined;
			sessions.clear();
		}
	});

	it(
		"discovers skills per workspace and keeps slash messages unchanged",
		async () => {
			const { fixture, browser, accountId } = await start(
				"workspace-skills",
				"skills-list",
			);
			const id = await create(browser, "codex", accountId);
			const commands = () =>
				Effect.runPromise(browser.rpc.GetCommands({ sessionId: id }));
			expect((await commands()).commands).toContainEqual({
				name: "fixture-skill",
				description: "Answer fixture greetings directly.",
			});
			expect((await commands()).commands).toContainEqual(
				expect.objectContaining({ name: "user-skill" }),
			);
			expect((await commands()).commands.map(({ name }) => name)).not.toContain(
				"disabled-skill",
			);
			expect((await commands()).commands.map(({ name }) => name)).not.toContain(
				"malformed-skill",
			);
			expect(fixture.proof().logTail).toContain("codex.skill_decode_failed");
			const otherRoot = join(fixture.root, "other-project");
			mkdirSync(otherRoot);
			const otherDiscovery = fixtureRows("skills-list");
			const otherAccount = otherDiscovery.find(
				({ message }) => message?.result && "account" in message.result,
			)?.message;
			const signedAccount = signedInCodexDiscoveryTrace().find(
				({ message }) => message?.result?.["account"],
			)?.message?.result;
			if (!otherAccount || !signedAccount)
				throw new Error("No recorded account response");
			otherAccount.result = signedAccount;
			// Authentication is cached by home; a new workspace reads only its catalog.
			const accountReadId = otherDiscovery.find(
				({ message }) => message?.method === "account/read",
			)?.message?.id;
			const otherText = JSON.stringify(
				otherDiscovery.filter(({ message }) => message?.id !== accountReadId),
			).replaceAll("fixture-skill", "other-skill");
			writeTrace(JSON.parse(otherText) as TraceRow[], otherRoot);
			const { savedSlug } = await Effect.runPromise(
				browser.rpc.SaveProject({ folders: [otherRoot] }),
			);
			const otherBrowser = await fixture.connect(
				undefined,
				undefined,
				savedSlug,
			);
			const otherId = await create(otherBrowser, "codex", accountId);
			expect(
				(
					await Effect.runPromise(
						otherBrowser.rpc.GetCommands({ sessionId: otherId }),
					)
				).commands,
			).toContainEqual(
				expect.objectContaining({
					name: "other-skill",
				}),
			);
			expect((await commands()).commands).toContainEqual(
				expect.objectContaining({ name: "fixture-skill" }),
			);
			expect((await commands()).commands).not.toContainEqual(
				expect.objectContaining({ name: "other-skill" }),
			);
			const skillTrace = fixtureRows("turn-skill").filter(
				({ dir }) => dir !== "exit",
			);
			const next = fixtureRows("two-turns");
			const skillThread = skillTrace.find(
				({ message }) => message?.method === "turn/start",
			)?.message?.params?.["threadId"];
			const nextThread = next.find(
				({ message }) => message?.method === "turn/start",
			)?.message?.params?.["threadId"];
			if (typeof skillThread !== "string" || typeof nextThread !== "string")
				throw new Error("No captured skill thread");
			const second = next.findIndex(
				(row, index) =>
					row.message?.method === "turn/start" &&
					index >
						next.findIndex((entry) => entry.message?.method === "turn/start"),
			);
			writeTrace([
				...skillTrace,
				...(JSON.parse(
					JSON.stringify(next.slice(second)).replaceAll(
						nextThread,
						skillThread,
					),
				) as TraceRow[]),
			]);
			await browser.send(id, "/fixture-skill Say hello", TIMEOUT);
			await browser.send(id, "/unknown-word Say hello again", TIMEOUT);
			await completed(fixture, id, 2);
			expect(turnInput(requests().at(-2))).toEqual([
				{ type: "text", text: "/fixture-skill Say hello", text_elements: [] },
				{
					type: "skill",
					name: "fixture-skill",
					path: join(
						fixture.projectDir,
						".agents/skills/fixture-skill/SKILL.md",
					),
				},
			]);
			expect(turnInput(requests().at(-1))).toEqual([
				{
					type: "text",
					text: "/unknown-word Say hello again",
					text_elements: [],
				},
			]);
			expect(
				(await browser.history(id))
					.filter(({ role }) => role === "user")
					.map(({ text }) => text),
			).toEqual(["/fixture-skill Say hello", "/unknown-word Say hello again"]);
			evidence["workspaces"] = [fixture.projectDir, otherRoot];
		},
		TIMEOUT * 3,
	);

	for (const [source, target] of [
		["codex", "codex"],
		["claude", "codex"],
		["cursor", "codex"],
		["codex", "cursor"],
		["codex", "claude"],
	] as const) {
		it(
			`seeds ${source} into ${target} once and retains Codex tool context${source === "codex" && target === "codex" ? " without native refs" : ""}`,
			async () => {
				const { fixture, browser, accountId } = await start(
					`${source}-to-${target}`,
				);
				let cursorAccount: string | undefined;
				if (source === "cursor" || target === "cursor") {
					cursorAccount = (
						await fixture.requestRpc({
							_tag: "AddInstance",
							name: "Cursor replay",
							driver: "cursor",
						})
					).addedInstanceId;
					if (!cursorAccount) throw new Error("No Cursor replay account");
				}
				const sourceId = await create(
					browser,
					source,
					source === "codex"
						? accountId
						: source === "cursor"
							? cursorAccount
							: undefined,
				);
				if (source === "codex") writeTrace(fixtureRows("turn-command"));
				const sourcePrompt = `SOURCE_CONTEXT_${source}: preserve this investigation.`;
				await browser.send(sourceId, sourcePrompt, TIMEOUT);
				await completed(fixture, sourceId, 1);
				if (source === "codex" && target === "codex") {
					// Legacy histories without native refs retain the digest contract.
					const db = new Database(fixture.daemonStorePath());
					try {
						db.prepare(
							"UPDATE events SET metadata = json_remove(metadata, '$.providerRefs') WHERE session_id = ?",
						).run(sourceId);
					} finally {
						db.close();
					}
				}
				const before = snapshot(fixture, sourceId);
				if (target !== source) writeTrace(signedInCodexDiscoveryTrace());
				const targetAccount =
					target === "codex"
						? accountId
						: target === "cursor"
							? cursorAccount
							: "claude";
				if (!targetAccount) throw new Error("No target fork account");
				const { sessionId: forkId } = await fixture.requestRpc({
					_tag: "ForkSession",
					originId: browser.originId,
					sessionId: sourceId,
					...(target !== source ? { instanceId: targetAccount } : {}),
				});
				sessions.add(forkId);
				if (target !== source) {
					writeTrace(signedInCodexDiscoveryTrace());
					await Effect.runPromise(
						browser.rpc.SwitchModel({
							sessionId: forkId,
							providerId: target,
							modelId:
								target === "codex"
									? MODEL
									: target === "cursor"
										? "composer-2.5"
										: "sonnet",
							originId: browser.originId,
						}),
					);
				}
				const inherited = inheritedMessages(fixture, forkId);
				const digest = renderForkDigest(inherited);
				expect(digest).toContain(sourcePrompt);
				const tools = inherited
					.flatMap(({ parts }) => parts)
					.filter(({ type }) => type === "tool");
				if (source === "codex") expect(tools.length).toBeGreaterThan(0);
				const cursorStart = cursorPrompts().length;
				const claudeStart = fixture.claudeOptions().length;
				if (target === "codex") {
					const trace = fixtureRows("fork-seed");
					const oldThread = trace.find(
						({ message }) => message?.method === "turn/start",
					)?.message?.params?.["threadId"];
					if (typeof oldThread !== "string")
						throw new Error("No captured fork thread");
					writeTrace(
						JSON.parse(
							JSON.stringify(trace).replaceAll(oldThread, randomUUID()),
						) as TraceRow[],
					);
				}
				await browser.send(forkId, "Say hello", TIMEOUT);
				await browser.send(forkId, "Say hello again", TIMEOUT);
				await completed(fixture, forkId, 3);
				if (target === "codex") {
					const turns = requests();
					expect(turns).toHaveLength(2);
					expect(turnInput(turns[0])).toEqual([
						{ type: "text", text: digest, text_elements: [] },
						{ type: "text", text: "Say hello", text_elements: [] },
					]);
					expect(turnInput(turns[1])).toEqual([
						{ type: "text", text: "Say hello again", text_elements: [] },
					]);
					expect(
						readCodexSessionIdentity(fixture.configDir, forkId)
							?.forkSeedPending,
					).not.toBe(true);
				} else if (target === "cursor") {
					expect(cursorPrompts().slice(cursorStart)).toEqual([
						`${digest}\n\n[Current request]\nSay hello`,
						"Say hello again",
					]);
				} else {
					const prompts = fixture
						.claudeOptions()
						.slice(claudeStart)
						.map(({ prompt }) => prompt)
						.filter((prompt): prompt is string => typeof prompt === "string");
					expect(prompts).toHaveLength(2);
					expect(prompts[0]).toContain("[Conduit context handoff]");
					expect(prompts[0]).toContain(sourcePrompt);
					for (const tool of tools) {
						const input = JSON.parse(tool.input ?? "{}") as {
							command?: string;
						};
						expect(prompts[0]).toContain("Command:");
						if (input.command) expect(prompts[0]).toContain(input.command);
					}
					expect(prompts[1]).toBe("Say hello again");
				}
				for (const tool of tools)
					expect(digest).toContain(`Tool: ${tool.tool_name} (${tool.status})`);
				expect(snapshot(fixture, sourceId)).toEqual(before);
				expect(
					(await browser.history(forkId))
						.filter(({ role }) => role === "user")
						.map(({ text }) => text),
				).toEqual([sourcePrompt, "Say hello", "Say hello again"]);
				evidence["fork"] = {
					sourceId,
					forkId,
					source,
					target,
					digest,
					toolParts: tools.length,
				};
			},
			TIMEOUT * 3,
		);
	}

	it(
		"retains a pending identity across a runner restart before its first turn",
		async () => {
			const { fixture, browser, accountId, restartOptions } = await start(
				"pending-seed-restart",
			);
			const sourceId = await create(browser, "codex", accountId);
			writeTrace(fixtureRows("basic"));
			await browser.send(
				sourceId,
				"Remember the inherited source context.",
				TIMEOUT,
			);
			await completed(fixture, sourceId, 1);
			const { sessionId: forkId } = await fixture.requestRpc({
				_tag: "ForkSession",
				originId: browser.originId,
				sessionId: sourceId,
			});
			sessions.add(forkId);
			const socketPath = join(fixture.root, "pending-codex.sock");
			const runnerId = randomUUID();
			pendingRunner = spawn(
				process.execPath,
				[
					resolve(
						process.env["CONDUIT_TEST_DIST"] ?? "dist",
						"src/bin/claude-session-runner.js",
					),
					socketPath,
					forkId,
					runnerId,
					"active",
					"codex",
				],
				{
					cwd: fixture.projectDir,
					env: {
						...process.env,
						HOME: fixture.root,
						CONDUIT_CONFIG_DIR: fixture.configDir,
					},
					stdio: ["ignore", "ignore", "ignore", "ipc"],
				},
			);
			const previousRunner = pendingRunner.pid;
			if (!previousRunner) throw new Error("No owned pending Codex runner pid");
			await vi.waitFor(() => expect(existsSync(socketPath)).toBe(true), {
				timeout: TIMEOUT,
			});
			pendingConnection = await Effect.runPromise(
				connectRunner({
					socketPath,
					sessionId: forkId,
					runnerId,
					pid: previousRunner,
					driverKind: "codex",
					deps: {
						workspaceRoot: fixture.projectDir,
						daemonConfigDir: fixture.configDir,
					},
					runFork: (effect) => Effect.runFork(effect),
					emit: () => Effect.succeed({}),
					onHello: () => Effect.void,
					onClose: () => {},
				}),
			);
			const trace = fixtureRows("fork-seed");
			const open = trace.find(
				({ message }) => message?.method === "thread/start",
			)?.message;
			const threadId = trace.find(
				({ message }) => message?.method === "turn/start",
			)?.message?.params?.["threadId"];
			if (!open || typeof threadId !== "string")
				throw new Error("No recorded thread creation");
			// Reconstruct the durable point after thread creation but before the first
			// turn. The recorded thread identity is real; no turn has reached this runner.
			writeCodexSessionIdentity(fixture.configDir, forkId, {
				threadId,
				cwd: fixture.projectDir,
				controllerPid: previousRunner,
				forkSeedPending: true,
			});
			expect(
				readCodexSessionIdentity(fixture.configDir, forkId)?.forkSeedPending,
			).toBe(true);
			pendingConnection.destroy();
			pendingConnection = undefined;
			pendingRunner.kill("SIGKILL");
			await vi.waitFor(
				() => expect(() => process.kill(previousRunner, 0)).toThrow(),
				{ timeout: TIMEOUT },
			);
			pendingRunner = undefined;
			await fixture.kill();
			writeTrace(signedInCodexDiscoveryTrace());
			await fixture.restart(restartOptions);
			const reconnected = await fixture.connect(forkId);
			await codexModels(reconnected, accountId);
			open.method = "thread/resume";
			open.params = { threadId, cwd: fixture.projectDir, model: MODEL };
			writeTrace(trace);
			const before = requests().length;
			const digest = renderForkDigest(inheritedMessages(fixture, forkId));
			await reconnected.send(forkId, "Say hello", TIMEOUT);
			await reconnected.send(forkId, "Say hello again", TIMEOUT);
			await completed(fixture, forkId, 3);
			const turns = requests().slice(before);
			expect(turns).toHaveLength(2);
			expect(turnInput(turns[0])).toEqual([
				{ type: "text", text: digest, text_elements: [] },
				{ type: "text", text: "Say hello", text_elements: [] },
			]);
			expect(turnInput(turns[1])).toEqual([
				{ type: "text", text: "Say hello again", text_elements: [] },
			]);
			expect(readCodexSessionIdentity(fixture.configDir, forkId)).toMatchObject(
				{ threadId },
			);
			expect(
				readCodexSessionIdentity(fixture.configDir, forkId)?.forkSeedPending,
			).not.toBe(true);
			evidence["restart"] = {
				setup: "reconstructed pending identity before first turn",
				previousRunner,
				resumedRunner: readCodexSessionIdentity(fixture.configDir, forkId)
					?.controllerPid,
				digest,
			};
		},
		TIMEOUT * 3,
	);
});
