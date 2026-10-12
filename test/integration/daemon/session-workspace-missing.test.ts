import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Either, Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ListDaemonSessions,
	MoveSessionWorkspace,
	OpenCodeUseWorktree,
	SubmitInput,
} from "../../../src/lib/contracts/ws-rpc.js";
import { loadDaemonConfigResult } from "../../../src/lib/daemon/config-persistence.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import { createSdkClient } from "../../../src/lib/instance/sdk-factory.js";
import { SessionInfoSchema } from "../../../src/lib/shared-types.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

// Failure modes: fallback outside turn start or for another origin; losing the
// missing cause on the browser row; computing the directive before the move;
// repeating it after acknowledgement; recording a move when main is missing.
// OpenCode ignores a request directory for an existing native session, so the
// fallback must also move that session before prompting it.
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

function events(fixture: ProcessHarness, sessionId?: string) {
	const db = new Database(fixture.projectStorePath(), { readonly: true });
	try {
		const rows = db
			.prepare(
				"SELECT sequence, session_id, type, data FROM events WHERE (? IS NULL OR session_id = ?) AND type IN ('session.workspace_changed', 'session.workspace_started', 'input.sent', 'turn.error') ORDER BY sequence",
			)
			.all(sessionId ?? null, sessionId ?? null) as {
			sequence: number;
			session_id: string;
			type: string;
			data: string;
		}[];
		return rows.map(({ data, ...row }) => ({
			...row,
			data: JSON.parse(data) as Record<string, unknown>,
		}));
	} finally {
		db.close();
	}
}

function shellRows(
	browser: Awaited<ReturnType<ProcessHarness["connect"]>>,
	sessionId: string,
	cursor = 0,
) {
	return browser.frames.slice(cursor).flatMap(({ message }) => {
		if (message["type"] !== "shell" || message["_tag"] !== "upsert") return [];
		const row = Schema.decodeUnknownSync(SessionInfoSchema)(message["item"]);
		return row.id === sessionId ? [row] : [];
	});
}

