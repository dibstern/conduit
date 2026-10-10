// Failure modes: transport spellings split clones, no-origin worktrees split,
// non-git folders acquire an identity, old configs never backfill, folder edits
// retain detached identities, and daemon restarts retain a changed/removed origin.
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	GetProjects,
	type ProjectInfo,
	SaveProject,
} from "../../../src/lib/contracts/ws-rpc.js";
import {
	type DaemonConfig,
	loadDaemonConfig,
} from "../../../src/lib/daemon/config-persistence.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

describe("repository identities through the daemon", () => {
	let harness: ProcessHarness | undefined;
	let manifest: Record<string, unknown>;

	const projects = async (fixture: ProcessHarness) =>
		(
			await sendRpcRequest(
				join(fixture.configDir, "relay.sock"),
				new GetProjects({}),
			)
		).projects;
	const state = (
		entries: readonly Pick<
			ProjectInfo,
			"slug" | "title" | "folders" | "repositoryIdentities"
		>[],
	) =>
		entries
			.map(({ slug, title, folders, repositoryIdentities }) => ({
				slug,
				title,
				folders,
				repositoryIdentities: Object.fromEntries(
					Object.entries(repositoryIdentities ?? {}).sort(([left], [right]) =>
						left.localeCompare(right),
					),
				),
			}))
			.sort((left, right) => left.slug.localeCompare(right.slug));

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		const root = realpathSync(fixture.root);
		try {
			manifest["passed"] = task.result?.state === "pass";
			manifest["projectsAfter"] = state(
				await projects(fixture).catch(() => []),
			);
			await fixture.terminate();
			manifest["storedAfter"] = state(
				loadDaemonConfig(fixture.configDir)?.projects.map((project) => ({
					...project,
					title: project.title ?? project.slug,
				})) ?? [],
			);
		} finally {
			try {
				await fixture.dispose();
				fixture.assertNoRunners();
			} finally {
				mkdirSync("test-results", { recursive: true });
				writeFileSync(
					"test-results/q5u6-17-repository-identity.log",
					fixture.logTail,
				);
				writeFileSync(
					"test-results/q5u6-17-repository-identity.json",
					`${JSON.stringify(manifest, null, 2).split(root).join("$ROOT")}\n`,
				);
				harness = undefined;
			}
		}
	});

	it("derives each folder, backfills legacy projects and refreshes on restart", async () => {
		manifest = {};
		harness = ProcessHarness.create();
		const fixture = harness;
		const root = realpathSync(fixture.root);
		const gitEnv = { ...process.env };
		delete gitEnv["GIT_DIR"];
		delete gitEnv["GIT_INDEX_FILE"];
		const git = (cwd: string, ...args: string[]) =>
			execFileSync("git", args, {
				cwd,
				env: gitEnv,
				stdio: "pipe",
				timeout: 5000,
			});
		const bare = join(root, "remote.git");
		git(root, "init", "--bare", "-q", bare);
		const ssh = join(root, "ssh-clone");
		const https = join(root, "https-clone");
		for (const clone of [ssh, https]) git(root, "clone", "-q", bare, clone);
		git(ssh, "remote", "set-url", "origin", "git@GitHub.COM:Owner/Shared.git");
		git(
			https,
			"remote",
			"set-url",
			"origin",
			"https://user:password@github.com:8443/owner/SHARED.git/",
		);
		const local = join(root, "local");
		mkdirSync(local);
		git(local, "init", "-q");
		git(
			local,
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.com",
			"commit",
			"--allow-empty",
			"-qm",
			"initial",
		);
		const linked = join(root, "linked");
		git(local, "worktree", "add", "-qb", "linked", linked);
		const scratch = join(root, "scratch");
		mkdirSync(scratch);
		const legacy = join(root, "legacy");
		mkdirSync(legacy);
		git(legacy, "init", "-q");
		git(
			legacy,
			"remote",
			"add",
			"origin",
			"ssh://git@gitlab.com/Group/Sub/Legacy.git",
		);
		const config: DaemonConfig = {
			pid: 0,
			port: 0,
			pinHash: null,
			tls: false,
			debug: false,
			keepAwake: false,
			dangerouslySkipPermissions: false,
			projects: [
				{
					path: legacy,
					folders: [legacy],
					slug: "legacy",
					title: "Legacy",
					addedAt: 0,
				},
			],
		};
		writeFileSync(
			join(fixture.configDir, "daemon.json"),
			JSON.stringify(config),
		);
		await fixture.restart();
		const socket = join(fixture.configDir, "relay.sock");
		const save = (folders: string[], title: string) =>
			sendRpcRequest(socket, new SaveProject({ folders, title }));
		const sshProject = await save([ssh, scratch], "SSH clone");
		const httpsProject = await save([https], "HTTPS clone");
		const localProject = await save([local], "Local");
		const linkedProject = await save([linked], "Linked");
		const scratchProject = await save([scratch], "Scratch");
		const before = await projects(fixture);
		manifest["projectsBefore"] = state(before);
		const bySlug = (entries: readonly ProjectInfo[], slug: string) => {
			const project = entries.find((project) => project.slug === slug);
			expect(project).toBeDefined();
			if (!project) throw new Error(`Missing project ${slug}`);
			return project;
		};
		expect(bySlug(before, sshProject.savedSlug).repositoryIdentities).toEqual({
			[ssh]: { key: "github.com/owner/shared", name: "Shared", root: ssh },
		});
		expect(bySlug(before, httpsProject.savedSlug).repositoryIdentities).toEqual(
			{
				[https]: {
					key: "github.com/owner/shared",
					name: "SHARED",
					root: https,
				},
			},
		);
		const localIdentity = {
			key: join(local, ".git"),
			name: "local",
			root: local,
		};
		expect(bySlug(before, localProject.savedSlug).repositoryIdentities).toEqual(
			{ [local]: localIdentity },
		);
		expect(
			bySlug(before, linkedProject.savedSlug).repositoryIdentities,
		).toEqual({ [linked]: { ...localIdentity, root: linked } });
		expect(
			bySlug(before, scratchProject.savedSlug).repositoryIdentities,
		).toEqual({});
		expect(bySlug(before, "legacy").repositoryIdentities).toEqual({
			[legacy]: {
				key: "gitlab.com/group/sub/legacy",
				name: "Legacy",
				root: legacy,
			},
		});
		await vi.waitFor(() => {
			const stored = loadDaemonConfig(fixture.configDir);
			expect(
				stored?.projects.find(
					(project) => project.slug === sshProject.savedSlug,
				)?.repositoryIdentities,
			).toEqual(bySlug(before, sshProject.savedSlug).repositoryIdentities);
		});

		// Changing the folder list must derive newly attached folders and drop detached keys.
		await sendRpcRequest(
			socket,
			new SaveProject({
				slug: sshProject.savedSlug,
				folders: [ssh, linked, scratch],
			}),
		);
		expect(
			bySlug(await projects(fixture), sshProject.savedSlug)
				.repositoryIdentities,
		).toEqual({
			[ssh]: { key: "github.com/owner/shared", name: "Shared", root: ssh },
			[linked]: { ...localIdentity, root: linked },
		});
		await sendRpcRequest(
			socket,
			new SaveProject({ slug: sshProject.savedSlug, folders: [ssh, scratch] }),
		);
		expect(
			bySlug(await projects(fixture), sshProject.savedSlug)
				.repositoryIdentities,
		).toEqual(bySlug(before, sshProject.savedSlug).repositoryIdentities);

		// Persist the old values before changing git, so refresh cannot be a first-load backfill.
		await fixture.terminate();
		manifest["storedBeforeRestart"] = state(
			loadDaemonConfig(fixture.configDir)?.projects.map((project) => ({
				...project,
				title: project.title ?? project.slug,
			})) ?? [],
		);
		git(
			ssh,
			"remote",
			"set-url",
			"origin",
			"ssh://git@gitlab.com:2222/New/Repo.git",
		);
		git(https, "remote", "remove", "origin");
		git(legacy, "remote", "set-url", "origin", "invalid origin");
		await fixture.restart();
		const after = await projects(fixture);
		manifest["projectsAfterRestart"] = state(after);
		expect(bySlug(after, sshProject.savedSlug).repositoryIdentities).toEqual({
			[ssh]: { key: "gitlab.com/new/repo", name: "Repo", root: ssh },
		});
		expect(bySlug(after, httpsProject.savedSlug).repositoryIdentities).toEqual({
			[https]: { key: join(https, ".git"), name: "https-clone", root: https },
		});
		expect(bySlug(after, "legacy").repositoryIdentities).toEqual({
			[legacy]: { key: join(legacy, ".git"), name: "legacy", root: legacy },
		});
		expect(bySlug(after, localProject.savedSlug).repositoryIdentities).toEqual({
			[local]: localIdentity,
		});
		expect(
			bySlug(after, scratchProject.savedSlug).repositoryIdentities,
		).toEqual({});
		await vi.waitFor(() => {
			const stored = loadDaemonConfig(fixture.configDir);
			expect(
				stored?.projects.find(
					(project) => project.slug === sshProject.savedSlug,
				)?.repositoryIdentities,
			).toEqual(bySlug(after, sshProject.savedSlug).repositoryIdentities);
		});
		// The artifact must also be valid JSON after temp path normalisation.
		expect(
			JSON.parse(JSON.stringify(manifest).split(root).join("$ROOT")),
		).toEqual(expect.objectContaining({ projectsBefore: expect.any(Array) }));
	}, 90_000);
});
