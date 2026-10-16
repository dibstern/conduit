import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CreatePty,
	CreatePtyForSession,
	GetFileContent,
	GetFileContentForSession,
	GetFileList,
	GetFileListForSession,
	GetFileTree,
	GetFileTreeForSession,
	MoveSessionWorkspace,
} from "../../../src/lib/contracts/ws-rpc.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import type { PtyInfo } from "../../../src/lib/shared-types.js";
import {
	PtyHostRequestSchema,
	ptyHostSocketPath,
	readPtyFrames,
} from "../../../src/lib/terminal/pty-host-protocol.js";
import {
	type ProcessBrowser,
	ProcessHarness,
	ptyEnvelope,
} from "../../helpers/process-harness.js";

const gitEnv = { ...process.env };
for (const key of [
	"GIT_DIR",
	"GIT_INDEX_FILE",
	"GIT_WORK_TREE",
	"GIT_COMMON_DIR",
])
	delete gitEnv[key];

function git(directory: string, ...args: string[]) {
	execFileSync("git", ["-C", directory, ...args], {
		env: gitEnv,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

async function terminalCwd(browser: ProcessBrowser, ptyId: string) {
	const cursor = browser.frames.length;
	let output = "";
	// Split the marker so echoed input cannot satisfy the assertion.
	await browser.inputPty(
		ptyId,
		"printf '__WORK%s__%s\\n' SPACE_CWD \"$(pwd -P)\"\r",
	);
	await browser.waitFor(() => {
		output = browser.frames
			.slice(cursor)
			.flatMap(({ message }) => {
				const envelope = ptyEnvelope(message);
				return envelope?._tag === "output" && envelope.ptyId === ptyId
					? [envelope.data]
					: [];
			})
			.join("");
		return /__WORKSPACE_CWD__([^\r\n]+)\r?\n/.test(output);
	}, cursor);
	return /__WORKSPACE_CWD__([^\r\n]+)/.exec(output)?.[1];
}

describe("Session workspace files and terminals through the built daemon", () => {
	let harness: ProcessHarness | undefined;
	let scenario = "setup";
	let evidence: Record<string, unknown> = {};

	async function start(name: string) {
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
			managedOpenCode: true,
			claudeReplay: { turns: ["pong-thinking-text-turn"], delayMs: 0 },
		});
		git(harness.projectDir, "init", "-b", "main");
		git(
			harness.projectDir,
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
		const worktree = join(harness.root, "worktree");
		git(
			harness.projectDir,
			"worktree",
			"add",
			"-b",
			"feature/workspace",
			worktree,
		);
		writeFileSync(join(harness.projectDir, "main-only.txt"), "main\n");
		writeFileSync(join(harness.projectDir, "shared.txt"), "main content\n");
		writeFileSync(join(worktree, "worktree-only.txt"), "worktree\n");
		writeFileSync(join(worktree, "shared.txt"), "worktree content\n");
		mkdirSync(join(worktree, "nested"));
		writeFileSync(join(worktree, "nested", "child.txt"), "child\n");
		writeFileSync(join(worktree, ".gitignore"), "ignored.txt\n");
		writeFileSync(join(worktree, "ignored.txt"), "hidden\n");
		await harness.restart();
		const socket = join(harness.configDir, "relay.sock");
		const browser = await harness.connect();
		const unmoved = await browser.createSession("Main folder");
		const moved = await browser.createSession("Worktree folder");
		return {
			fixture: harness,
			browser,
			unmoved,
			moved,
			main: realpathSync(harness.projectDir),
			worktree: realpathSync(worktree),
			move: () =>
				sendRpcRequest(
					socket,
					new MoveSessionWorkspace({
						sessionId: moved,
						path: worktree,
					}),
				),
		};
	}

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		evidence["errors"] =
			task.result?.errors?.map(({ message }) => message) ?? [];
		if (task.result?.errors?.length) evidence["logs"] = fixture.logTail;
		try {
			await fixture.dispose();
			expect(fixture.remainingRunnerPids()).toEqual([]);
		} finally {
			mkdirSync("test-results", { recursive: true });
			const normalized = JSON.stringify(evidence, null, 2)
				.replaceAll(fixture.root.replace(/^\/tmp\//, "/private/tmp/"), "<root>")
				.replaceAll(fixture.root, "<root>");
			writeFileSync(
				`test-results/q5u6-1-3-${scenario}.json`,
				`${normalized}\n`,
			);
			harness = undefined;
			vi.unstubAllEnvs();
		}
	});

	it("opens new terminals in the session workspace and preserves open terminals through a move and restart", async () => {
		const { fixture, browser, moved, unmoved, main, worktree, move } =
			await start("terminals");
		async function create(sessionId?: string): Promise<PtyInfo> {
			const cursor = browser.frames.length;
			await sendRpcRequest(
				join(fixture.configDir, "relay.sock"),
				sessionId
					? new CreatePtyForSession({ sessionId, originId: browser.originId })
					: new CreatePty({
							projectSlug: "process-test",
							originId: browser.originId,
						}),
			);
			const frame = await browser.waitFor(
				(message) => ptyEnvelope(message)?._tag === "upsert",
				cursor,
			);
			const envelope = ptyEnvelope(frame);
			if (envelope?._tag !== "upsert") throw new Error("Missing terminal");
			return envelope.item;
		}
		const existing = await create(moved);
		expect(await terminalCwd(browser, existing.id)).toBe(main);
		await move();
		const next = await create(moved);
		evidence["newTerminalCwd"] = await terminalCwd(browser, next.id);
		expect(evidence["newTerminalCwd"]).toBe(worktree);
		expect(next.cwd).toBe(worktree);
		evidence["existingTerminalCwd"] = await terminalCwd(browser, existing.id);
		expect(evidence["existingTerminalCwd"]).toBe(main);
		const legacy = await create(unmoved);
		expect(await terminalCwd(browser, legacy.id)).toBe(main);
		// No session must mean the primary folder even while viewing a moved one.
		const unscoped = await create();
		expect(await terminalCwd(browser, unscoped.id)).toBe(main);
		evidence["terminalCwds"] = (await browser.listPtys())
			.map(({ cwd }) => cwd)
			.sort();
		expect(evidence["terminalCwds"]).toEqual(
			[main, main, main, worktree].sort(),
		);
		await fixture.kill();
		await fixture.restart();
		const restored = await fixture.connect();
		expect((await restored.listPtys()).map(({ id }) => id).sort()).toEqual(
			[existing.id, next.id, legacy.id, unscoped.id].sort(),
		);
		evidence["restoredWorktreeCwd"] = await terminalCwd(restored, next.id);
		expect(evidence["restoredWorktreeCwd"]).toBe(worktree);
		evidence["restoredExistingCwd"] = await terminalCwd(restored, existing.id);
		expect(evidence["restoredExistingCwd"]).toBe(main);
	});

	it("lists and reads the moved workspace, keeping unmoved and sessionless requests in the main folder", async () => {
		const { fixture, moved, unmoved, move } = await start("files");
		await move();
		const socket = join(fixture.configDir, "relay.sock");
		const scopes = [
			{ name: "moved", sessionId: moved },
			{ name: "unmoved", sessionId: unmoved },
			{ name: "sessionless", sessionId: undefined },
		];
		for (const { name, sessionId } of scopes) {
			const list = await sendRpcRequest(
				socket,
				sessionId
					? new GetFileListForSession({ sessionId })
					: new GetFileList({ projectSlug: "process-test" }),
			);
			// The background tree intentionally does not start a stopped file provider.
			const tree = await sendRpcRequest(
				socket,
				sessionId
					? new GetFileTreeForSession({ sessionId })
					: new GetFileTree({ projectSlug: "process-test" }),
			);
			const content = await sendRpcRequest(
				socket,
				sessionId
					? new GetFileContentForSession({ sessionId, path: "shared.txt" })
					: new GetFileContent({
							projectSlug: "process-test",
							path: "shared.txt",
						}),
			);
			const paths = [...tree.entries].sort();
			const names = list.entries.map(({ name }) => name).sort();
			evidence[name] = { tree: paths, list: names, content: content.content };
			if (name === "moved") {
				expect(paths).toEqual([
					".gitignore",
					"nested/",
					"nested/child.txt",
					"shared.txt",
					"worktree-only.txt",
				]);
				expect(names).toEqual([
					".gitignore",
					"nested",
					"shared.txt",
					"worktree-only.txt",
				]);
				expect(content.content).toBe("worktree content\n");
				const nested = await sendRpcRequest(
					socket,
					sessionId
						? new GetFileListForSession({ sessionId, path: "nested" })
						: new GetFileList({ projectSlug: "process-test", path: "nested" }),
				);
				expect(nested.entries.map(({ name }) => name)).toEqual(["child.txt"]);
			} else {
				expect(paths).toEqual(["main-only.txt", "shared.txt"]);
				expect(names).toEqual(["main-only.txt", "shared.txt"]);
				expect(content.content).toBe("main content\n");
			}
		}
	});

	it("refuses a worktree terminal on a legacy host without spawning a shell or stopping that host", async () => {
		const { fixture, browser, moved, move } = await start("legacy-host");
		await move();
		const sockets = new Set<Socket>();
		let creates = 0;
		let stops = 0;
		const server = createServer((socket) => {
			sockets.add(socket);
			readPtyFrames(
				socket,
				Schema.decodeUnknownSync(PtyHostRequestSchema),
				(message) => {
					if (message.type === "hello")
						socket.write(
							`${JSON.stringify({ type: "hello", protocolVersion: 1, buildId: "legacy-host", pid: process.pid, openTerminals: 1 })}\n`,
						);
					else if (message.type === "create") {
						creates++;
						socket.write(
							`${JSON.stringify({ type: "error", requestId: message.requestId, message: "Legacy create received" })}\n`,
						);
					} else if (message.type === "list")
						socket.write(
							`${JSON.stringify({ type: "list", requestId: message.requestId, terminals: [] })}\n`,
						);
					else if (message.type === "stop") {
						stops++;
						socket.write(
							`${JSON.stringify({ type: "stopped", requestId: message.requestId, stopped: false })}\n`,
						);
					}
				},
				() => socket.destroy(),
			);
		});
		const hostSocket = ptyHostSocketPath(fixture.configDir);
		await new Promise<void>((done, fail) => {
			server.once("error", fail);
			server.listen(hostSocket, done);
		});
		try {
			await expect(
				sendRpcRequest(
					join(fixture.configDir, "relay.sock"),
					new CreatePtyForSession({
						originId: browser.originId,
						sessionId: moved,
					}),
				),
			).rejects.toThrow(/running PTY host predates session workspaces/);
			expect(creates).toBe(0);
			expect(stops).toBe(0);
			expect([...sockets].some((socket) => !socket.destroyed)).toBe(true);
			evidence = { creates, stops, existingHostRetained: true };
		} finally {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((done) => server.close(() => done()));
			try {
				unlinkSync(hostSocket);
			} catch {
				/* The server removes its socket on close. */
			}
		}
	});
});
