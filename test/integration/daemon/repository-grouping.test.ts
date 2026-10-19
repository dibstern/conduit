// Failure modes: a shared Repository Identity merges projects; legacy settings
// prevent startup or survive the next save; saving loses unrelated settings.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
	loadRelaySettings,
	saveRelaySettings,
} from "../../../src/lib/relay/relay-settings.js";
import {
	type ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";

describe("projects sharing a Repository Identity", () => {
	let harness: ProcessHarness | undefined;
	let browser: ProcessBrowser | undefined;
	let observed: unknown;

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		const root = realpathSync(fixture.root);
		try {
			await browser?.close();
			await fixture.terminate();
		} finally {
			try {
				await fixture.dispose();
				fixture.assertNoRunners();
			} finally {
				mkdirSync("test-results", { recursive: true });
				writeFileSync(
					"test-results/m379-8-separate-projects.json",
					`${JSON.stringify({ passed: task.result?.state === "pass", projects: observed }, null, 2).replaceAll(root, "$ROOT")}\n`,
				);
				harness = undefined;
			}
		}
	});

	it("keeps clones separate across restart and drops retired config keys on save", async () => {
		harness = ProcessHarness.create();
		const fixture = harness;
		const root = realpathSync(fixture.root);
		const folders = [join(root, "ssh-clone"), join(root, "https-clone")];
		const gitEnv = { ...process.env };
		for (const key of [
			"GIT_DIR",
			"GIT_INDEX_FILE",
			"GIT_WORK_TREE",
			"GIT_COMMON_DIR",
		])
			delete gitEnv[key];
		for (const folder of folders) {
			mkdirSync(folder);
			execFileSync("git", ["init", "-q", folder], {
				env: gitEnv,
				stdio: "pipe",
			});
			execFileSync(
				"git",
				["remote", "add", "origin", "https://github.com/acme/shared.git"],
				{
					cwd: folder,
					env: gitEnv,
					stdio: "pipe",
				},
			);
		}
		writeFileSync(
			join(fixture.configDir, "daemon.json"),
			JSON.stringify({
				pid: 0,
				port: 0,
				pinHash: null,
				tls: false,
				debug: false,
				keepAwake: false,
				projects: folders.map((folder, index) => ({
					path: folder,
					folders: [folder],
					slug: `clone-${index}`,
					title: `Clone ${index}`,
					addedAt: 0,
					// Retired with Project Groups (ADR-0011); must still load.
					groupingMode: "repository",
				})),
			}),
		);
		writeFileSync(
			join(fixture.configDir, "settings.jsonc"),
			JSON.stringify({
				defaultModel: "acme/model",
				defaultGroupingMode: "repository",
			}),
		);
		expect(loadRelaySettings(fixture.configDir)).toEqual({
			defaultModel: "acme/model",
		});
		saveRelaySettings({ hiddenModels: ["hidden/model"] }, fixture.configDir);
		expect(
			JSON.parse(
				readFileSync(join(fixture.configDir, "settings.jsonc"), "utf8"),
			),
		).toEqual({
			defaultModel: "acme/model",
			hiddenModels: ["hidden/model"],
		});
		await fixture.restart();
		browser = await fixture.connect();
		const before = (
			await Effect.runPromise(browser.rpc.GetProjects({}))
		).projects.filter(({ slug }) => slug.startsWith("clone-"));
		expect(before.map(({ slug }) => slug).sort()).toEqual([
			"clone-0",
			"clone-1",
		]);
		for (const project of before) {
			expect(
				Object.values(project.repositoryIdentities ?? {}).map(({ key }) => key),
			).toEqual(["github.com/acme/shared"]);
			expect(project).not.toHaveProperty("group");
			expect(project).not.toHaveProperty("groupingMode");
		}
		const folder = folders[0];
		if (!folder) throw new Error("Missing clone folder");
		await Effect.runPromise(
			browser.rpc.SaveProject({
				slug: "clone-0",
				folders: [folder],
				title: "Renamed clone",
			}),
		);
		await browser.close();
		browser = undefined;
		await fixture.terminate();
		const saved: Record<string, unknown> & {
			projects: Record<string, unknown>[];
		} = JSON.parse(
			readFileSync(join(fixture.configDir, "daemon.json"), "utf8"),
		);
		for (const project of saved.projects)
			expect(project).not.toHaveProperty("groupingMode");
		await fixture.restart();
		browser = await fixture.connect();
		const after = (
			await Effect.runPromise(browser.rpc.GetProjects({}))
		).projects.filter(({ slug }) => slug.startsWith("clone-"));
		expect(
			after
				.map(({ slug, title, folders, repositoryIdentities }) => ({
					slug,
					title,
					folders,
					repositoryIdentities,
				}))
				.sort((a, b) => a.slug.localeCompare(b.slug)),
		).toEqual(
			before
				.map(({ slug, title, folders, repositoryIdentities }) => ({
					slug,
					title: slug === "clone-0" ? "Renamed clone" : title,
					folders,
					repositoryIdentities,
				}))
				.sort((a, b) => a.slug.localeCompare(b.slug)),
		);
		observed = after;
	}, 90_000);
});
