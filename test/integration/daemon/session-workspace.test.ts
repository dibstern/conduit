import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CancelSession,
	CreateSession,
	ListDaemonSessions,
	ListWorktrees,
	MoveSessionWorkspace,
	SaveProject,
	SendMessage,
} from "../../../src/lib/contracts/ws-rpc.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import type { SessionWorkspaceChangedPayload } from "../../../src/lib/persistence/events.js";
import type { SessionGit } from "../../../src/lib/shared-types.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

// Hooks such as lefthook export these for the enclosing checkout. Every git
// command here (and in the child daemon) must operate on the isolated repos.
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

function workspaceEvents(harness: ProcessHarness) {
	const db = new Database(harness.projectStorePath(), { readonly: true });
	try {
		return db
			.prepare(
				"SELECT session_id, data FROM events WHERE type = 'session.workspace_changed' ORDER BY sequence",
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

function sessionQueries(harness: ProcessHarness, sessionId: string) {
	const pids = new Set(
		harness.marks.flatMap((mark) =>
			mark.kind === "runner-started" && mark.sessionId === sessionId
				? [mark.pid]
				: [],
		),
	);
	return harness
		.claudeOptions()
		.filter(({ pid, options }) => pids.has(pid) && options["maxTurns"] !== 0);
}

describe("Session workspace through the built daemon", () => {
	let harness: ProcessHarness | undefined;
	let scenario = "setup";
	let evidence: Record<string, unknown> = {};

	async function start(name: string, opencodeRecording?: string) {
		for (const key of [
			"GIT_DIR",
			"GIT_INDEX_FILE",
			"GIT_WORK_TREE",
			"GIT_COMMON_DIR",
		])
			vi.stubEnv(key, undefined);
		scenario = name;
		evidence = {};
		harness = ProcessHarness.create({
			...(opencodeRecording ? { opencodeRecording } : {}),
			claudeReplay: {
				turns: ["pong-thinking-text-turn", "pong-thinking-text-turn"],
				delayMs: name === "running" ? 100 : 0,
			},
		});
		initRepo(harness.projectDir);
		const first = join(harness.root, "workspace-one");
		const second = join(harness.root, "workspace-two");
		git(harness.projectDir, "worktree", "add", "-b", "feature/one", first);
		git(harness.projectDir, "worktree", "add", "-b", "feature/two", second);
		writeFileSync(join(first, "dirty.txt"), "workspace one\n");
		await harness.restart();
		return {
			harness,
			main: realpathSync(harness.projectDir),
			first: realpathSync(first),
			second: realpathSync(second),
			socket: join(harness.configDir, "relay.sock"),
		};
	}

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		try {
			evidence["events"] = existsSync(fixture.projectStorePath())
				? workspaceEvents(fixture)
				: [];
			evidence["logs"] = fixture.logTail;
			evidence["opencodeDiagnostics"] = fixture.opencodeDiagnostics();
			evidence["queries"] = fixture.claudeOptions();
			evidence["opencodeRequests"] = fixture.opencodeRequestBodies();
			evidence["errors"] =
				task.result?.errors?.map(({ message }) => message) ?? [];
		} finally {
			try {
				await fixture.dispose();
				expect(fixture.remainingRunnerPids()).toEqual([]);
			} finally {
				mkdirSync("test-results", { recursive: true });
				// Replace paths in both map keys and values, including macOS /tmp aliases.
				const normalized = JSON.stringify(evidence, null, 2)
					.replaceAll(
						fixture.root.replace(/^\/tmp\//, "/private/tmp/"),
						"<root>",
					)
					.replaceAll(fixture.root, "<root>");
				writeFileSync(`test-results/q5u6-1-2-${scenario}.json`, normalized);
				harness = undefined;
				vi.unstubAllEnvs();
			}
		}
	});

	it("moves by RPC, launches the next turn there and keeps each session's git", async () => {
		const {
			harness: fixture,
			main,
			first,
			second,
			socket,
		} = await start("move");
		const browser = await fixture.connect();
		const old = await browser.createSession("Unmoved session");
		const one = await browser.createSession("Worktree one");
		await browser.send(one, "Reply with pong.");
		expect(sessionQueries(fixture, one).at(-1)?.options["cwd"]).toBe(
			fixture.projectDir,
		);
		const two = await browser.createSession("Worktree two");
		const move = (sessionId: string, path: string) =>
			sendRpcRequest(
				socket,
				new MoveSessionWorkspace({
					projectSlug: "process-test",
					sessionId,
					path,
				}),
			);
		await move(one, first);
		await move(two, second);
		const list = () =>
			sendRpcRequest(
				socket,
				new ListDaemonSessions({
					projectSlug: "process-test",
					scope: "process-test",
				}),
			);
		await vi.waitFor(async () => {
			const { sessions } = await list();
			expect(sessions.find(({ id }) => id === one)).toMatchObject({
				workspace: {
					worktrees: { [fixture.projectDir]: first },
					origin: "existing",
				},
				git: { branch: "feature/one", worktree: basename(first), dirty: true },
			});
			expect(sessions.find(({ id }) => id === two)).toMatchObject({
				workspace: {
					worktrees: { [fixture.projectDir]: second },
					origin: "existing",
				},
				git: {
					branch: "feature/two",
					worktree: basename(second),
					dirty: false,
				},
			});
			const unchanged = sessions.find(({ id }) => id === old);
			expect(unchanged?.workspace ?? null).toBeNull();
			expect(unchanged?.git?.branch).toBe("main");
		});
		const count = workspaceEvents(fixture).length;
		const alias = join(fixture.root, "workspace-alias");
		symlinkSync(first, alias);
		await move(one, alias);
		expect(workspaceEvents(fixture)).toHaveLength(count);
		await browser.view(one);
		const reply = await browser.send(one, "Reply with pong again.");
		expect(reply.chunks.join("")).toBe("pong");
		expect(sessionQueries(fixture, one).at(-1)?.options["cwd"]).toBe(first);

		// A vanished registered worktree is prunable and must not be offered.
		const gone = join(fixture.root, "gone");
		git(fixture.projectDir, "worktree", "add", "-b", "gone", gone);
		rmSync(gone, { recursive: true });
		const { worktrees } = await sendRpcRequest(
			socket,
			new ListWorktrees({ projectSlug: "process-test" }),
		);
		expect(worktrees).toEqual([
			{ path: main, branch: "main", main: true },
			{ path: first, branch: "feature/one", main: false },
			{ path: second, branch: "feature/two", main: false },
		]);
		const beforeRefresh = browser.frames.length;
		git(first, "branch", "-m", "feature/after-refresh");
		await browser.waitFor(
			(frame) =>
				frame["type"] === "session_row" &&
				frame["id"] === one &&
				(frame["git"] as SessionGit | undefined)?.branch ===
					"feature/after-refresh",
			beforeRefresh,
		);
		git(fixture.projectDir, "branch", "-m", "main-after-move");
		const beforeReset = browser.frames.length;
		await move(one, main);
		const resetRow = await browser.waitFor(
			(frame) =>
				frame["type"] === "session_row" &&
				frame["id"] === one &&
				frame["workspace"] == null,
			beforeReset,
		);
		expect(resetRow["git"]).toMatchObject({ branch: "main-after-move" });
		await move(one, fixture.projectDir);
		expect(workspaceEvents(fixture)).toHaveLength(count + 1);
		expect(workspaceEvents(fixture).at(-1)?.data).toEqual({
			sessionId: one,
			cause: "user",
			worktrees: {},
			origin: "existing",
		});
		expect(
			(await list()).sessions.find(({ id }) => id === one)?.workspace ?? null,
		).toBeNull();
		evidence["sessions"] = (await list()).sessions;
		await fixture.shutdown();
		await fixture.restart();
		// A daemon list can read a cold project's persisted workspace without
		// opening its relay or relying on cache entries from the prior process.
		await vi.waitFor(
			async () => {
				const { sessions } = await list();
				expect(sessions.find(({ id }) => id === two)?.git?.branch).toBe(
					"feature/two",
				);
				expect(sessions.find(({ id }) => id === old)?.git?.branch).toBe(
					"main-after-move",
				);
			},
			{ timeout: 5_000 },
		);
	}, 90_000);

	it("refuses invalid moves with typed reasons without appending events", async () => {
		const { harness: fixture, first, socket } = await start("invalid");
		const browser = await fixture.connect();
		const sessionId = await browser.createSession("Invalid moves");
		const plain = join(fixture.root, "plain");
		mkdirSync(plain);
		const other = join(fixture.root, "other-repo");
		initRepo(other);
		const nested = join(first, "nested");
		mkdirSync(nested);
		for (const [path, reason] of [
			[join(fixture.root, "missing"), "missing"],
			[plain, "not-a-worktree"],
			[nested, "not-a-worktree"],
			[other, "other-repository"],
		] as const) {
			await expect(
				sendRpcRequest(
					socket,
					new MoveSessionWorkspace({
						projectSlug: "process-test",
						sessionId,
						path,
					}),
				),
			).rejects.toMatchObject({ _tag: "WorkspaceMoveError", reason });
			expect(workspaceEvents(fixture)).toEqual([]);
		}
	}, 60_000);

	it("shows a move during a running turn immediately and applies it on the next turn", async () => {
		const { harness: fixture, first, socket } = await start("running");
		const browser = await fixture.connect();
		const sessionId = await browser.createSession("Running move");
		const reply = browser.send(sessionId, "Reply with pong.");
		await browser.waitFor(
			(frame) =>
				frame["type"] === "session_row" &&
				frame["id"] === sessionId &&
				frame["processing"] === true,
		);
		const cursor = browser.frames.length;
		await sendRpcRequest(
			socket,
			new MoveSessionWorkspace({
				projectSlug: "process-test",
				sessionId,
				path: first,
			}),
		);
		await browser.waitFor(
			(frame) =>
				frame["type"] === "session_row" &&
				frame["id"] === sessionId &&
				frame["workspace"] !== null &&
				frame["workspace"] !== undefined,
			cursor,
		);
		expect((await reply).chunks.join("")).toBe("pong");
		expect(sessionQueries(fixture, sessionId).at(-1)?.options["cwd"]).toBe(
			fixture.projectDir,
		);
		expect(
			(await browser.send(sessionId, "Reply with pong again.")).chunks.join(""),
		).toBe("pong");
		expect(sessionQueries(fixture, sessionId).at(-1)?.options["cwd"]).toBe(
			first,
		);
		expect(workspaceEvents(fixture)).toHaveLength(1);
	}, 60_000);

	it("uses a secondary folder's worktree as cwd and maps the other launch folders", async () => {
		const { harness: fixture, socket } = await start("extra-folder");
		const extra = join(fixture.root, "extra-repo");
		initRepo(extra);
		const linked = join(fixture.root, "extra-worktree");
		git(extra, "worktree", "add", "-b", "feature/extra", linked);
		await sendRpcRequest(
			socket,
			new SaveProject({
				slug: "process-test",
				folders: [fixture.projectDir, extra],
			}),
		);
		const browser = await fixture.connect();
		const sessionId = await browser.createSession("Secondary worktree");
		await sendRpcRequest(
			socket,
			new MoveSessionWorkspace({
				projectSlug: "process-test",
				sessionId,
				path: linked,
			}),
		);
		await browser.preWarmSession(sessionId);
		expect(sessionQueries(fixture, sessionId).at(-1)?.options).toMatchObject({
			cwd: realpathSync(linked),
			additionalDirectories: [fixture.projectDir],
		});
		expect(
			(await browser.send(sessionId, "Reply with pong.")).chunks.join(""),
		).toBe("pong");
		expect(workspaceEvents(fixture)[0]?.data.worktrees).toEqual({
			[extra]: realpathSync(linked),
		});
		// Selecting this repository's main checkout must keep it as cwd; only
		// selecting the primary project folder returns to the default workspace.
		await sendRpcRequest(
			socket,
			new MoveSessionWorkspace({
				projectSlug: "process-test",
				sessionId,
				path: extra,
			}),
		);
		expect(workspaceEvents(fixture).at(-1)?.data.worktrees).toEqual({
			[extra]: realpathSync(extra),
		});
		expect(
			(await browser.send(sessionId, "Reply with pong again.")).chunks.join(""),
		).toBe("pong");
		expect(sessionQueries(fixture, sessionId).at(-1)?.options).toMatchObject({
			cwd: realpathSync(extra),
			additionalDirectories: [fixture.projectDir],
		});
		// A missing primary checkout must not block a valid secondary repository.
		rmSync(fixture.projectDir, { recursive: true, force: true });
		try {
			await sendRpcRequest(
				socket,
				new MoveSessionWorkspace({
					projectSlug: "process-test",
					sessionId,
					path: linked,
				}),
			);
			expect(workspaceEvents(fixture).at(-1)?.data.worktrees).toEqual({
				[extra]: realpathSync(linked),
			});
		} finally {
			mkdirSync(fixture.projectDir);
		}
	}, 60_000);

	it("waits for an active OpenCode turn before relocating its next prompt", async () => {
		const {
			harness: fixture,
			first,
			socket,
		} = await start("opencode-running", "chat-multi-turn");
		const browser = await fixture.connect();
		const sessionId = await browser.createSession(
			"Queued OpenCode move",
			undefined,
			"opencode",
		);
		const release = fixture.holdNextOpenCodePrompt();
		const reply = browser.send(
			sessionId,
			"Remember the word 'banana'. Reply with only: ok, remembered.",
		);
		await browser.waitFor(
			(frame) =>
				frame["type"] === "session_row" &&
				frame["id"] === sessionId &&
				frame["processing"] === true,
		);
		await sendRpcRequest(
			socket,
			new MoveSessionWorkspace({
				projectSlug: "process-test",
				sessionId,
				path: first,
			}),
		);
		await sendRpcRequest(
			socket,
			new SendMessage({
				projectSlug: "process-test",
				sessionId,
				commandId: "workspace-queued-turn",
				text: "What word did I ask you to remember? Reply with just the word.",
			}),
		);
		const db = new Database(fixture.projectStorePath(), { readonly: true });
		try {
			// The RPC acknowledges admission, while this gate keeps native work busy.
			await new Promise<void>((resolve) => setTimeout(resolve, 250));
			expect(
				fixture
					.opencodeRequestBodies()
					.filter(
						({ path }) => path === "/experimental/control-plane/move-session",
					),
			).toEqual([]);
			expect(
				fixture
					.opencodeRequestBodies()
					.filter(({ path }) => path === `/session/${sessionId}/prompt_async`),
			).toHaveLength(1);
		} finally {
			db.close();
			release();
		}
		await reply;
		await vi.waitFor(
			() =>
				expect(
					fixture
						.opencodeRequestBodies()
						.filter(
							({ path }) => path === `/session/${sessionId}/prompt_async`,
						),
				).toHaveLength(2),
			{ timeout: 5_000 },
		);
		expect(
			fixture
				.opencodeRequestBodies()
				.filter(
					({ path }) => path === "/experimental/control-plane/move-session",
				)
				.map(({ body }) => JSON.parse(body)),
		).toEqual([
			{
				sessionID: sessionId,
				destination: { directory: first },
				moveChanges: false,
			},
		]);
	}, 90_000);

	it.each([
		false,
		true,
	])("does not relocate past a prompt still being submitted in the old folder (cancel: %s)", async (cancel) => {
		const {
			harness: fixture,
			first,
			socket,
		} = await start(
			cancel ? "opencode-submission-cancelled" : "opencode-submission",
			"chat-multi-turn",
		);
		const browser = await fixture.connect();
		const sessionId = await browser.createSession(
			"OpenCode submission barrier",
			undefined,
			"opencode",
		);
		const releaseTurn = fixture.holdNextOpenCodePrompt();
		const reply = browser.send(
			sessionId,
			"Remember the word 'banana'. Reply with only: ok, remembered.",
		);
		await browser.waitFor(
			(frame) =>
				frame["type"] === "session_row" &&
				frame["id"] === sessionId &&
				frame["processing"] === true,
		);
		const releaseRequest = fixture.holdNextOpenCodePromptRequest();
		const queue = (commandId: string, text: string) =>
			sendRpcRequest(
				socket,
				new SendMessage({
					projectSlug: "process-test",
					sessionId,
					commandId,
					text,
				}),
			);
		const prompts = () =>
			fixture
				.opencodeRequestBodies()
				.filter(({ path }) => path === `/session/${sessionId}/prompt_async`);
		const moves = () =>
			fixture
				.opencodeRequestBodies()
				.filter(
					({ path }) => path === "/experimental/control-plane/move-session",
				);
		try {
			await queue(
				"workspace-submitting-turn",
				"What word did I ask you to remember? Reply with just the word.",
			);
			await vi.waitFor(() => expect(prompts()).toHaveLength(2), {
				timeout: 5_000,
			});
			if (cancel) {
				releaseTurn();
				await reply;
				await sendRpcRequest(
					socket,
					new CancelSession({
						projectSlug: "process-test",
						sessionId,
						commandId: "workspace-cancel-submission",
					}),
				);
			}
			await sendRpcRequest(
				socket,
				new MoveSessionWorkspace({
					projectSlug: "process-test",
					sessionId,
					path: first,
				}),
			);
			await queue(
				"workspace-after-submission",
				"This destination turn must wait for prompt acceptance.",
			);
			releaseTurn();
			await reply;
			await new Promise<void>((resolve) => setTimeout(resolve, 300));
			expect(moves()).toEqual([]);
			expect(prompts()).toHaveLength(2);
		} finally {
			releaseTurn();
			releaseRequest();
		}
		await vi.waitFor(() => expect(moves()).toHaveLength(1), { timeout: 5_000 });
		expect(JSON.parse(moves()[0]?.body ?? "{}")).toMatchObject({
			sessionID: sessionId,
			destination: { directory: first },
		});
	}, 90_000);

	it("keeps unrelated OpenCode sessions out of followed worktrees and admits owned children", async () => {
		const {
			harness: fixture,
			first,
			socket,
		} = await start("opencode-ownership", "chat-multi-turn");
		const browser = await fixture.connect();
		const sessionId = await browser.createSession(
			"Owned OpenCode workspace",
			undefined,
			"opencode",
		);
		await sendRpcRequest(
			socket,
			new MoveSessionWorkspace({
				projectSlug: "process-test",
				sessionId,
				path: first,
			}),
		);
		await browser.send(
			sessionId,
			"Remember the word 'banana'. Reply with only: ok, remembered.",
		);
		// The same directory can be another project's primary folder. A child of
		// this project's moved session must still remain with its owning parent.
		const neighbour = await sendRpcRequest(
			socket,
			new SaveProject({ title: "Worktree neighbour", folders: [first] }),
		);
		await sendRpcRequest(
			socket,
			new CreateSession({
				projectSlug: neighbour.savedSlug,
				originId: "workspace-neighbour",
				providerId: "claude",
			}),
		);
		const release = fixture.holdNextOpenCodePrompt();
		const running = browser.send(
			sessionId,
			"What was the word I asked you to remember?",
		);
		await vi.waitFor(() =>
			expect(
				fixture
					.opencodeRequestBodies()
					.filter(({ path }) => path.endsWith("/prompt_async")),
			).toHaveLength(2),
		);
		const created = (id: string, parentID?: string) => ({
			type: "session.created",
			properties: {
				sessionID: id,
				info: {
					id,
					projectID: "project-workspace",
					directory: first,
					title: id,
					version: "1.18.34",
					time: { created: Date.now(), updated: Date.now() },
					...(parentID ? { parentID } : {}),
				},
			},
		});
		fixture.injectOpenCodeEvents(
			[
				created("ses_workspace_foreign"),
				created("ses_workspace_child", sessionId),
				{
					type: "session.created",
					properties: {
						info: created("ses_workspace_legacy_child", sessionId).properties
							.info,
					},
				},
			],
			first,
		);
		const db = new Database(fixture.projectStorePath(), { readonly: true });
		try {
			await vi.waitFor(
				() =>
					expect(
						db
							.prepare("SELECT id FROM sessions WHERE id IN (?, ?)")
							.all("ses_workspace_child", "ses_workspace_legacy_child"),
					).toHaveLength(2),
				{ timeout: 5_000 },
			);
			expect(
				db
					.prepare("SELECT id FROM sessions WHERE id = ?")
					.get("ses_workspace_foreign"),
			).toBeUndefined();
			evidence["ownedChildren"] = db
				.prepare("SELECT id, parent_id FROM sessions WHERE id IN (?, ?)")
				.all("ses_workspace_child", "ses_workspace_legacy_child");
			const otherDb = new Database(
				fixture.projectStorePath(neighbour.savedSlug),
				{ readonly: true },
			);
			try {
				expect(
					otherDb
						.prepare("SELECT id FROM sessions WHERE id IN (?, ?)")
						.all("ses_workspace_child", "ses_workspace_legacy_child"),
				).toHaveLength(0);
				evidence["neighbourSessions"] = otherDb
					.prepare("SELECT id, parent_id FROM sessions")
					.all();
			} finally {
				otherDb.close();
			}
		} finally {
			db.close();
			release();
			await running;
		}
	}, 90_000);

	it("relocates OpenCode before its next prompt and receives destination events", async () => {
		const {
			harness: fixture,
			first,
			second,
			socket,
		} = await start("opencode", "chat-multi-turn");
		const browser = await fixture.connect();
		const sessionId = await browser.createSession(
			"OpenCode workspace",
			undefined,
			"opencode",
		);
		const move = (path: string) =>
			sendRpcRequest(
				socket,
				new MoveSessionWorkspace({
					projectSlug: "process-test",
					sessionId,
					path,
				}),
			);
		await move(first);
		const remembered = await browser.send(
			sessionId,
			"Remember the word 'banana'. Reply with only: ok, remembered.",
		);
		expect(remembered.chunks.join("")).toContain("remembered");
		await move(fixture.projectDir);
		expect(
			(
				await browser.send(
					sessionId,
					"What word did I ask you to remember? Reply with just the word.",
				)
			).chunks.join(""),
		).toContain("banana");
		const nativeMoves = () =>
			fixture
				.opencodeRequestBodies()
				.filter(
					({ path }) => path === "/experimental/control-plane/move-session",
				)
				.map(({ body }) => JSON.parse(body) as Record<string, unknown>);
		expect(nativeMoves()).toEqual([
			{
				sessionID: sessionId,
				destination: { directory: first },
				moveChanges: false,
			},
			{
				sessionID: sessionId,
				destination: { directory: fixture.projectDir },
				moveChanges: false,
			},
		]);
		const prompts = () =>
			fixture
				.opencodeRequestBodies()
				.filter(({ path }) => path === `/session/${sessionId}/prompt_async`);
		expect(prompts()).toHaveLength(2);
		await move(second);
		fixture.rejectNextOpenCodeWorkspaceMove();
		await browser.send(
			sessionId,
			"This turn must not start in the wrong folder.",
		);
		expect(prompts()).toHaveLength(2);
		const db = new Database(fixture.projectStorePath(), { readonly: true });
		try {
			const errors = db
				.prepare(
					"SELECT data FROM events WHERE session_id = ? AND type = 'turn.error'",
				)
				.all(sessionId);
			expect(errors).toHaveLength(1);
			expect(errors[0]).toMatchObject({
				data: expect.stringContaining("Workspace relocation refused"),
			});
			evidence["turnErrors"] = errors;
		} finally {
			db.close();
		}
	}, 90_000);
});
