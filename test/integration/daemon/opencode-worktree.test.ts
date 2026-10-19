import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Either } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ListDaemonSessions,
	OpenCodeUseWorktree,
	SaveProject,
	SubmitInput,
} from "../../../src/lib/contracts/ws-rpc.js";
import { loadDaemonConfigResult } from "../../../src/lib/daemon/config-persistence.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import type { SessionWorkspaceChangedPayload } from "../../../src/lib/persistence/events.js";
import worktreePlugin from "../../../src/lib/provider/opencode-worktree-plugin.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

// Failure cases: wrong project/instance attribution, invalid destinations changing
// the workspace, duplicate moves, lost spawn config, and advertising an absent tool.
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
	});
}

function initRepo(directory: string) {
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
		"Initial commit",
	);
}

function moves(fixture: ProcessHarness) {
	const db = new Database(fixture.daemonStorePath(), { readonly: true });
	try {
		return db
			.prepare(
				"SELECT session_id, data FROM events WHERE project_id = 'process-test' AND type = 'session.workspace_changed' ORDER BY sequence",
			)
			.all()
			.map((row) => {
				const event = row as { session_id: string; data: string };
				return {
					sessionId: event.session_id,
					data: JSON.parse(event.data) as SessionWorkspaceChangedPayload,
				};
			});
	} finally {
		db.close();
	}
}