describe("Missing session worktrees through the built daemon", () => {
	let harness: ProcessHarness | undefined;
	let scenario = "setup";
	let evidence: Record<string, unknown> = {};

	async function start(
		name: string,
		options: Parameters<typeof ProcessHarness.create>[0] = {},
	) {
		scenario = name;
		evidence = {};
		for (const key of [
			"GIT_DIR",
			"GIT_INDEX_FILE",
			"GIT_WORK_TREE",
			"GIT_COMMON_DIR",
		])
			vi.stubEnv(key, undefined);
		const fixture = ProcessHarness.create(options);
		harness = fixture;
		git(fixture.projectDir, "init", "-b", "main");
		git(
			fixture.projectDir,
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
		const worktree = join(
			fixture.projectDir,
			".claude",
			"worktrees",
			"contract",
		);
		git(
			fixture.projectDir,
			"worktree",
			"add",
			"-b",
			"feature/worktree",
			worktree,
		);
		await fixture.restart({ startupTimeoutMs: 30_000 });
		const socket = join(fixture.configDir, "relay.sock");
		return {
			fixture,
			main: realpathSync(fixture.projectDir),
			worktree: realpathSync(worktree),
			socket,
			list: () =>
				sendRpcRequest(
					socket,
					new ListDaemonSessions({
						projectSlug: "process-test",
						scope: "process-test",
					}),
				),
		};
	}

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		try {
			evidence["events"] = existsSync(fixture.projectStorePath())
				? events(fixture)
				: [];
			evidence["queries"] = fixture.claudeOptions();
			evidence["requests"] = fixture.opencodeRequests();
			evidence["errors"] =
				task.result?.errors?.map(({ message }) => message) ?? [];
			if (task.result?.errors?.length) evidence["logs"] = fixture.logTail;
		} finally {
			try {
				await fixture.dispose();
				fixture.assertNoRunners();
			} finally {
				mkdirSync("test-results", { recursive: true });
				writeFileSync(
					`test-results/q5u6-1-7-${scenario}.json`,
					`${JSON.stringify(evidence, null, 2).replaceAll(fixture.root, "<root>")}\n`,
				);
				harness = undefined;
				vi.unstubAllEnvs();
			}
		}
	});

	it.each([
		"claude",
		"opencode",
	] as const)("falls back once for %s and publishes the moved-back cause", async (provider) => {
		const { fixture, main, worktree, socket, list } = await start(
			`missing-${provider}`,
			{ managedOpenCode: provider === "opencode" },
		);
		const browser = await fixture.connect();
		const sessionId = await browser.createSession(
			"Removed worktree",
			provider === "opencode" ? "managed-test" : undefined,
			provider,
		);
		let native: OpenCodeAPI | undefined;
		if (provider === "claude") {
			await sendRpcRequest(
				socket,
				new MoveSessionWorkspace({
					projectSlug: "process-test",
					sessionId,
					path: worktree,
				}),
			);
			await browser.send(sessionId, "Before removal.");
			expect(
				fixture
					.claudeOptions()
					.filter(({ prompt }) => prompt !== undefined)
					.at(-1)?.options["cwd"],
			).toBe(worktree);
		} else {
			await sendRpcRequest(
				socket,
				new OpenCodeUseWorktree({
					instanceId: "managed-test",
					providerSessionId: sessionId,
					path: worktree,
				}),
			);
			const instance = Either.getOrThrowWith(
				loadDaemonConfigResult(fixture.configDir),
				(error) => error,
			)?.instances?.find(({ id }) => id === "managed-test");
			if (!instance?.port) throw new Error("Fake OpenCode instance is missing");
			const baseUrl = `http://127.0.0.1:${instance.port}`;
			const { client, authHeaders } = createSdkClient({
				baseUrl,
				auth: {
					username: instance.env?.["OPENCODE_SERVER_USERNAME"] ?? "opencode",
					password: instance.env?.["OPENCODE_SERVER_PASSWORD"] ?? "",
				},
			});
			native = new OpenCodeAPI({ sdk: client, baseUrl, authHeaders });
			const moved = await client.experimental.controlPlane.moveSession({
				sessionID: sessionId,
				destination: { directory: worktree },
				moveChanges: false,
			});
			expect(moved.error).toBeUndefined();
			expect((await native.session.get(sessionId)).directory).toBe(worktree);
		}
		git(main, "worktree", "remove", "--force", worktree);
		// Listing and speculative warming may observe the missing folder, but must not move it.
		await list();
		if (provider === "claude")
			await browser.preWarmSession(sessionId).catch(() => {});
		expect(
			events(fixture, sessionId).filter(
				({ data }) => data["cause"] === "missing",
			),
		).toEqual([]);
		const cursor = browser.frames.length;
		if (provider === "claude") {
			await browser.send(sessionId, "After removal.");
			expect(
				fixture
					.claudeOptions()
					.filter(({ prompt }) => prompt !== undefined)
					.at(-1),
			).toMatchObject({ prompt: "After removal.", options: { cwd: main } });
		} else {
			await sendRpcRequest(
				socket,
				new SubmitInput({
					projectSlug: "process-test",
					sessionId,
					inputId: randomUUID(),
					delivery: "queue",
					text: "After removal.",
				}),
			);
			await vi.waitFor(() => {
				const request = fixture
					.opencodeRequests()
					.filter(({ url }) =>
						url.startsWith(`/session/${sessionId}/prompt_async`),
					)
					.at(-1);
				const directory =
					request &&
					(new URL(request.url, "http://opencode.test").searchParams.get(
						"directory",
					) ??
						request.directory);
				expect(directory && decodeURIComponent(directory)).toBe(main);
			});
			expect((await native?.session.get(sessionId))?.directory).toBe(main);
			evidence["nativeSession"] = await native?.session.get(sessionId);
		}
		await vi.waitFor(() =>
			expect(shellRows(browser, sessionId, cursor)).toContainEqual(
				expect.objectContaining({
					workspace: { cause: "missing", origin: "existing", worktrees: {} },
				}),
			),
		);
		expect(
			events(fixture, sessionId).filter(
				({ data }) => data["cause"] === "missing",
			),
		).toHaveLength(1);
		const row = (await list()).sessions.find(({ id }) => id === sessionId);
		expect(row).toMatchObject({
			workspace: { cause: "missing", origin: "existing", worktrees: {} },
			git: { branch: "main" },
		});
		evidence["movedBackRows"] = shellRows(browser, sessionId, cursor);
		if (provider === "claude") {
			await browser.send(sessionId, "Still in main.");
			expect(
				events(fixture, sessionId).filter(
					({ data }) => data["cause"] === "missing",
				),
			).toHaveLength(1);
			const restored = join(fixture.root, "restored-worktree");
			git(main, "worktree", "add", "-b", "feature/restored", restored);
			await sendRpcRequest(
				socket,
				new MoveSessionWorkspace({
					projectSlug: "process-test",
					sessionId,
					path: restored,
				}),
			);
			await vi.waitFor(() =>
				expect(shellRows(browser, sessionId).at(-1)?.workspace?.cause).toBe(
					"user",
				),
			);
		}
	}, 60_000);

	it("records fallback before the sticky Claude directive and acknowledges ExitWorktree", async () => {
		const { fixture, main, worktree, list } = await start(
			"missing-sticky-claude",
			{
				claudeReplay: {
					turns: [
						"enter-worktree-turn",
						"exit-worktree-keep-turn",
						"pong-thinking-text-turn",
					],
					followWorkspaceDirectives: true,
				},
			},
		);
		const browser = await fixture.connect();
		const sessionId = await browser.createSession("Removed sticky worktree");
		await browser.send(sessionId, "Enter a worktree.");
		expect(
			(await list()).sessions.find(({ id }) => id === sessionId)?.workspace
				?.worktrees,
		).toEqual({ [main]: worktree });
		git(main, "worktree", "remove", "--force", worktree);
		const cursor = browser.frames.length;
		await browser.send(sessionId, "Continue after removal.");
		const directive =
			'[Conduit workspace move] Call ExitWorktree with action "keep" before continuing.';
		expect(
			fixture
				.claudeOptions()
				.filter(({ prompt }) => prompt !== undefined)
				.at(-1),
		).toMatchObject({
			prompt: `${directive}\nContinue after removal.`,
			options: { cwd: main },
		});
		const facts = events(fixture, sessionId);
		const fallback = facts.find(({ data }) => data["cause"] === "missing");
		expect(fallback?.data).toEqual({
			sessionId,
			path: main,
			cause: "missing",
			origin: "existing",
			worktrees: {},
		});
		const sent = facts.find(
			({ type, data }) =>
				type === "input.sent" &&
				data["workspaceMoveSequence"] === fallback?.sequence,
		);
		expect(sent?.sequence).toBeGreaterThan(fallback?.sequence ?? Infinity);
		await vi.waitFor(() =>
			expect(
				shellRows(browser, sessionId, cursor).some(
					({ workspace }) => workspace?.cause === "missing",
				),
			).toBe(true),
		);
		expect(
			facts.filter(({ type }) => type === "session.workspace_changed").at(-1)
				?.data["cause"],
		).toBe("agent");
		expect(
			(await list()).sessions.find(({ id }) => id === sessionId)
				?.workspaceMismatch,
		).toBeUndefined();
		expect(
			(await list()).sessions.find(({ id }) => id === sessionId)?.workspace ??
				null,
		).toBeNull();
		await browser.send(sessionId, "After acknowledgement.");
		expect(
			fixture
				.claudeOptions()
				.filter(({ prompt }) => prompt !== undefined)
				.at(-1)?.prompt,
		).toBe("After acknowledgement.");
		evidence["movedBackRows"] = shellRows(browser, sessionId, cursor);
	}, 60_000);

	it.each([
		["claude", false],
		["claude", true],
		["opencode", false],
		["opencode", true],
	] as const)(
		"keeps the missing-main error for %s with recordedWorktree=%s without recording a move",
		async (provider, recordedWorktree) => {
			const { fixture, main, worktree, socket } = await start(
				`missing-main-${provider}-${recordedWorktree}`,
				{
					managedOpenCode: provider === "opencode",
				},
			);
			const browser = await fixture.connect();
			const sessionId = await browser.createSession(
				"Missing main",
				provider === "opencode" ? "managed-test" : undefined,
				provider,
			);
			if (recordedWorktree)
				await sendRpcRequest(
					socket,
					provider === "claude"
						? new MoveSessionWorkspace({
								projectSlug: "process-test",
								sessionId,
								path: worktree,
							})
						: new OpenCodeUseWorktree({
								instanceId: "managed-test",
								providerSessionId: sessionId,
								path: worktree,
							}),
				);
			const before = events(fixture, sessionId).filter(
				({ type }) => type === "session.workspace_changed",
			);
			rmSync(main, { recursive: true, force: true });
			await browser.send(sessionId, "Cannot launch.");
			expect(
				events(fixture, sessionId)
					.filter(({ type }) => type === "turn.error")
					.at(-1)?.data["error"],
			).toBe(
				`Failed to send message: Main project folder does not exist: ${main}`,
			);
			expect(
				events(fixture, sessionId).filter(
					({ type }) => type === "session.workspace_changed",
				),
			).toEqual(before);
			expect(
				fixture.claudeOptions().filter(({ prompt }) => prompt !== undefined),
			).toEqual([]);
			expect(
				fixture
					.opencodeRequests()
					.filter(({ url }) => url.includes("/prompt_async")),
			).toEqual([]);
		},
		60_000,
	);

	it("reports a missing conduit workspace without automatically falling back", async () => {
		const { fixture, main, worktree, socket } = await start(
			"missing-conduit-origin",
		);
		const browser = await fixture.connect();
		const sessionId = await browser.createSession("Other origin");
		await sendRpcRequest(
			socket,
			new MoveSessionWorkspace({
				projectSlug: "process-test",
				sessionId,
				path: worktree,
			}),
		);
		// Seed conduit origin on an unowned path to pin fail-closed dispatch,
		// including recorded state that cannot be recreated by the owned service.
		const db = new Database(fixture.projectStorePath());
		try {
			db.prepare(
				"UPDATE sessions SET workspace = json_set(workspace, '$.origin', 'conduit') WHERE id = ?",
			).run(sessionId);
		} finally {
			db.close();
		}
		git(main, "worktree", "remove", "--force", worktree);
		await browser.send(sessionId, "Cannot silently fall back.");
		expect(
			events(fixture, sessionId)
				.filter(({ type }) => type === "turn.error")
				.at(-1)?.data,
		).toMatchObject({
			code: "WORKTREE_MISSING",
			error: `Worktree missing: ${worktree}. Recreate worktree or Continue in main folder before sending another message.`,
		});
		expect(
			events(fixture, sessionId).filter(
				({ data }) => data["cause"] === "missing",
			),
		).toEqual([]);
		expect(
			fixture.claudeOptions().filter(({ prompt }) => prompt !== undefined),
		).toEqual([]);
	}, 60_000);
});
