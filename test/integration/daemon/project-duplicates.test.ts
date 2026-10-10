import { execFileSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	FindFolders,
	GetProjects,
	ProjectSaveRejected,
	SaveProject,
} from "../../../src/lib/contracts/ws-rpc.js";
import type { DaemonConfig } from "../../../src/lib/daemon/config-persistence.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

// Failure cases: aliases can create duplicates, stored paths can retain a
// symlink, adding an existing project can overwrite its title/folders, and
// unreadable folders can be mistaken for missing folders or accepted by stat.
describe("canonical project folders through the daemon", () => {
	let harness: ProcessHarness | undefined;
	let scenario = "setup";
	let manifest: Record<string, unknown> = {};

	async function projects(fixture: ProcessHarness) {
		const result = await sendRpcRequest(
			join(fixture.configDir, "relay.sock"),
			new GetProjects({}),
		);
		return result.projects
			.map(({ slug, title, folders }) => ({ slug, title, folders }))
			.sort((left, right) => left.slug.localeCompare(right.slug));
	}

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		const root = realpathSync(fixture.root);
		try {
			manifest["passed"] = task.result?.state === "pass";
			manifest["projectsAfter"] = await projects(fixture).catch(() => null);
			await fixture.terminate();
			manifest["storedAfter"] = (
				JSON.parse(
					readFileSync(join(fixture.configDir, "daemon.json"), "utf8"),
				) as DaemonConfig
			).projects.map(({ slug, title, folders }) => ({ slug, title, folders }));
		} finally {
			try {
				await fixture.dispose();
				fixture.assertNoRunners();
			} finally {
				mkdirSync("test-results", { recursive: true });
				writeFileSync(`test-results/q5u6-12-${scenario}.log`, fixture.logTail);
				writeFileSync(
					`test-results/q5u6-12-${scenario}.json`,
					`${JSON.stringify(manifest, null, 2).split(root).join("$ROOT").split(fixture.root).join("$ROOT")}\n`,
				);
				harness = undefined;
			}
		}
	});

	it("stores the realpath and returns existing for symlink, slash and home spellings", async () => {
		scenario = "duplicates";
		manifest = {};
		harness = ProcessHarness.create();
		const fixture = harness;
		const root = realpathSync(fixture.root);
		const directory = join(root, "repo");
		const alias = join(root, "home", "repo-alias");
		mkdirSync(directory);
		const gitEnv = { ...process.env };
		delete gitEnv["GIT_DIR"];
		delete gitEnv["GIT_INDEX_FILE"];
		execFileSync("git", ["init"], {
			cwd: directory,
			env: gitEnv,
			stdio: "pipe",
		});
		symlinkSync(directory, alias, "dir");
		await fixture.restart();
		const save = (folders: string[], title = "Original") =>
			sendRpcRequest(
				join(fixture.configDir, "relay.sock"),
				new SaveProject({ folders, title }),
			);
		const added = await save([alias]);
		manifest["projectsBefore"] = await projects(fixture);
		expect(added.projects).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					slug: added.savedSlug,
					title: "Original",
					folders: [directory],
				}),
			]),
		);
		const results: Array<{
			spelling: string;
			savedSlug: string;
			kind: "existing" | undefined;
		}> = [];
		manifest["duplicates"] = results;
		for (const spelling of [
			alias,
			`${directory}/`,
			"~/repo-alias",
			directory,
		]) {
			const result = await save([spelling], "Must not overwrite");
			results.push({
				spelling,
				savedSlug: result.savedSlug,
				kind: result.kind,
			});
			expect(result).toMatchObject({
				kind: "existing",
				savedSlug: added.savedSlug,
			});
			expect(await projects(fixture)).toEqual(manifest["projectsBefore"]);
		}
		await vi.waitFor(() => {
			const config: DaemonConfig = JSON.parse(
				readFileSync(join(fixture.configDir, "daemon.json"), "utf8"),
			);
			expect(config.projects).toHaveLength(2);
			expect(
				config.projects.find(({ slug }) => slug === added.savedSlug)?.folders,
			).toEqual([directory]);
		});
	}, 60_000);

	it("rejects denied readdir and stat with a permission-denied issue", async () => {
		scenario = "permission-denied";
		manifest = {};
		harness = ProcessHarness.create();
		const fixture = harness;
		const denied = join(realpathSync(fixture.root), "denied");
		const child = join(denied, "child");
		mkdirSync(child, { recursive: true });
		await fixture.restart();
		manifest["projectsBefore"] = await projects(fixture);
		chmodSync(denied, 0);
		try {
			const issues: Array<ProjectSaveRejected["issues"]> = [];
			manifest["issues"] = issues;
			for (const path of [denied, child]) {
				const error = await sendRpcRequest(
					join(fixture.configDir, "relay.sock"),
					new SaveProject({ folders: [path] }),
				).then(
					() => undefined,
					(cause: unknown) => cause,
				);
				expect(error).toBeInstanceOf(ProjectSaveRejected);
				if (!(error instanceof ProjectSaveRejected))
					throw new Error(`Expected ProjectSaveRejected, got ${String(error)}`);
				issues.push(error.issues);
				expect(error.issues).toEqual([{ kind: "permission-denied", path }]);
				const lookup = await sendRpcRequest(
					join(fixture.configDir, "relay.sock"),
					new FindFolders({ query: `${path}/` }),
				).then(
					() => undefined,
					(cause: unknown) => cause,
				);
				expect(lookup).toBeInstanceOf(ProjectSaveRejected);
				if (lookup instanceof ProjectSaveRejected)
					expect(lookup.issues).toEqual([{ kind: "permission-denied", path }]);
			}
			expect(await projects(fixture)).toEqual(manifest["projectsBefore"]);
		} finally {
			chmodSync(denied, 0o755);
		}
	}, 60_000);
});