describe("OpenCode declared worktree moves", () => {
	let harness: ProcessHarness | undefined;
	let evidence: Record<string, unknown> = {};
	let scenario = "setup";

	async function start(name: string) {
		scenario = name;
		evidence = {};
		for (const key of [
			"GIT_DIR",
			"GIT_INDEX_FILE",
			"GIT_WORK_TREE",
			"GIT_COMMON_DIR",
		])
			vi.stubEnv(key, undefined);
		const fixture = ProcessHarness.create({ managedOpenCode: true });
		harness = fixture;
		initRepo(fixture.projectDir);
		const worktree = join(fixture.root, "linked worktree");
		git(
			fixture.projectDir,
			"worktree",
			"add",
			"-b",
			"feature/worktree",
			worktree,
		);
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
							plugin: ["file:///existing-plugin.js"],
							instructions: ["existing-instructions.md"],
						}),
					},
				})),
			}),
		);
		await fixture.restart();
		return {
			fixture,
			worktree: realpathSync(worktree),
			socket: join(fixture.configDir, "relay.sock"),
		};
	}

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		try {
			evidence["moves"] = existsSync(fixture.daemonStorePath())
				? moves(fixture)
				: [];
			evidence["errors"] =
				task.result?.errors?.map(({ message }) => message) ?? [];
			evidence["logs"] = fixture.logTail;
			const providerLog = join(
				fixture.configDir,
				"logs",
				"opencode-managed-test.log",
			);
			if (existsSync(providerLog))
				evidence["providerLog"] = readFileSync(providerLog, "utf8").slice(
					-8000,
				);
			evidence["requests"] = fixture.opencodeRequests();
		} finally {
			try {
				await fixture.dispose();
				fixture.assertNoRunners();
			} finally {
				mkdirSync("test-results", { recursive: true });
				writeFileSync(
					`test-results/q5u6-1-9-${scenario}.json`,
					JSON.stringify(evidence, null, 2).replaceAll(fixture.root, "<root>"),
				);
				harness = undefined;
				vi.unstubAllEnvs();
			}
		}
	});

	it("injects the plugin at spawn and moves only the calling session via the protected socket", async () => {
		const { fixture, worktree, socket } = await start("move");
		const browser = await fixture.connect();
		const sessionId = await browser.createSession(
			"Declared move",
			"managed-test",
			"opencode",
		);
		await sendRpcRequest(
			socket,
			new SubmitInput({
				sessionId,
				inputId: "worktree-prompt",
				text: "Reply with pong.",
				delivery: "queue",
			}),
		);
		await vi.waitFor(
			() =>
				expect(
					fixture
						.opencodeRequestBodies()
						.some(({ path }) => path.endsWith("/prompt_async")),
				).toBe(true),
			{ timeout: 10_000 },
		);
		const sent = fixture
			.opencodeRequestBodies()
			.find(({ path }) => path.endsWith("/prompt_async"));
		expect(sent).toBeDefined();
		const prompt = JSON.parse(sent?.body ?? "{}") as { system?: string };
		expect(prompt.system).toContain(
			"call conduit_use_worktree with its path instead of using cd",
		);
		evidence["prompt"] = prompt.system;
		const otherDirectory = join(fixture.root, "other-project");
		initRepo(otherDirectory);
		const { savedSlug } = await sendRpcRequest(
			socket,
			new SaveProject({ folders: [otherDirectory] }),
		);
		const otherBrowser = await fixture.connect(undefined, undefined, savedSlug);
		const otherSessionId = await otherBrowser.createSession(
			"Other project",
			"managed-test",
			"opencode",
		);

		const instance = Either.getOrThrowWith(
			loadDaemonConfigResult(fixture.configDir),
			(error) => error,
		)?.instances?.find(({ id }) => id === "managed-test");
		for (const key of [
			"CONDUIT_DAEMON_SOCKET",
			"CONDUIT_OPENCODE_INSTANCE_ID",
			"CONDUIT_OPENCODE_WORKTREE_PLUGIN",
		])
			expect(instance?.env).not.toHaveProperty(key);
		expect(instance?.env?.["OPENCODE_CONFIG_CONTENT"]).toBe(
			JSON.stringify({
				plugin: ["file:///existing-plugin.js"],
				instructions: ["existing-instructions.md"],
			}),
		);
		const spawnEnv = JSON.parse(
			readFileSync(
				join(fixture.configDir, "fake-opencode-worktree-env.json"),
				"utf8",
			),
		) as Record<string, string>;
		expect(spawnEnv["CONDUIT_DAEMON_SOCKET"]).toBe(socket);
		expect(spawnEnv["CONDUIT_OPENCODE_INSTANCE_ID"]).toBe("managed-test");
		const config = JSON.parse(spawnEnv["OPENCODE_CONFIG_CONTENT"] ?? "{}") as {
			plugin?: string[];
		};
		expect(config.plugin).toEqual([
			"file:///existing-plugin.js",
			expect.stringMatching(/opencode-worktree-plugin\.(ts|js)$/),
		]);
		expect(config).toMatchObject({
			instructions: ["existing-instructions.md"],
		});
		evidence["spawnEnv"] = spawnEnv;

		vi.stubEnv("CONDUIT_DAEMON_SOCKET", socket);
		vi.stubEnv("CONDUIT_OPENCODE_INSTANCE_ID", "managed-test");
		const plugin = await worktreePlugin();
		expect(Object.keys(plugin.tool)).toEqual(["conduit_use_worktree"]);
		// Seed a resumed binding whose provider id differs from Conduit's session id.
		const providerSessionId = `opencode-${sessionId}`;
		const db = new Database(fixture.daemonStorePath());
		try {
			expect(
				db
					.prepare(
						"UPDATE session_providers SET provider_sid = ? WHERE session_id = ? AND status = 'active'",
					)
					.run(providerSessionId, sessionId).changes,
			).toBe(1);
		} finally {
			db.close();
		}
		const alias = join(fixture.root, "linked-alias");
		symlinkSync(worktree, alias);
		const result = await plugin.tool.conduit_use_worktree.execute(
			{ path: alias },
			{ sessionID: providerSessionId, directory: fixture.projectDir },
		);
		expect(result).toContain(worktree);
		expect(result).toContain("moved");
		evidence["toolResult"] = result;
		const { sessions } = await sendRpcRequest(
			socket,
			new ListDaemonSessions({}),
		);
		expect(sessions.find(({ id }) => id === sessionId)).toMatchObject({
			workspace: {
				cause: "agent",
				worktrees: { [fixture.projectDir]: worktree },
			},
			git: { branch: "feature/worktree", worktree: "linked-worktree" },
		});
		expect(
			sessions.find(({ id }) => id === otherSessionId)?.workspace ?? null,
		).toBeNull();
		await plugin.tool.conduit_use_worktree.execute(
			{ path: worktree },
			{ sessionID: providerSessionId, directory: fixture.projectDir },
		);
		expect(moves(fixture)).toHaveLength(1);
	}, 60_000);

	it("loads the exact tool in a managed real OpenCode server", async ({
		skip,
	}) => {
		let binary: string;
		try {
			binary =
				process.env["CONDUIT_TEST_REAL_OPENCODE"] ??
				execFileSync("which", ["opencode"], { encoding: "utf8" }).trim();
		} catch {
			return skip("No real OpenCode binary available");
		}
		scenario = "real-plugin";
		evidence = {};
		const fixture = ProcessHarness.create({
			managedOpenCode: true,
			realOpenCode: binary,
		});
		harness = fixture;
		const launcher = join(fixture.root, "bin", "opencode");
		writeFileSync(
			launcher,
			readFileSync(launcher, "utf8").replace(
				'["serve",',
				'["--print-logs", "--log-level", "DEBUG", "serve",',
			),
		);
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
		if (version !== pinned)
			return skip(`OpenCode ${version} differs from the pinned SDK ${pinned}`);
		initRepo(fixture.projectDir);
		await fixture.restart();
		const browser = await fixture.connect();
		try {
			await browser.startInstance("managed-test");
		} catch (error) {
			// A cold, isolated OpenCode config can outlast the daemon's /path probe.
			expect(String(error)).toContain("Operation timed out after '4s'");
			evidence["coldStartTimeout"] = true;
		}
		const instance = Either.getOrThrowWith(
			loadDaemonConfigResult(fixture.configDir),
			(error) => error,
		)?.instances?.find(({ id }) => id === "managed-test");
		if (!instance?.port) throw new Error("Managed OpenCode did not start");
		for (const key of [
			"OPENCODE_CONFIG_CONTENT",
			"CONDUIT_DAEMON_SOCKET",
			"CONDUIT_OPENCODE_INSTANCE_ID",
			"CONDUIT_OPENCODE_WORKTREE_PLUGIN",
		])
			expect(instance.env).not.toHaveProperty(key);
		const read = async (path: string) => {
			const response = await fetch(`http://127.0.0.1:${instance.port}${path}`, {
				headers: {
					Authorization: `Basic ${Buffer.from(`${instance.env?.["OPENCODE_SERVER_USERNAME"]}:${instance.env?.["OPENCODE_SERVER_PASSWORD"]}`).toString("base64")}`,
					"x-opencode-directory": fixture.projectDir,
				},
				signal: AbortSignal.timeout(30_000),
			});
			expect(response.ok).toBe(true);
			return (await response.json()) as unknown;
		};
		const config = (await read("/config")) as { plugin?: string[] };
		expect(config.plugin).toContainEqual(
			expect.stringMatching(/opencode-worktree-plugin\.(ts|js)$/),
		);
		const tools = await read("/experimental/tool/ids");
		expect(tools).toContain("conduit_use_worktree");
		await browser.startInstance("managed-test");
		evidence["plugin"] = { version, config: config.plugin, tools };
	}, 60_000);

	it("returns typed refusals and readable tool results without changing the workspace", async () => {
		const { fixture, worktree, socket } = await start("refusals");
		const browser = await fixture.connect();
		const sessionId = await browser.createSession(
			"Refusals",
			"managed-test",
			"opencode",
		);
		const move = (
			path: string,
			providerSessionId = sessionId,
			instanceId = "managed-test",
		) =>
			sendRpcRequest(
				socket,
				new OpenCodeUseWorktree({ instanceId, providerSessionId, path }),
			);
		await move(worktree);
		const plain = join(fixture.root, "plain-directory");
		mkdirSync(plain);
		const other = join(fixture.root, "other-repo");
		initRepo(other);
		vi.stubEnv("CONDUIT_DAEMON_SOCKET", socket);
		vi.stubEnv("CONDUIT_OPENCODE_INSTANCE_ID", "managed-test");
		const plugin = await worktreePlugin();
		for (const [path, reason, message] of [
			[join(fixture.root, "missing"), "missing", "does not exist"],
			[plain, "not-a-worktree", "not a git worktree"],
			[other, "other-repository", "another repository"],
		] as const) {
			await expect(move(path)).rejects.toMatchObject({
				_tag: "WorkspaceMoveError",
				reason,
			});
			const result = await plugin.tool.conduit_use_worktree.execute(
				{ path },
				{ sessionID: sessionId, directory: fixture.projectDir },
			);
			expect(result).toContain(message);
			expect(result).toContain("refused");
		}
		await expect(
			move(fixture.projectDir, "unknown-session"),
		).rejects.toMatchObject({ _tag: "WsRpcError" });
		await expect(
			move(fixture.projectDir, sessionId, "opencode"),
		).rejects.toMatchObject({ _tag: "WsRpcError" });
		const { sessions } = await sendRpcRequest(
			socket,
			new ListDaemonSessions({}),
		);
		expect(
			sessions.find(({ id }) => id === sessionId)?.workspace,
		).toMatchObject({
			cause: "agent",
			worktrees: { [fixture.projectDir]: worktree },
		});
		expect(moves(fixture)).toHaveLength(1);
	}, 60_000);

	it("does not advertise the tool to an external OpenCode session", async () => {
		scenario = "external-prompt";
		evidence = {};
		const fixture = ProcessHarness.create({
			opencodeRecording: "chat-multi-turn",
		});
		harness = fixture;
		initRepo(fixture.projectDir);
		await fixture.restart();
		const browser = await fixture.connect();
		const sessionId = await browser.createSession(
			"External",
			undefined,
			"opencode",
			{ modelProviderId: "anthropic", modelId: "claude-opus-4-5-20251101" },
		);
		await browser.send(sessionId, "Reply with pong.");
		const sent = fixture
			.opencodeRequestBodies()
			.find(({ path }) => path.endsWith("/prompt_async"));
		expect(sent).toBeDefined();
		const prompt = JSON.parse(sent?.body ?? "{}") as { system?: string };
		expect(prompt.system ?? "").not.toContain("conduit_use_worktree");
		expect(moves(fixture)).toEqual([]);
		evidence["prompt"] = prompt;
	}, 60_000);
});
