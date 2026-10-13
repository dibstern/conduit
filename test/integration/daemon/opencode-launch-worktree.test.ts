// Failure cases: unsupported moves are offered, a tool ignores its launch cwd,
// or recreation, restart and recovery lose history or restore the wrong cwd.

import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { Either } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountIdSchema } from "../../../src/lib/contracts/provider-instance.js";
import {
	ContinueSessionInMainFolder,
	CreateSession,
	ListDaemonSessions,
	MoveSessionWorkspace,
	RecreateSessionWorktree,
	SaveProject,
} from "../../../src/lib/contracts/ws-rpc.js";
import { loadDaemonConfigResult } from "../../../src/lib/daemon/config-persistence.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

const gitEnv = { ...process.env };
for (const key of [
	"GIT_DIR",
	"GIT_INDEX_FILE",
	"GIT_WORK_TREE",
	"GIT_COMMON_DIR",
])
	delete gitEnv[key];
function git(directory: string, ...args: string[]) {
	return execFileSync("git", ["-C", directory, ...args], {
		env: gitEnv,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

describe("Managed real OpenCode launch workspace execution", () => {
	let harness: ProcessHarness | undefined;
	let modelServer: Server | undefined;
	let scenario = "setup";
	let evidence: Record<string, unknown> = {};

	afterEach(async ({ task }) => {
		evidence["result"] = task.result?.state;
		evidence["errors"] =
			task.result?.errors?.map(({ message }) => message) ?? [];
		const fixture = harness;
		try {
			if (fixture) {
				evidence["requests"] = fixture.opencodeRequests();
				if (task.result?.errors?.length) evidence["logs"] = fixture.logTail;
				await fixture.dispose();
				fixture.assertNoRunners();
				evidence["cleanup"] = "no fixture runners remain";
			}
		} finally {
			if (modelServer) {
				modelServer.closeAllConnections();
				await new Promise<void>((resolve) =>
					modelServer?.close(() => resolve()),
				);
			}
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				`test-results/q5u6-11-opencode-${scenario}.json`,
				JSON.stringify(evidence, null, 2),
			);
			harness = undefined;
			modelServer = undefined;
			vi.unstubAllEnvs();
		}
	});

	it.each([
		"existing",
		"secondary-existing",
		"new",
		"multi-folder-new",
	] as const)("enforces %s launch support and observes owned-worktree cwd through recreation, restart and recovery", async (mode) => {
		scenario = mode;
		evidence = { provider: "opencode", mode, paidModel: false };
		for (const key of [
			"GIT_DIR",
			"GIT_INDEX_FILE",
			"GIT_WORK_TREE",
			"GIT_COMMON_DIR",
		])
			vi.stubEnv(key, undefined);
		const binary =
			process.env["CONDUIT_TEST_REAL_OPENCODE"] ??
			execFileSync("which", ["opencode"], { encoding: "utf8" }).trim();
		const fixture = ProcessHarness.create({
			managedOpenCode: true,
			realOpenCode: binary,
		});
		harness = fixture;
		const version = execFileSync(binary, ["--version"], {
			encoding: "utf8",
			timeout: 15_000,
			env: {
				PATH: process.env["PATH"],
				HOME: join(fixture.root, "home"),
				XDG_CONFIG_HOME: fixture.configDir,
				XDG_CACHE_HOME: join(fixture.root, "cache"),
				XDG_DATA_HOME: join(fixture.root, "data"),
				XDG_STATE_HOME: join(fixture.root, "state"),
			},
		}).trim();
		const pinned = (
			JSON.parse(readFileSync("package.json", "utf8")) as {
				dependencies: Record<string, string>;
			}
		).dependencies["@opencode-ai/sdk"];
		expect(version).toBe(pinned);
		evidence["binaryVersion"] = version;

		// A deterministic, local OpenAI-compatible model. Only the real
		// OpenCode bash tool observes cwd; no requested/absolute cwd is supplied.
		const calls: Array<{ step: string | undefined; tool: boolean }> = [];
		evidence["modelCalls"] = calls;
		modelServer = createServer(async (request, response) => {
			let body = "";
			for await (const chunk of request) body += String(chunk);
			const input = JSON.parse(body) as {
				stream?: boolean;
				messages: Array<{ role: string; content: unknown }>;
			};
			const lastUser = input.messages
				.map(({ role }) => role)
				.lastIndexOf("user");
			const step = /observe-cwd (\w+)/.exec(
				JSON.stringify(input.messages[lastUser]?.content),
			)?.[1];
			const tool =
				step !== undefined &&
				!input.messages.slice(lastUser + 1).some(({ role }) => role === "tool");
			calls.push({ step, tool });
			const message = tool
				? {
						role: "assistant",
						content: null,
						tool_calls: [
							{
								id: `cwd_${step}`,
								type: "function",
								function: {
									name: "bash",
									arguments: JSON.stringify({
										command: `pwd > observed-${step}.txt; pwd`,
										description: "Observe the tool working directory",
									}),
								},
							},
						],
					}
				: {
						role: "assistant",
						content: step ? `Observed ${step}.` : "Workspace probe",
					};
			const result = {
				id: "cwd-probe",
				created: 1,
				model: "cwd",
				usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
			};
			if (input.stream) {
				response.writeHead(200, { "Content-Type": "text/event-stream" });
				const delta =
					"tool_calls" in message
						? {
								...message,
								tool_calls: message.tool_calls.map((call, index) => ({
									...call,
									index,
								})),
							}
						: message;
				response.write(
					`data: ${JSON.stringify({ ...result, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
				);
				response.write(
					`data: ${JSON.stringify({ ...result, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\n`,
				);
				response.end("data: [DONE]\n\n");
			} else {
				response.writeHead(200, { "Content-Type": "application/json" });
				response.end(
					JSON.stringify({
						...result,
						object: "chat.completion",
						choices: [{ index: 0, message, finish_reason: "stop" }],
					}),
				);
			}
		});
		await new Promise<void>((resolve) =>
			modelServer?.listen(0, "127.0.0.1", resolve),
		);
		const address = modelServer.address();
		if (!address || typeof address === "string")
			throw new Error("Missing scripted model port");
		const seed = Either.getOrThrowWith(
			loadDaemonConfigResult(fixture.configDir),
			(error) => error,
		);
		writeFileSync(
			join(fixture.configDir, "daemon.json"),
			JSON.stringify({
				...seed,
				instances: seed?.instances?.map((instance) => ({
					...instance,
					env: {
						...instance.env,
						OPENCODE_CONFIG_CONTENT: JSON.stringify({
							enabled_providers: ["workspace-test"],
							model: "workspace-test/cwd",
							small_model: "workspace-test/cwd",
							permission: "allow",
							provider: {
								"workspace-test": {
									npm: "@ai-sdk/openai-compatible",
									options: {
										baseURL: `http://127.0.0.1:${address.port}/v1`,
										apiKey: "test",
									},
									models: {
										cwd: {
											name: "Scripted cwd",
											tool_call: true,
											limit: { context: 16384, output: 1024 },
											cost: { input: 0, output: 0 },
										},
									},
								},
							},
						}),
					},
				})),
			}),
		);
		const createsWorktree = mode === "new" || mode === "multi-folder-new";
		const secondary = join(fixture.root, "secondary");
		const owner =
			mode === "secondary-existing" ? secondary : fixture.projectDir;
		const folders =
			mode === "secondary-existing" || mode === "multi-folder-new"
				? [fixture.projectDir, secondary]
				: [fixture.projectDir];
		for (const directory of folders) {
			mkdirSync(directory, { recursive: true });
			git(directory, "init", "-b", "main");
			git(
				directory,
				"-c",
				"user.name=Workspace test",
				"-c",
				"user.email=workspace@example.test",
				"-c",
				"core.hooksPath=/dev/null",
				"commit",
				"--allow-empty",
				"-m",
				directory === fixture.projectDir
					? "Initial commit"
					: "Secondary repository commit",
			);
		}
		const existing = join(fixture.root, "linked worktree");
		if (!createsWorktree)
			git(owner, "worktree", "add", "-b", "feature/existing", existing);
		await fixture.restart();
		const socket = join(fixture.configDir, "relay.sock");
		if (folders.length > 1) {
			await sendRpcRequest(
				socket,
				new SaveProject({
					slug: "process-test",
					folders,
				}),
			);
		}
		const browser = await fixture.connect();
		// Cold plugin/model configuration can outlast the daemon's /path probe.
		await vi.waitFor(() => browser.startInstance("managed-test"), {
			timeout: 60_000,
			interval: 500,
		});
		const { instances } = await browser.instances();
		expect(
			instances.find(({ id }) => id === "managed-test")?.capabilities,
		).toMatchObject({ supportsWorktree: false, supportsNewWorktree: true });
		const launch = new CreateSession({
			permissionMode: "ask",
			projectSlug: "process-test",
			originId: "cwd-test",
			title: "Workspace probe",
			instanceId: AccountIdSchema.make("managed-test"),
			providerId: "opencode",
			...(createsWorktree ? { newWorktree: true } : { worktreePath: existing }),
		});
		evidence["projectFolder"] = fixture.projectDir;
		if (!createsWorktree) {
			await expect(sendRpcRequest(socket, launch)).rejects.toMatchObject({
				_tag: "WorkspaceMoveError",
				reason: "unsupported-provider",
			});
			const { sessions } = await sendRpcRequest(
				socket,
				new ListDaemonSessions({ projectSlug: "process-test" }),
			);
			expect(sessions.some(({ title }) => title === "Workspace probe")).toBe(
				false,
			);
			evidence["rejection"] = "unsupported-provider";
			evidence["worktreePath"] = existing;
			if (mode === "secondary-existing") {
				const local = await sendRpcRequest(
					socket,
					new CreateSession({
						permissionMode: "ask",
						projectSlug: "process-test",
						originId: "cwd-test",
						title: "Cross-repository probe",
						instanceId: AccountIdSchema.make("managed-test"),
						providerId: "opencode",
					}),
				);
				// Browser instance responses redact credentials; native probes use config.
				const instance = Either.getOrThrowWith(
					loadDaemonConfigResult(fixture.configDir),
					(error) => error,
				)?.instances?.find(({ id }) => id === "managed-test");
				if (!instance?.port)
					throw new Error("Managed OpenCode instance is missing");
				const refusal = await fetch(
					`http://127.0.0.1:${instance.port}/experimental/control-plane/move-session`,
					{
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"x-opencode-directory": fixture.projectDir,
							Authorization: `Basic ${Buffer.from(`${instance.env?.["OPENCODE_SERVER_USERNAME"] ?? "opencode"}:${instance.env?.["OPENCODE_SERVER_PASSWORD"]}`).toString("base64")}`,
						},
						body: JSON.stringify({
							sessionID: local.sessionId,
							destination: { directory: existing },
							moveChanges: false,
						}),
						signal: AbortSignal.timeout(30_000),
					},
				);
				const body = await refusal.text();
				const native: unknown = body ? JSON.parse(body) : body;
				evidence["nativeMoveStatus"] = refusal.status;
				evidence["nativeMoveRefusal"] = native;
				expect(refusal.ok).toBe(false);
				expect(native).toMatchObject({
					name: "MoveSessionError",
					data: { message: "Destination directory belongs to another project" },
				});
			}
			expect(calls.filter(({ tool }) => tool)).toHaveLength(0);
			return;
		}
		const { sessionId } = await sendRpcRequest(socket, launch);
		const { sessions } = await sendRpcRequest(
			socket,
			new ListDaemonSessions({ projectSlug: "process-test" }),
		);
		const session = sessions.find(({ id }) => id === sessionId);
		const worktree = session?.workspace?.worktrees[owner] ?? "";
		if (!worktree) throw new Error("Launch did not record its workspace");
		expect(session?.workspace).toMatchObject({
			cause: "launch",
			origin: "conduit",
		});
		expect(Object.keys(session?.workspace?.worktrees ?? {}).sort()).toEqual(
			[...folders].sort(),
		);
		evidence["sessionId"] = sessionId;
		evidence["projectFolder"] = fixture.projectDir;
		evidence["worktreeOwner"] = owner;
		evidence["worktreePath"] = worktree;
		evidence["worktrees"] = session?.workspace?.worktrees;
		const observations: Array<{
			step: string;
			expectedCwd: string;
			observedCwd: string;
		}> = [];
		evidence["turns"] = observations;
		async function observe(
			connection: typeof browser,
			step: string,
			expected: string,
		) {
			await connection.send(sessionId, `observe-cwd ${step}`, 120_000);
			const file = join(expected, `observed-${step}.txt`);
			const other = join(
				expected === worktree ? fixture.projectDir : worktree,
				`observed-${step}.txt`,
			);
			const observed = readFileSync(
				existsSync(file) ? file : other,
				"utf8",
			).trim();
			observations.push({ step, expectedCwd: expected, observedCwd: observed });
			expect(realpathSync(observed)).toBe(realpathSync(expected));
			expect(existsSync(file)).toBe(true);
			expect(existsSync(other)).toBe(false);
		}
		await observe(browser, "launch", worktree);
		rmSync(worktree, { recursive: true, force: true });
		const recreated = await sendRpcRequest(
			socket,
			new RecreateSessionWorktree({ projectSlug: "process-test", sessionId }),
		);
		expect(recreated.directory).toBe(worktree);
		await observe(browser, "recreated", worktree);
		await expect(
			sendRpcRequest(
				socket,
				new MoveSessionWorkspace({
					projectSlug: "process-test",
					sessionId,
					path: worktree,
				}),
			),
		).rejects.toMatchObject({
			_tag: "WorkspaceMoveError",
			reason: "unsupported-provider",
		});
		expect(
			(await browser.history(sessionId)).filter(({ role }) => role === "user"),
		).toHaveLength(2);
		await fixture.shutdown();
		await fixture.restart();
		const restarted = await fixture.connect();
		await observe(restarted, "resumed", worktree);
		rmSync(worktree, { recursive: true, force: true });
		const recovered = await sendRpcRequest(
			socket,
			new ContinueSessionInMainFolder({
				projectSlug: "process-test",
				sessionId,
			}),
		);
		expect(recovered.directory).toBe(fixture.projectDir);
		await observe(restarted, "recovered", fixture.projectDir);
		expect(calls.filter(({ tool }) => tool)).toHaveLength(4);
	}, 300_000);
});
