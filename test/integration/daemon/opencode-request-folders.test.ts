/*
 * Every OpenCode request names its session's folder, through one daemon client per instance (82tn.16, S3b).
 * Failure modes, written before the code (numbering from the lane 16f audit):
 * 7. A session in a Conduit worktree gets a request that names the project's folder instead of its own.
 * 8. Two projects on one instance: one project's session gets a request that names the other's folder.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
	AccountIdSchema,
	MANAGED_OPENCODE_ACCOUNT_ID,
} from "../../../src/lib/contracts/provider-instance.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

const gitEnv = { ...process.env };
for (const key of ["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE"])
	delete gitEnv[key];
const git = (directory: string, ...args: string[]) =>
	execFileSync("git", ["-C", directory, ...args], {
		env: gitEnv,
		stdio: ["ignore", "pipe", "pipe"],
	});

describe("82tn.16: OpenCode requests name the session's folder", () => {
	let harness: ProcessHarness | undefined;
	let evidence: Record<string, unknown> = {};
	let root = "";

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		try {
			await fixture.terminate();
			evidence["failures"] =
				task.result?.errors?.map(({ message }) => message) ?? [];
		} finally {
			try {
				await fixture.dispose();
				fixture.assertNoRunners();
			} finally {
				mkdirSync("test-results", { recursive: true });
				writeFileSync(
					"test-results/82tn-16-opencode-request-folders.json",
					`${JSON.stringify(evidence, null, 2).replaceAll(root, "<ROOT>")}\n`,
				);
				harness = undefined;
			}
		}
	});

	it("renames and deletes a worktree session in its worktree and another project's session in that project", async () => {
		evidence = { bead: "conduit-test-82tn.16", scenario: "rename-delete" };
		const fixture = ProcessHarness.create({
			dist: resolve(process.env["CONDUIT_TEST_DIST"] ?? "dist"),
			foregroundCli: true,
			autoStartOpenCode: true,
		});
		harness = fixture;
		root = realpathSync(fixture.root);
		git(fixture.projectDir, "init", "-b", "main");
		git(
			fixture.projectDir,
			"-c",
			"user.name=Conduit Test",
			"-c",
			"user.email=test@example.invalid",
			"commit",
			"--allow-empty",
			"-m",
			"init",
		);
		await fixture.restart();
		const projectB = `${fixture.root}/project-b`;
		mkdirSync(projectB, { recursive: true });
		const { savedSlug } = await fixture.requestRpc({
			_tag: "SaveProject",
			folders: [projectB],
		});
		const instanceId = AccountIdSchema.make(MANAGED_OPENCODE_ACCOUNT_ID);
		const create = (projectSlug: string, newWorktree: boolean) =>
			fixture.requestRpc({
				_tag: "CreateSession",
				projectSlug,
				originId: "request-folders",
				instanceId,
				providerId: "opencode",
				permissionMode: "ask",
				model: { providerId: "fake", modelId: "fake-model" },
				...(newWorktree ? { newWorktree } : {}),
			});
		const worktree = await create("process-test", true);
		const other = await create(String(savedSlug), false);
		const { sessions } = await fixture.requestRpc({
			_tag: "ListDaemonSessions",
			projectSlug: "process-test",
		});
		const recorded = sessions.find(({ id }) => id === worktree.sessionId)
			?.workspace?.worktrees[fixture.projectDir];
		if (!recorded) throw new Error("Launch did not record its worktree");
		// A worktree launch names the session; OpenCode names its own (82tn.80).
		const nativeOf = (sessionId: string) => {
			const db = new Database(fixture.daemonStorePath(), { readonly: true });
			try {
				return (
					db
						.prepare(
							"SELECT COALESCE(provider_sid, id) AS native FROM sessions WHERE id = ?",
						)
						.get(sessionId) as { native: string }
				).native;
			} finally {
				db.close();
			}
		};
		const sessionIds = [worktree.sessionId, other.sessionId];
		const folders = {
			[nativeOf(worktree.sessionId)]: realpathSync(recorded),
			[nativeOf(other.sessionId)]: realpathSync(projectB),
		};
		expect(folders[nativeOf(worktree.sessionId)]).not.toBe(
			realpathSync(fixture.projectDir),
		);

		for (const sessionId of sessionIds) {
			await fixture.requestRpc({
				_tag: "RenameSession",
				sessionId,
				title: `renamed ${sessionId}`,
			});
			await fixture.requestRpc({ _tag: "DeleteSession", sessionId });
		}

		const sent = (method: string) =>
			Object.fromEntries(
				fixture
					.opencodeRequests()
					.filter((request) => request.method === method)
					.map(({ url, directory }) => [
						new URL(url, "http://opencode.test").pathname.replace(
							"/session/",
							"",
						),
						directory === undefined
							? null
							: // A deleted worktree is gone; its parent still resolves.
								join(
									realpathSync(dirname(decodeURIComponent(directory))),
									basename(decodeURIComponent(directory)),
								),
					]),
			);
		evidence["folders"] = folders;
		evidence["renames"] = sent("PATCH");
		evidence["deletes"] = sent("DELETE");
		expect(evidence["renames"]).toEqual(folders);
		expect(evidence["deletes"]).toEqual(folders);
	});
});
