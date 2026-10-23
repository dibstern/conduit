// Failure cases: creation relies on a first-send move, concurrent tools or
// events cross directories, forks run in main, or approvals use main's scope.
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Result as Either } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountIdSchema } from "../../../src/lib/contracts/provider-instance.js";
import { loadDaemonConfigResult } from "../../../src/lib/daemon/config-persistence.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import { ProcessHarness } from "../../helpers/process-harness.js";
import { resolveRealOpenCode } from "../../helpers/real-opencode.js";

describe("OpenCode sessions keep their effective working directories", () => {
	let harness: ProcessHarness | undefined;
	let modelServer: Server | undefined;
	let evidence: Record<string, unknown> = {};
	let replacements: Array<[string, string]> = [];

	afterEach(async ({ task }) => {
		const fixture = harness;
		try {
			evidence["result"] = task.result?.state;
			if (fixture) {
				// Keep session scopes stable across concurrent ordering and status polling.
				evidence["requestScopes"] = [
					...new Set(
						fixture
							.opencodeRequests()
							.filter(({ url }) => {
								const path = new URL(url, "http://opencode.test").pathname;
								return (
									path !== "/session/status" &&
									/^\/(api\/session|session|permission|question|experimental\/control-plane)/.test(
										path,
									)
								);
							})
							.map(({ method, url, directory }) => {
								const parsed = new URL(url, "http://opencode.test");
								return JSON.stringify({
									method,
									path: parsed.pathname,
									directory:
										parsed.searchParams.get("directory") ??
										(directory ? decodeURIComponent(directory) : null),
								});
							}),
					),
				]
					.sort()
					.map((entry) => JSON.parse(entry) as unknown);
				if (task.result?.errors?.length) {
					// Raw diagnostics stay separate from the normalized, repeatable artifact.
					writeFileSync(
						"/tmp/82tn7-session-directories-daemon.log",
						fixture.logTail,
					);
				}
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
			let normalized = JSON.stringify(evidence, null, 2);
			for (const [value, label] of replacements)
				normalized = normalized.replaceAll(value, label);
			const artifact = JSON.parse(normalized) as { requestScopes?: unknown[] };
			artifact.requestScopes?.sort((a, b) =>
				JSON.stringify(a).localeCompare(JSON.stringify(b)),
			);
			writeFileSync(
				"test-results/82tn7-session-directories.json",
				`${JSON.stringify(artifact, null, 2)}\n`,
			);
			harness = undefined;
			modelServer = undefined;
			vi.unstubAllEnvs();
		}
	});

	it("creates two worktree sessions, routes concurrent turns, and preserves fork and approval cwd", async () => {
		const checks: Array<{
			assertion: string;
			actual: unknown;
			expected: unknown;
		}> = [];
		evidence = { paidModel: false, checks };
		const check = (assertion: string, actual: unknown, expected: unknown) => {
			checks.push({ assertion, actual, expected });
			expect.soft(actual, assertion).toEqual(expected);
		};
		for (const key of [
			"GIT_DIR",
			"GIT_INDEX_FILE",
			"GIT_WORK_TREE",
			"GIT_COMMON_DIR",
		])
			vi.stubEnv(key, undefined);
		const binary = resolveRealOpenCode();
		const fixture = ProcessHarness.create({
			managedOpenCode: true,
			realOpenCode: binary,
		});
		harness = fixture;
		replacements = [[fixture.root, "<ROOT>"]];
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
		const external = join(fixture.root, "external", "token.txt");
		mkdirSync(join(fixture.root, "external"));
		writeFileSync(external, "82tn7-APPROVAL-MARKER\n");
		const markers: Record<string, string> = {
			s1: "82tn7-S1-MARKER",
			s2: "82tn7-S2-MARKER",
			fork: "82tn7-FORK-MARKER",
			approval: "82tn7-APPROVAL-MARKER",
		};
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
			const step = /session-directory (s1|s2|fork|approval)/.exec(
				JSON.stringify(input.messages[lastUser]?.content),
			)?.[1];
			const tool =
				step !== undefined &&
				!input.messages.slice(lastUser + 1).some(({ role }) => role === "tool");
			const message = tool
				? {
						role: "assistant",
						content: null,
						tool_calls: [
							{
								id: `directory_${step}`,
								type: "function",
								function: {
									name: step === "approval" ? "read" : "bash",
									arguments: JSON.stringify(
										step === "approval"
											? { filePath: external }
											: {
													command: `sleep 1; pwd; printf '%s\\n' '${markers[step]}'`,
													description: "Print the session directory and marker",
												},
									),
								},
							},
						],
					}
				: {
						role: "assistant",
						content: step ? `Completed ${step}.` : "Session directory probe",
					};
			const result = {
				id: "directory-probe",
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
							enabled_providers: ["directory-test"],
							model: "directory-test/cwd",
							small_model: "directory-test/cwd",
							permission: { "*": "allow", external_directory: "ask" },
							provider: {
								"directory-test": {
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
		const git = (...args: string[]) =>
			execFileSync("git", ["-C", fixture.projectDir, ...args], {
				env: { ...process.env },
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			}).trim();
		git("init", "-b", "main");
		git(
			"-c",
			"user.name=Directory test",
			"-c",
			"user.email=directories@example.test",
			"-c",
			"core.hooksPath=/dev/null",
			"commit",
			"--allow-empty",
			"-m",
			"Initial commit",
		);
		await fixture.restart();
		const socket = join(fixture.configDir, "relay.sock");
		const browser1 = await fixture.connect();
		const browser2 = await fixture.connect();
		await vi.waitFor(() => browser1.startInstance("managed-test"), {
			timeout: 60_000,
			interval: 500,
		});
		const create = async (title: string) =>
			(
				await sendRpcRequest(socket, {
					_tag: "CreateSession",
					permissionMode: "ask",
					projectSlug: "process-test",
					originId: browser1.originId,
					title,
					instanceId: AccountIdSchema.make("managed-test"),
					providerId: "opencode",
					model: { providerId: "directory-test", modelId: "cwd" },
					newWorktree: true,
				})
			).sessionId;
		const s1 = await create("Directory S1");
		const s2 = await create("Directory S2");
		const { sessions } = await sendRpcRequest(socket, {
			_tag: "ListDaemonSessions",
			projectSlug: "process-test",
		});
		const w1 = sessions.find(({ id }) => id === s1)?.workspace?.worktrees[
			fixture.projectDir
		];
		const w2 = sessions.find(({ id }) => id === s2)?.workspace?.worktrees[
			fixture.projectDir
		];
		if (!w1 || !w2)
			throw new Error("Both sessions must have recorded worktrees");
		replacements.unshift(
			[w1, "<W1>"],
			[w2, "<W2>"],
			[s1, "<session-1>"],
			[s2, "<session-2>"],
		);
		expect(realpathSync(w1)).not.toBe(realpathSync(w2));
		const worktrees = git("worktree", "list", "--porcelain");
		check("W1 is a git worktree", worktrees.includes(`worktree ${w1}\n`), true);
		check("W2 is a git worktree", worktrees.includes(`worktree ${w2}\n`), true);
		const instance = Either.getOrThrowWith(
			loadDaemonConfigResult(fixture.configDir),
			(error) => error,
		)?.instances?.find(({ id }) => id === "managed-test");
		if (!instance?.port) throw new Error("Managed OpenCode is missing");
		const native = async (sessionId: string, directory: string) => {
			const response = await fetch(
				`http://127.0.0.1:${instance.port}/session/${sessionId}?directory=${encodeURIComponent(directory)}`,
				{
					headers: {
						Authorization: `Basic ${Buffer.from(`${instance.env?.["OPENCODE_SERVER_USERNAME"] ?? "opencode"}:${instance.env?.["OPENCODE_SERVER_PASSWORD"]}`).toString("base64")}`,
					},
					signal: AbortSignal.timeout(10_000),
				},
			);
			expect(response.ok).toBe(true);
			return (await response.json()) as { id: string; directory: string };
		};
		const markerEvents: Array<{
			marker: string;
			sessionIds: string[];
			toolOutputs: unknown[];
		}> = [];
		evidence["markerEvents"] = markerEvents;
		const checkMarkers = (
			probes: ReadonlyArray<readonly [string, string, string]>,
		) => {
			const db = new Database(fixture.daemonStorePath(), { readonly: true });
			try {
				for (const [step, owner, directory] of probes) {
					const marker = markers[step];
					const rows = db
						.prepare(
							"SELECT session_id, type, data FROM events WHERE instr(data, ?) > 0 ORDER BY sequence",
						)
						.all(marker) as Array<{
						session_id: string;
						type: string;
						data: string;
					}>;
					// Include polling snapshots in attribution checks despite their variable timing.
					const owners = [
						...new Set(rows.map(({ session_id }) => session_id)),
					].sort();
					const outputs = rows
						.filter(({ type }) => type === "tool.completed")
						.map(
							({ data }) => (JSON.parse(data) as { result: unknown }).result,
						);
					check(`${step} marker events belong only to its session`, owners, [
						owner,
					]);
					check(
						`${step} tool output carries its marker`,
						outputs.some(
							(output) =>
								typeof output === "string" && output.includes(marker ?? ""),
						),
						true,
					);
					if (step !== "approval")
						check(
							`${step} bash pwd is its worktree`,
							outputs.some(
								(output) =>
									typeof output === "string" &&
									output.split("\n").includes(directory),
							),
							true,
						);
					markerEvents.push({
						marker: marker ?? "",
						sessionIds: owners,
						toolOutputs: outputs,
					});
				}
			} finally {
				db.close();
			}
		};
		check("S1 directory at creation", (await native(s1, w1)).directory, w1);
		check("S2 directory at creation", (await native(s2, w2)).directory, w2);
		const turns = await Promise.all([
			browser1.send(s1, "session-directory s1", 120_000),
			browser2.send(s2, "session-directory s2", 120_000),
		]);
		check(
			"both concurrent turns complete",
			turns.map(({ chunks }) => chunks.join("")),
			["Completed s1.", "Completed s2."],
		);
		check(
			"S1 upstream directory after send",
			(await native(s1, w1)).directory,
			w1,
		);
		check(
			"S2 upstream directory after send",
			(await native(s2, w2)).directory,
			w2,
		);
		// Check the original turns before fork history deliberately copies S2's transcript.
		checkMarkers([
			["s1", s1, w1],
			["s2", s2, w2],
		]);
		const fork = await sendRpcRequest(socket, {
			_tag: "ForkSession",
			sessionId: s2,
			originId: browser2.originId,
		});
		replacements.unshift([fork.sessionId, "<session-3>"]);
		check(
			"fork upstream directory",
			(await native(fork.sessionId, w2)).directory,
			w2,
		);
		check(
			"fork runs to completion",
			(
				await browser2.send(fork.sessionId, "session-directory fork", 120_000)
			).chunks.join(""),
			"Completed fork.",
		);
		const approvalCursor = browser2.frames.length;
		const approvalTurn = browser2.send(
			s2,
			"session-directory approval",
			120_000,
		);
		const permission = await browser2.waitFor(
			(message) =>
				message["type"] === "permission_pending" && message["sessionId"] === s2,
			approvalCursor,
			60_000,
		);
		const permissionId = String(permission["requestId"]);
		const providerPermissionId =
			fixture.providerRequestIdForPrompt(permissionId);
		check(
			"permission maps to its native OpenCode request",
			typeof providerPermissionId,
			"string",
		);
		replacements.unshift([permissionId, "<permission-1>"]);
		if (providerPermissionId !== undefined)
			replacements.unshift([providerPermissionId, "<provider-permission-1>"]);
		evidence["permission"] = {
			sessionId: s2,
			requestId: permissionId,
			providerRequestId: providerPermissionId,
			permission: permission["permission"],
		};
		await browser2.answerApproval(permission, "allow");
		check(
			"S2 permission reply resumes its turn",
			(await approvalTurn).chunks.join(""),
			"Completed approval.",
		);
		checkMarkers([
			["fork", fork.sessionId, w2],
			["approval", s2, w2],
		]);
		const requests = fixture.opencodeRequests();
		check(
			"no session move is needed",
			requests.filter(
				({ url }) =>
					url.split("?")[0] === "/experimental/control-plane/move-session",
			).length,
			0,
		);
		const creationFile = join(
			fixture.configDir,
			"real-opencode-session-creations.jsonl",
		);
		const creations = existsSync(creationFile)
			? readFileSync(creationFile, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line) as { id: string; directory: string })
			: [];
		check(
			"S1 was created in W1",
			creations.find(({ id }) => id === s1)?.directory,
			w1,
		);
		check(
			"S2 was created in W2",
			creations.find(({ id }) => id === s2)?.directory,
			w2,
		);
		for (const [label, path, directory] of [
			["S1 prompt", `/session/${s1}/prompt_async`, w1],
			["S2 prompt", `/session/${s2}/prompt_async`, w2],
			["S2 fork", `/session/${s2}/fork`, w2],
			[
				"permission reply",
				`/session/${s2}/permissions/${providerPermissionId}`,
				w2,
			],
		] as const) {
			const scopes = requests
				.filter(({ url }) => url.split("?")[0] === path)
				.map(
					({ url, directory: header }) =>
						new URL(url, "http://opencode.test").searchParams.get(
							"directory",
						) ?? (header ? decodeURIComponent(header) : null),
				);
			check(
				`${label} uses the stored directory`,
				[...new Set(scopes)],
				[directory],
			);
		}
		for (const [sessionId, directory] of [
			[s1, w1],
			[s2, w2],
			[fork.sessionId, w2],
		]) {
			for (const suffix of ["", "/message"]) {
				const reads = requests.filter(
					({ method, url }) =>
						method === "GET" &&
						url.split("?")[0] === `/session/${sessionId}${suffix}`,
				);
				const scopes = reads.map(
					({ url, directory: header }) =>
						new URL(url, "http://opencode.test").searchParams.get(
							"directory",
						) ?? (header ? decodeURIComponent(header) : null),
				);
				check(
					`${sessionId}${suffix} scoped reads use the stored directory`,
					scopes
						.filter((scope) => scope !== null)
						.every((scope) => scope === directory),
					true,
				);
			}
		}
	}, 300_000);
});
