import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CreatePty,
	CreatePtyForSession,
	MoveSessionWorkspace,
	SaveProject,
} from "../../../src/lib/contracts/ws-rpc.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import {
	type ProcessBrowser,
	ProcessHarness,
	ptyEnvelope,
} from "../../helpers/process-harness.js";

// Failure modes: a selected root is ignored; rootless creates change cwd;
// unknown roots spawn shells; worktree paths are accepted as project roots;
// selected folders bypass the session workspace; sessionless creates regress.
async function terminalCwd(browser: ProcessBrowser, ptyId: string) {
	const cursor = browser.frames.length;
	let output = "";
	// Split the marker so echoed input cannot satisfy the assertion.
	await browser.inputPty(
		ptyId,
		"printf '__FOLDER%s__%s\\n' _CWD \"$(pwd -P)\"\r",
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
		return /__FOLDER_CWD__([^\r\n]+)\r?\n/.test(output);
	}, cursor);
	return /__FOLDER_CWD__([^\r\n]+)/.exec(output)?.[1];
}

describe("Multi-folder terminals through the built daemon", () => {
	let harness: ProcessHarness | undefined;
	let scenario = "setup";
	let evidence: Record<string, unknown> = {};

	async function start(name: string, worktrees = false) {
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
		const fixture = harness;
		const secondary = join(fixture.root, "library");
		mkdirSync(secondary);
		const mapped = [
			join(fixture.root, "primary-worktree"),
			join(fixture.root, "secondary-worktree"),
		] as const;
		if (worktrees) {
			for (const [directory, worktree] of [
				[fixture.projectDir, mapped[0]],
				[secondary, mapped[1]],
			] as const) {
				const git = (...args: string[]) =>
					execFileSync("git", ["-C", directory, ...args], { stdio: "pipe" });
				git("init", "-b", "main");
				git(
					"-c",
					"user.name=Terminal test",
					"-c",
					"user.email=terminals@example.test",
					"-c",
					"core.hooksPath=/dev/null",
					"commit",
					"--allow-empty",
					"-m",
					"Initial commit",
				);
				git("worktree", "add", "-b", "feature/terminals", worktree);
			}
		}
		await fixture.restart({ startupTimeoutMs: 25_000 });
		const socket = join(fixture.configDir, "relay.sock");
		await sendRpcRequest(
			socket,
			new SaveProject({
				slug: "process-test",
				folders: [fixture.projectDir, secondary],
			}),
		);
		const browser = await fixture.connect();
		const sessionId = await browser.createSession("Two terminal folders");
		const scope = { projectSlug: "process-test", sessionId };
		async function create(root?: string, scoped = true) {
			const cursor = browser.frames.length;
			await sendRpcRequest(
				socket,
				scoped
					? new CreatePtyForSession({
							sessionId,
							originId: browser.originId,
							...(root === undefined ? {} : { root }),
						})
					: new CreatePty({
							projectSlug: scope.projectSlug,
							originId: browser.originId,
							...(root === undefined ? {} : { root }),
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
		return { fixture, socket, browser, scope, secondary, mapped, create };
	}

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		const realRoot = realpathSync(fixture.root);
		evidence["errors"] =
			task.result?.errors?.map(({ message }) => message) ?? [];
		try {
			await fixture.dispose();
			expect(fixture.remainingRunnerPids()).toEqual([]);
		} finally {
			mkdirSync("test-results", { recursive: true });
			const normalized = JSON.stringify(evidence, null, 2)
				.replaceAll(realRoot, "<root>")
				.replaceAll(fixture.root, "<root>");
			writeFileSync(`test-results/q5u6-14-${scenario}.json`, `${normalized}\n`);
			harness = undefined;
			vi.unstubAllEnvs();
		}
	});

	it("starts in the selected second folder, preserves the default and refuses unknown roots", async () => {
		const { fixture, socket, browser, scope, secondary, create } =
			await start("folders");
		const selected = await create(secondary);
		evidence["selectedCwd"] = await terminalCwd(browser, selected.id);
		expect(evidence["selectedCwd"]).toBe(realpathSync(secondary));
		const defaultTerminal = await create();
		evidence["defaultCwd"] = await terminalCwd(browser, defaultTerminal.id);
		expect(evidence["defaultCwd"]).toBe(realpathSync(fixture.projectDir));
		await expect(
			sendRpcRequest(
				socket,
				new CreatePtyForSession({
					...scope,
					originId: browser.originId,
					root: fixture.root,
				}),
			),
		).rejects.toThrow(/Unknown terminal root/);
		expect((await browser.listPtys()).map(({ id }) => id).sort()).toEqual(
			[selected.id, defaultTerminal.id].sort(),
		);
		evidence["unknownRoot"] = "refused without creating a terminal";
	});

	it("maps selected roots through the workspace while rootless and sessionless creates keep their defaults", async () => {
		const { fixture, socket, browser, scope, secondary, mapped, create } =
			await start("workspace", true);
		await sendRpcRequest(
			socket,
			new MoveSessionWorkspace({ ...scope, path: mapped[1] }),
		);
		const selected = await create(secondary);
		evidence["selectedCwd"] = await terminalCwd(browser, selected.id);
		expect(evidence["selectedCwd"]).toBe(realpathSync(mapped[1]));
		const defaultTerminal = await create();
		evidence["defaultCwd"] = await terminalCwd(browser, defaultTerminal.id);
		expect(evidence["defaultCwd"]).toBe(realpathSync(mapped[1]));
		const primaryTerminal = await create(fixture.projectDir);
		evidence["primaryCwd"] = await terminalCwd(browser, primaryTerminal.id);
		expect(evidence["primaryCwd"]).toBe(realpathSync(fixture.projectDir));
		await sendRpcRequest(
			socket,
			new MoveSessionWorkspace({ ...scope, path: mapped[0] }),
		);
		const primaryDefault = await create();
		evidence["primaryDefaultCwd"] = await terminalCwd(
			browser,
			primaryDefault.id,
		);
		expect(evidence["primaryDefaultCwd"]).toBe(realpathSync(mapped[0]));
		const sharedSecondary = await create(secondary);
		evidence["sharedSecondaryCwd"] = await terminalCwd(
			browser,
			sharedSecondary.id,
		);
		expect(evidence["sharedSecondaryCwd"]).toBe(realpathSync(secondary));
		const projectTerminal = await create(undefined, false);
		evidence["sessionlessCwd"] = await terminalCwd(browser, projectTerminal.id);
		expect(evidence["sessionlessCwd"]).toBe(realpathSync(fixture.projectDir));
		await expect(
			sendRpcRequest(
				socket,
				new CreatePtyForSession({
					...scope,
					originId: browser.originId,
					root: mapped[1],
				}),
			),
		).rejects.toThrow(/Unknown terminal root/);
		evidence["worktreeRoot"] =
			"refused: selection uses the Project Folder path";
	});
});
