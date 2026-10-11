/*
 * Failure cases written before implementing session-mode defaults:
 * - An unset default must resolve to Local rather than an undefined mode.
 * - Global, file and daemon project settings must each win at their own level.
 * - Lower levels must not replace an explicit Local or New worktree override.
 * - Invalid JSON and invalid schema data must fall back with a visible warning,
 *   including when a daemon project override still supplies the mode.
 * - A project save without the setting must preserve it; null must clear it.
 * - Project and global settings must survive daemon restart.
 * - File edits and a primary-folder change must apply on the next resolve.
 * - A global edit must reach another project and a subsequent draft resolve.
 * - Unknown project-file keys must be ignored.
 * Browser-only failure cases are covered by session-mode-default.spec.ts:
 * no Git folder/provider capability, a user's earlier choice, project switches,
 * and a global change applying to the next draft.
 */
import {
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionMode } from "../../../src/lib/contracts/project-file.js";
import {
	GetProjects,
	ResolveSessionMode,
	type ResolveSessionModeResponse,
	SaveProject,
	SetDefaultSessionMode,
} from "../../../src/lib/contracts/ws-rpc.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

describe("Session-mode defaults through the built daemon", () => {
	let harness: ProcessHarness | undefined;
	let scenario = "setup";
	let cases: Array<{ name: string } & ResolveSessionModeResponse> = [];

	async function start(name: string) {
		scenario = name;
		cases = [];
		harness = ProcessHarness.create();
		const fixture = harness;
		await fixture.restart({ startupTimeoutMs: 120_000 });
		const socket = join(fixture.configDir, "relay.sock");
		const resolve = async (name: string, projectSlug = "process-test") => {
			const result = await sendRpcRequest(
				socket,
				new ResolveSessionMode({ projectSlug }),
			);
			cases.push({ name, ...result });
			return result;
		};
		const save = (sessionMode?: SessionMode | null) =>
			sendRpcRequest(
				socket,
				new SaveProject({
					slug: "process-test",
					folders: [fixture.projectDir],
					...(sessionMode !== undefined && { sessionMode }),
				}),
			);
		const global = (mode: SessionMode) =>
			sendRpcRequest(
				socket,
				new SetDefaultSessionMode({ projectSlug: "process-test", mode }),
			);
		return { fixture, socket, resolve, save, global };
	}

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		const root = realpathSync(fixture.root);
		const evidence: Record<string, unknown> = {
			cases: cases
				.map(({ warning, ...item }) => ({ ...item, warning: warning ?? null }))
				.sort((a, b) => a.name.localeCompare(b.name)),
			result: task.result?.state,
			errors: task.result?.errors?.map(({ message }) => message) ?? [],
		};
		if (task.result?.errors?.length)
			evidence["diagnosticLogs"] = fixture.logTail.slice(-4_000);
		try {
			await fixture.dispose();
			expect(fixture.remainingRunnerPids()).toEqual([]);
			evidence["cleanup"] = "no fixture runners remain";
		} finally {
			const manifest = JSON.stringify(
				evidence,
				(_key, value: unknown) =>
					value !== null && typeof value === "object" && !Array.isArray(value)
						? Object.fromEntries(
								Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
							)
						: value,
				2,
			)
				.replaceAll(root, "<root>")
				.replaceAll(fixture.root, "<root>");
			mkdirSync("test-results", { recursive: true });
			writeFileSync(`test-results/q5u6-7-${scenario}.json`, `${manifest}\n`);
			harness = undefined;
		}
	});

	it("uses Local when unset and persists the global default across projects and restart", async () => {
		const { fixture, socket, resolve, global } = await start("global");
		expect(await resolve("never-set")).toEqual({
			mode: "local",
			source: "global",
		});
		expect(await global("worktree")).toEqual({ mode: "worktree" });
		expect(await resolve("global-worktree")).toEqual({
			mode: "worktree",
			source: "global",
		});
		const second = join(fixture.root, "second");
		mkdirSync(second);
		const added = await sendRpcRequest(
			socket,
			new SaveProject({ title: "Second", folders: [second] }),
		);
		expect(await resolve("another-project", added.savedSlug)).toEqual({
			mode: "worktree",
			source: "global",
		});
		await fixture.shutdown();
		await fixture.restart({ startupTimeoutMs: 120_000 });
		expect(await resolve("after-restart")).toEqual({
			mode: "worktree",
			source: "global",
		});
		await global("local");
		expect(await resolve("next-draft", added.savedSlug)).toEqual({
			mode: "local",
			source: "global",
		});
	});

	it("uses the checked-in file over global and reads edits afresh", async () => {
		const { fixture, resolve, global } = await start("file");
		await global("worktree");
		const file = join(fixture.projectDir, "conduit.json");
		writeFileSync(file, '{"sessionMode":"local","unknown":true}');
		expect(await resolve("file-local")).toEqual({
			mode: "local",
			source: "file",
		});
		await global("local");
		writeFileSync(file, '{"sessionMode":"worktree"}');
		expect(await resolve("edited-file-worktree")).toEqual({
			mode: "worktree",
			source: "file",
		});
		writeFileSync(file, '{"setupScript":"echo ready"}');
		expect(await resolve("file-without-mode")).toEqual({
			mode: "local",
			source: "global",
		});
		rmSync(file);
		expect(await resolve("removed-file")).toEqual({
			mode: "local",
			source: "global",
		});
	});

	it("preserves and persists project overrides, then clears to the checked-in file", async () => {
		const { fixture, socket, resolve, save, global } = await start("project");
		await global("local");
		writeFileSync(
			join(fixture.projectDir, "conduit.json"),
			'{"sessionMode":"local"}',
		);
		const saved = await save("worktree");
		expect(
			saved.projects.find(({ slug }) => slug === "process-test")?.sessionMode,
		).toBe("worktree");
		expect(await resolve("project-worktree")).toEqual({
			mode: "worktree",
			source: "project",
		});
		await save();
		expect(await resolve("omitted-preserves")).toEqual({
			mode: "worktree",
			source: "project",
		});
		await fixture.shutdown();
		await fixture.restart({ startupTimeoutMs: 120_000 });
		expect(await resolve("after-restart")).toEqual({
			mode: "worktree",
			source: "project",
		});
		const persisted = JSON.parse(
			readFileSync(join(fixture.configDir, "daemon.json"), "utf8"),
		) as {
			projects: Array<{ slug: string; sessionMode?: SessionMode }>;
		};
		expect(
			persisted.projects.find(({ slug }) => slug === "process-test")
				?.sessionMode,
		).toBe("worktree");
		await global("worktree");
		writeFileSync(
			join(fixture.projectDir, "conduit.json"),
			'{"sessionMode":"worktree"}',
		);
		await save("local");
		expect(await resolve("project-local")).toEqual({
			mode: "local",
			source: "project",
		});
		await save(null);
		expect(await resolve("cleared-to-file")).toEqual({
			mode: "worktree",
			source: "file",
		});
		await fixture.shutdown();
		await fixture.restart({ startupTimeoutMs: 120_000 });
		const projects = (await sendRpcRequest(socket, new GetProjects({})))
			.projects;
		expect(
			projects.find(({ slug }) => slug === "process-test")?.sessionMode,
		).toBeUndefined();
		expect(await resolve("clear-survives-restart")).toEqual({
			mode: "worktree",
			source: "file",
		});
	});

	it.each([
		["invalid-json", "{broken"],
		["invalid-schema", '{"sessionMode":"sometimes"}'],
	])("ignores %s with a warning, including beneath a project override", async (name, contents) => {
		const { fixture, resolve, save, global } = await start(name);
		await global("worktree");
		writeFileSync(join(fixture.projectDir, "conduit.json"), contents);
		expect(await resolve("invalid-global-fallback")).toEqual({
			mode: "worktree",
			source: "global",
			warning: expect.stringContaining("Invalid conduit.json"),
		});
		await save("local");
		expect(await resolve("invalid-project-override")).toEqual({
			mode: "local",
			source: "project",
			warning: expect.stringContaining("Invalid conduit.json"),
		});
	});

	it("reads the current primary Project Folder and ignores the previous folder's file", async () => {
		const { fixture, socket, resolve } = await start("primary-folder");
		const second = join(fixture.root, "second");
		mkdirSync(second);
		writeFileSync(
			join(fixture.projectDir, "conduit.json"),
			'{"sessionMode":"worktree"}',
		);
		writeFileSync(join(second, "conduit.json"), '{"sessionMode":"local"}');
		await sendRpcRequest(
			socket,
			new SaveProject({
				slug: "process-test",
				folders: [fixture.projectDir, second],
			}),
		);
		expect(await resolve("first-primary")).toEqual({
			mode: "worktree",
			source: "file",
		});
		await sendRpcRequest(
			socket,
			new SaveProject({
				slug: "process-test",
				folders: [second, fixture.projectDir],
			}),
		);
		expect(await resolve("second-primary")).toEqual({
			mode: "local",
			source: "file",
		});
	});
});
