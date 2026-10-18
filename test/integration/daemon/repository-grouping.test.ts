// Failure modes: remote spellings split one repository; qualifiers survive a
// group split; omitted saves clear overrides; monorepo subfolders collapse;
// default changes miss connected browsers; cleared overrides survive restart;
// clients receive different group order or grouping settings are not persisted.
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Fiber, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectInfo } from "../../../src/lib/contracts/ws-rpc.js";
import {
	type ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";

const gitEnv = { ...process.env };
for (const key of [
	"GIT_DIR",
	"GIT_INDEX_FILE",
	"GIT_WORK_TREE",
	"GIT_COMMON_DIR",
])
	delete gitEnv[key];

function git(cwd: string, ...args: string[]) {
	execFileSync("git", args, {
		cwd,
		env: gitEnv,
		stdio: "pipe",
		timeout: 5000,
	});
}

describe("repository grouping through the built daemon", () => {
	let harness: ProcessHarness | undefined;
	let browser: ProcessBrowser | undefined;
	let observer: ProcessBrowser | undefined;
	let following: Fiber.RuntimeFiber<void, unknown> | undefined;
	let lists: (readonly ProjectInfo[])[] = [];
	let scenario = "setup";
	let manifest: Record<string, unknown> = {};
	const evidence: Record<string, unknown> = {};
	const logs: string[] = [];

	const state = (projects: readonly ProjectInfo[]) =>
		projects
			.map(
				({
					slug,
					title,
					folders,
					repositoryIdentities,
					groupingMode,
					effectiveGroupingMode,
					group,
				}) => ({
					slug,
					title,
					folders,
					repositoryIdentities: Object.fromEntries(
						Object.entries(repositoryIdentities ?? {}).sort(([a], [b]) =>
							a.localeCompare(b),
						),
					),
					groupingMode,
					effectiveGroupingMode,
					group,
				}),
			)
			.sort((a, b) => a.slug.localeCompare(b.slug));

	const project = (projects: readonly ProjectInfo[], slug: string) => {
		const entry = projects.find((item) => item.slug === slug);
		if (!entry) throw new Error(`Missing served project ${slug}`);
		expect(entry.group).toBeDefined();
		return entry;
	};

	async function connect(fixture: ProcessHarness) {
		browser = await fixture.connect();
		observer = await fixture.connect();
		lists = [];
		following = Effect.runFork(
			Stream.runForEach(observer.rpc.SubscribeShell({}), (frame) =>
				Effect.sync(() => {
					if (frame._tag === "projects") lists.push(frame.projects);
				}),
			),
		);
		await vi.waitFor(() => expect(lists.length).toBeGreaterThan(0));
		return browser;
	}

	async function start(name: string) {
		scenario = name;
		manifest = {};
		harness = ProcessHarness.create({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			foregroundCli: true,
		});
		await harness.restart();
		return { fixture: harness, client: await connect(harness) };
	}

	async function capture(name: string, cursor: number) {
		if (!browser || !observer) throw new Error("Missing browser connection");
		const served = await Effect.runPromise(browser.rpc.GetProjects({}));
		const fromObserver = await Effect.runPromise(observer.rpc.GetProjects({}));
		const order = served.projects.map(({ slug }) => slug);
		expect(fromObserver.projects.map(({ slug }) => slug)).toEqual(order);
		expect(state(fromObserver.projects)).toEqual(state(served.projects));
		await vi.waitFor(
			() => {
				expect(lists.length).toBeGreaterThan(cursor);
				const latest = lists.at(-1) ?? [];
				expect(latest.map(({ slug }) => slug)).toEqual(order);
				expect(state(latest)).toEqual(state(served.projects));
			},
			{ timeout: 15_000 },
		);
		manifest[name] = state(served.projects);
		return served.projects;
	}

	async function disconnect() {
		if (following) await Effect.runPromise(Fiber.interrupt(following));
		following = undefined;
		await observer?.close();
		await browser?.close();
		observer = undefined;
		browser = undefined;
	}

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		const root = realpathSync(fixture.root);
		try {
			manifest["passed"] = task.result?.state === "pass";
			await disconnect();
			await fixture.terminate();
		} finally {
			try {
				await fixture.dispose();
				fixture.assertNoRunners();
				manifest["cleanup"] = "no fixture runners remain";
			} finally {
				const normalize = (value: string) =>
					value.replaceAll(root, "$ROOT").replaceAll(fixture.root, "$ROOT");
				evidence[scenario] = JSON.parse(normalize(JSON.stringify(manifest)));
				logs.push(`${scenario}\n${normalize(fixture.logTail)}`);
				mkdirSync("test-results", { recursive: true });
				writeFileSync(
					"test-results/q5u6-18-repository-grouping.json",
					`${JSON.stringify(evidence, null, 2)}\n`,
				);
				writeFileSync(
					"test-results/q5u6-18-repository-grouping.log",
					`${logs.join("\n")}\n`,
				);
				harness = undefined;
			}
		}
	});

	it("groups SSH and HTTPS clones and removes qualifiers when one project opts out", async () => {
		const { fixture, client } = await start("clones");
		const root = realpathSync(fixture.root);
		const remote = join(root, "remote.git");
		const ssh = join(root, "ssh-clone");
		const https = join(root, "https-clone");
		git(root, "init", "--bare", "-q", remote);
		for (const clone of [ssh, https]) git(root, "clone", "-q", remote, clone);
		git(ssh, "remote", "set-url", "origin", "git@GitHub.COM:Owner/Shared.git");
		git(
			https,
			"remote",
			"set-url",
			"origin",
			"https://github.com/owner/Shared.git",
		);
		let cursor = lists.length;
		const first = await Effect.runPromise(
			client.rpc.SaveProject({ folders: [ssh], title: "SSH clone" }),
		);
		const second = await Effect.runPromise(
			client.rpc.SaveProject({ folders: [https], title: "HTTPS clone" }),
		);
		const grouped = await capture("grouped", cursor);
		expect(state(second.projects)).toEqual(state(grouped));
		const firstGroup = project(grouped, first.savedSlug).group;
		const secondGroup = project(grouped, second.savedSlug).group;
		expect(firstGroup).toMatchObject({
			label: "Shared",
			needsProjectQualifier: true,
		});
		expect(secondGroup).toEqual(firstGroup);
		expect(
			new Set(
				[first.savedSlug, second.savedSlug].map(
					(slug) => project(grouped, slug).group?.key,
				),
			).size,
		).toBe(1);

		cursor = lists.length;
		const optedOut = await Effect.runPromise(
			client.rpc.SaveProject({
				slug: second.savedSlug,
				folders: [https],
				groupingMode: "off",
			}),
		);
		const separated = await capture("optedOut", cursor);
		expect(state(optedOut.projects)).toEqual(state(separated));
		expect(project(separated, first.savedSlug).group).toMatchObject({
			label: "Shared",
			needsProjectQualifier: false,
		});
		expect(project(separated, second.savedSlug)).toMatchObject({
			groupingMode: "off",
			effectiveGroupingMode: "off",
			group: { label: "HTTPS clone", needsProjectQualifier: false },
		});
		expect(project(separated, first.savedSlug).group?.key).not.toBe(
			project(separated, second.savedSlug).group?.key,
		);

		cursor = lists.length;
		await Effect.runPromise(
			client.rpc.SaveProject({ slug: second.savedSlug, folders: [https] }),
		);
		const preserved = await capture("overridePreserved", cursor);
		expect(state(preserved)).toEqual(state(separated));
	}, 90_000);

	it("applies live defaults and project overrides to monorepo packages across restart", async () => {
		const { fixture, client } = await start("monorepo");
		const root = realpathSync(fixture.root);
		const monorepo = join(root, "monorepo");
		git(root, "init", "-q", monorepo);
		git(
			monorepo,
			"remote",
			"add",
			"origin",
			"https://github.com/owner/Monorepo.git",
		);
		const api = join(monorepo, "packages", "api");
		const web = join(monorepo, "packages", "web");
		for (const folder of [api, web]) mkdirSync(folder, { recursive: true });
		let cursor = lists.length;
		const first = await Effect.runPromise(
			client.rpc.SaveProject({ folders: [api], title: "API" }),
		);
		const second = await Effect.runPromise(
			client.rpc.SaveProject({ folders: [web], title: "Web" }),
		);
		const grouped = await capture("repositoryDefault", cursor);
		expect(project(grouped, first.savedSlug).group).toEqual(
			project(grouped, second.savedSlug).group,
		);
		expect(project(grouped, first.savedSlug).group).toMatchObject({
			label: "Monorepo",
			needsProjectQualifier: true,
		});

		cursor = lists.length;
		const changed = await Effect.runPromise(
			client.rpc.SetDefaultGroupingMode({ mode: "repository+subfolder" }),
		);
		expect(changed).toEqual({ mode: "repository+subfolder" });
		const bySubfolder = await capture("subfolderDefault", cursor);
		for (const slug of [first.savedSlug, second.savedSlug])
			expect(project(bySubfolder, slug)).toMatchObject({
				effectiveGroupingMode: "repository+subfolder",
				group: { label: "Monorepo", needsProjectQualifier: false },
			});
		expect(project(bySubfolder, first.savedSlug).group?.key).not.toBe(
			project(bySubfolder, second.savedSlug).group?.key,
		);

		cursor = lists.length;
		for (const [slug, folder] of [
			[first.savedSlug, api],
			[second.savedSlug, web],
		] as const)
			await Effect.runPromise(
				client.rpc.SaveProject({
					slug,
					folders: [folder],
					groupingMode: "repository",
				}),
			);
		const overridden = await capture("repositoryOverrides", cursor);
		expect(project(overridden, first.savedSlug).group).toEqual(
			project(overridden, second.savedSlug).group,
		);
		expect(
			project(overridden, first.savedSlug).group?.needsProjectQualifier,
		).toBe(true);

		cursor = lists.length;
		await Effect.runPromise(client.rpc.SetDefaultGroupingMode({ mode: "off" }));
		const globalOff = await capture("globalOffWithOverrides", cursor);
		for (const slug of [first.savedSlug, second.savedSlug])
			expect(project(globalOff, slug)).toMatchObject({
				groupingMode: "repository",
				effectiveGroupingMode: "repository",
				group: { label: "Monorepo", needsProjectQualifier: true },
			});

		cursor = lists.length;
		await Effect.runPromise(
			client.rpc.SaveProject({
				slug: first.savedSlug,
				folders: [api],
				groupingMode: null,
			}),
		);
		const cleared = await capture("clearedOverride", cursor);
		expect(project(cleared, first.savedSlug).groupingMode).toBeUndefined();
		expect(project(cleared, first.savedSlug)).toMatchObject({
			effectiveGroupingMode: "off",
			group: { label: "API", needsProjectQualifier: false },
		});
		expect(project(cleared, second.savedSlug).group).toMatchObject({
			label: "Monorepo",
			needsProjectQualifier: false,
		});
		expect(project(cleared, first.savedSlug).group?.key).not.toBe(
			project(cleared, second.savedSlug).group?.key,
		);
		await vi.waitFor(() =>
			expect(
				observer?.frames
					.filter(({ message }) => message["_tag"] === "defaultGroupingMode")
					.map(({ message }) => message["mode"]),
			).toEqual(["repository", "repository+subfolder", "off"]),
		);
		manifest["defaultModesBeforeRestart"] = observer?.frames
			.filter(({ message }) => message["_tag"] === "defaultGroupingMode")
			.map(({ message }) => message["mode"]);

		await disconnect();
		await fixture.terminate();
		await fixture.restart();
		const restarted = await connect(fixture);
		const afterRestart = await capture("afterRestart", 0);
		expect(state(afterRestart)).toEqual(state(cleared));
		expect(
			observer?.frames
				.filter(({ message }) => message["_tag"] === "defaultGroupingMode")
				.map(({ message }) => message["mode"]),
		).toEqual(["off"]);

		cursor = lists.length;
		await Effect.runPromise(
			restarted.rpc.SetDefaultGroupingMode({ mode: "repository" }),
		);
		const inherited = await capture(
			"clearedOverrideInheritsLaterDefault",
			cursor,
		);
		expect(project(inherited, first.savedSlug).groupingMode).toBeUndefined();
		expect(project(inherited, first.savedSlug).effectiveGroupingMode).toBe(
			"repository",
		);
		expect(project(inherited, first.savedSlug).group).toEqual(
			project(inherited, second.savedSlug).group,
		);
		expect(
			project(inherited, first.savedSlug).group?.needsProjectQualifier,
		).toBe(true);
	}, 90_000);
});
