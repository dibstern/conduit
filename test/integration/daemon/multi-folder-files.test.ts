import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	GetFileContent,
	GetFileList,
	GetFileTree,
	MoveSessionWorkspace,
	SaveProject,
} from "../../../src/lib/contracts/ws-rpc.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

// Failure modes: roots omitted or reordered; identical relative paths cross
// folders; traversal, symlinks or an unregistered root escape containment;
// workspace mappings are ignored; rootless callers change folder; duplicate
// labels cannot be distinguished; single-folder responses gain a root row.
describe("Multi-folder files through the built daemon", () => {
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
		await harness.restart();
		return { fixture: harness, socket: join(harness.configDir, "relay.sock") };
	}

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		evidence["errors"] =
			task.result?.errors?.map(({ message }) => message) ?? [];
		try {
			await fixture.dispose();
			expect(fixture.remainingRunnerPids()).toEqual([]);
		} finally {
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				`test-results/q5u6-13-${scenario}.json`,
				`${JSON.stringify(evidence, null, 2).replaceAll(fixture.root, "<root>")}\n`,
			);
			harness = undefined;
			vi.unstubAllEnvs();
		}
	});

	it("labels both folders, opens the second, refuses escapes and preserves rootless reads", async () => {
		const { fixture, socket } = await start("folders");
		const secondary = join(fixture.root, "library");
		mkdirSync(join(secondary, "nested"), { recursive: true });
		writeFileSync(join(fixture.projectDir, "shared.txt"), "primary content\n");
		writeFileSync(join(secondary, "shared.txt"), "secondary content\n");
		writeFileSync(
			join(secondary, "nested", "child.txt"),
			"second folder child\n",
		);
		symlinkSync(fixture.projectDir, join(secondary, "escape"), "dir");
		await sendRpcRequest(
			socket,
			new SaveProject({
				slug: "process-test",
				folders: [fixture.projectDir, secondary],
			}),
		);
		const sessionId = await (await fixture.connect()).createSession(
			"Two folders",
		);
		const scope = { projectSlug: "process-test", sessionId };
		await sendRpcRequest(socket, new GetFileList(scope));
		const tree = await sendRpcRequest(socket, new GetFileTree(scope));
		evidence["roots"] = tree.roots;
		expect(tree.roots).toEqual([
			{ root: fixture.projectDir, label: basename(fixture.projectDir) },
			{ root: secondary, label: "library" },
		]);
		expect(tree.entries).toContain("shared.txt");
		expect(tree.entries).not.toContain("nested/child.txt");
		const list = await sendRpcRequest(
			socket,
			new GetFileList({ ...scope, root: secondary, path: "nested" }),
		);
		expect(list).toMatchObject({
			root: secondary,
			entries: [{ name: "child.txt", type: "file" }],
		});
		const opened = await sendRpcRequest(
			socket,
			new GetFileContent({
				...scope,
				root: secondary,
				path: "nested/child.txt",
			}),
		);
		evidence["opened"] = opened;
		expect(opened).toMatchObject({
			root: secondary,
			path: "nested/child.txt",
			content: "second folder child\n",
		});
		for (const root of [fixture.projectDir, secondary]) {
			const response = await sendRpcRequest(
				socket,
				new GetFileContent({ ...scope, root, path: "shared.txt" }),
			);
			expect(response.content).toBe(
				root === secondary ? "secondary content\n" : "primary content\n",
			);
		}
		for (const path of [
			`../${basename(fixture.projectDir)}/shared.txt`,
			join(fixture.projectDir, "shared.txt"),
			"escape/shared.txt",
		]) {
			await expect(
				sendRpcRequest(
					socket,
					new GetFileContent({ ...scope, root: secondary, path }),
				),
			).rejects.toThrow(/outside.*folder/i);
		}
		for (const path of [`../${basename(fixture.projectDir)}`, "escape"]) {
			await expect(
				sendRpcRequest(
					socket,
					new GetFileList({ ...scope, root: secondary, path }),
				),
			).rejects.toThrow(/outside.*folder/i);
		}
		await expect(
			sendRpcRequest(
				socket,
				new GetFileContent({
					...scope,
					root: fixture.root,
					path: "project/shared.txt",
				}),
			),
		).rejects.toThrow(/Unknown file root/);
		await expect(
			sendRpcRequest(socket, new GetFileList({ ...scope, root: fixture.root })),
		).rejects.toThrow(/Unknown file root/);
		evidence["containment"] =
			"traversal, absolute escape, symlink escape and unknown roots refused";
		const rootless = await sendRpcRequest(
			socket,
			new GetFileContent({ ...scope, path: "shared.txt" }),
		);
		evidence["rootless"] = rootless;
		expect(rootless).toEqual({
			projectSlug: "process-test",
			path: "shared.txt",
			content: "primary content\n",
		});
		expect(
			(await sendRpcRequest(socket, new GetFileList(scope))).entries.map(
				({ name }) => name,
			),
		).toContain("shared.txt");
		expect(
			(
				await sendRpcRequest(
					socket,
					new GetFileContent({
						projectSlug: "process-test",
						root: secondary,
						path: "shared.txt",
					}),
				)
			).content,
		).toBe("secondary content\n");
	});

	it("keeps primary first and maps each root through the session workspace, including after restart", async () => {
		const { fixture, socket } = await start("workspace");
		const secondary = join(fixture.root, "library");
		mkdirSync(secondary);
		const git = (directory: string, ...args: string[]) =>
			execFileSync("git", ["-C", directory, ...args], { stdio: "pipe" });
		for (const directory of [fixture.projectDir, secondary]) {
			git(directory, "init", "-b", "main");
			git(
				directory,
				"-c",
				"user.name=File tree test",
				"-c",
				"user.email=files@example.test",
				"-c",
				"core.hooksPath=/dev/null",
				"commit",
				"--allow-empty",
				"-m",
				"Initial commit",
			);
			writeFileSync(join(directory, "shared.txt"), "main checkout\n");
		}
		const primaryWorktree = join(fixture.root, "primary-worktree");
		const secondaryWorktree = join(fixture.root, "secondary-worktree");
		git(
			fixture.projectDir,
			"worktree",
			"add",
			"-b",
			"feature/files",
			primaryWorktree,
		);
		git(secondary, "worktree", "add", "-b", "feature/files", secondaryWorktree);
		writeFileSync(join(primaryWorktree, "shared.txt"), "primary worktree\n");
		writeFileSync(
			join(secondaryWorktree, "shared.txt"),
			"secondary worktree\n",
		);
		await sendRpcRequest(
			socket,
			new SaveProject({
				slug: "process-test",
				folders: [fixture.projectDir, secondary],
			}),
		);
		const sessionId = await (await fixture.connect()).createSession(
			"Mapped folders",
		);
		const scope = { projectSlug: "process-test", sessionId };
		await sendRpcRequest(
			socket,
			new MoveSessionWorkspace({ ...scope, path: secondaryWorktree }),
		);
		const roots = [
			{ root: fixture.projectDir, label: basename(fixture.projectDir) },
			{ root: secondary, label: "library" },
		];
		const secondaryTree = await sendRpcRequest(socket, new GetFileTree(scope));
		const secondaryOpened = await sendRpcRequest(
			socket,
			new GetFileContent({ ...scope, root: secondary, path: "shared.txt" }),
		);
		expect(secondaryTree.roots).toEqual(roots);
		expect(secondaryOpened.content).toBe("secondary worktree\n");
		evidence["secondaryWorkspace"] = {
			roots: secondaryTree.roots,
			opened: secondaryOpened,
		};
		expect(
			(
				await sendRpcRequest(
					socket,
					new GetFileContent({ ...scope, path: "shared.txt" }),
				)
			).content,
		).toBe("secondary worktree\n");
		expect(
			(
				await sendRpcRequest(
					socket,
					new GetFileContent({
						...scope,
						root: fixture.projectDir,
						path: "shared.txt",
					}),
				)
			).content,
		).toBe("main checkout\n");
		await sendRpcRequest(
			socket,
			new MoveSessionWorkspace({ ...scope, path: primaryWorktree }),
		);
		for (const restarted of [false, true]) {
			if (restarted) {
				await fixture.kill();
				await fixture.restart();
			}
			const tree = await sendRpcRequest(socket, new GetFileTree(scope));
			const opened = await sendRpcRequest(
				socket,
				new GetFileContent({
					...scope,
					root: fixture.projectDir,
					path: "shared.txt",
				}),
			);
			expect(tree.roots).toEqual(roots);
			expect(opened.content).toBe("primary worktree\n");
			expect(
				(
					await sendRpcRequest(
						socket,
						new GetFileContent({
							...scope,
							root: secondary,
							path: "shared.txt",
						}),
					)
				).content,
			).toBe("main checkout\n");
			expect(
				(
					await sendRpcRequest(
						socket,
						new GetFileContent({ ...scope, path: "shared.txt" }),
					)
				).content,
			).toBe("primary worktree\n");
			evidence[restarted ? "restarted" : "moved"] = {
				roots: tree.roots,
				opened,
			};
		}
	});

	it("disambiguates colliding folder names only", async () => {
		const { fixture, socket } = await start("labels");
		const first = join(fixture.root, "first", "src");
		const second = join(fixture.root, "second", "src");
		for (const folder of [first, second])
			mkdirSync(folder, { recursive: true });
		await sendRpcRequest(
			socket,
			new SaveProject({ slug: "process-test", folders: [first, second] }),
		);
		const tree = await sendRpcRequest(
			socket,
			new GetFileTree({ projectSlug: "process-test" }),
		);
		expect(tree.roots).toEqual([
			{ root: first, label: first },
			{ root: second, label: second },
		]);
		evidence["roots"] = tree.roots;
	});

	it("keeps the single-folder response and rootless content unchanged", async () => {
		const { fixture, socket } = await start("single-folder");
		writeFileSync(join(fixture.projectDir, "only.txt"), "single folder\n");
		const browser = await fixture.connect();
		const sessionId = await browser.createSession("Single folder");
		const scope = { projectSlug: "process-test", sessionId };
		// Start the lazy file provider before requesting the background tree.
		await sendRpcRequest(socket, new GetFileList(scope));
		const tree = await sendRpcRequest(socket, new GetFileTree(scope));
		expect(tree).toEqual({
			projectSlug: "process-test",
			entries: ["only.txt"],
		});
		const opened = await sendRpcRequest(
			socket,
			new GetFileContent({ ...scope, path: "only.txt" }),
		);
		expect(opened).toEqual({
			projectSlug: "process-test",
			path: "only.txt",
			content: "single folder\n",
		});
		evidence["tree"] = tree;
		evidence["opened"] = opened;
	});
});
