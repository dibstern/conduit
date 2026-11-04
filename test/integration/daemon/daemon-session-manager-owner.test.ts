/*
 * 82tn.10.6: the daemon owns each project's session manager state.
 * Failure catalogue entries covered (recorded on the 82tn.10.6 bead):
 * 12 two relays of one project delete the same session at once and both run
 *    the delete (the in-flight table lived in each relay);
 * 13 a relay rebuild drops the project's manager caches (parent map, side
 *    threads, session count) until the next list;
 * 14 removing a project leaves its manager state in the daemon, so a project
 *    added again under the same slug reads the old caches;
 *  1 one owner serving two projects mixes their state.
 */
import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodePath } from "@effect/platform-node";
import {
	Context,
	Effect,
	HashMap,
	Layer,
	ManagedRuntime,
	Option,
	Ref,
} from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { makeDaemonLive } from "../../../src/lib/domain/daemon/Layers/daemon-layers.js";
import { RelayFactoryTag } from "../../../src/lib/domain/daemon/Layers/relay-factory-layer.js";
import { makeDaemonConfigFromOptions } from "../../../src/lib/domain/daemon/Services/daemon-config-ref.js";
import { OwnerScopes } from "../../../src/lib/domain/daemon/Services/owner-scopes.js";
import { addWithoutRelay } from "../../../src/lib/domain/daemon/Services/project-registry-service.js";
import { SessionManagerServiceTag } from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import { SessionManagerStateTag } from "../../../src/lib/domain/relay/Services/session-manager-state.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { sdkDefaultClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import type { ProjectRelay } from "../../../src/lib/relay/relay-stack.js";

const artifacts = join(process.cwd(), "test-results");
const evidence: {
	scenario?: string | undefined;
	observed: Record<string, unknown>;
} = {
	observed: {},
};
const cleanups: Array<() => Promise<void>> = [];

afterEach(async (context) => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	if (!evidence.scenario) return;
	mkdirSync(artifacts, { recursive: true });
	writeFileSync(
		join(artifacts, `82tn-10-6-owner-${evidence.scenario}.json`),
		`${JSON.stringify(
			{
				scenario: evidence.scenario,
				result: context.task.result?.state,
				failures: context.task.result?.errors?.map((error) => error.message),
				observed: evidence.observed,
			},
			null,
			2,
		)}\n`,
	);
	evidence.scenario = undefined;
	evidence.observed = {};
});

const start = async (scenario: string) => {
	evidence.scenario = scenario;
	const root = realpathSync(mkdtempSync(join(tmpdir(), "conduit-sm-owner-")));
	const projects = ["alpha", "beta"].map((slug) => {
		const folder = join(root, slug);
		mkdirSync(folder);
		execFileSync("git", ["init", "-q", "-b", "main", folder]);
		execFileSync("git", [
			"-C",
			folder,
			"-c",
			"user.name=Owner test",
			"-c",
			"user.email=owner@example.test",
			"-c",
			"core.hooksPath=/dev/null",
			"-c",
			"commit.gpgsign=false",
			"commit",
			"-q",
			"--allow-empty",
			"-m",
			"Initial",
		]);
		return { slug, title: slug, folders: [folder] as const, lastUsed: 1 };
	});
	const configDir = join(root, "config");
	mkdirSync(configDir);
	const daemon = ManagedRuntime.make(
		makeDaemonLive({
			configDir,
			socketPath: join(configDir, "relay.sock"),
			staticDir: root,
			launchLogin: sdkDefaultClaudeConfigDir(join(root, "home", ".claude")),
			initialConfig: makeDaemonConfigFromOptions({
				port: 0,
				host: "127.0.0.1",
				tlsEnabled: false,
				hostExplicit: true,
			}),
			smartDefault: false,
		}).pipe(Layer.provide(NodePath.layer)),
	);
	const relays = new Set<ProjectRelay>();
	cleanups.push(async () => {
		for (const relay of relays) await relay.stop();
		await daemon.dispose();
		rmSync(root, { recursive: true, force: true });
	});
	const project = (slug: string) => {
		const found = projects.find((candidate) => candidate.slug === slug);
		if (!found) throw new Error(`No project ${slug}`);
		return found;
	};
	const register = (slug: string) =>
		daemon.runPromise(addWithoutRelay(project(slug), { silent: true }));
	const relay = async (slug: string) => {
		const created = await daemon.runPromise(
			Effect.flatMap(RelayFactoryTag, (factory) =>
				factory.create(project(slug)),
			),
		);
		relays.add(created);
		return created;
	};
	const stop = async (target: ProjectRelay) => {
		relays.delete(target);
		await target.stop();
	};
	const stateOf = async (target: ProjectRelay) =>
		Option.getOrThrow(
			Context.getOption(
				await target.effectRuntime.runtime.context(),
				SessionManagerStateTag,
			),
		);
	const snapshot = async (target: ProjectRelay) => {
		const state = await Effect.runPromise(Ref.get(await stateOf(target)));
		return {
			parents: Object.fromEntries(HashMap.toEntries(state.cachedParentMap)),
			sideThreads: [...state.cachedSideThreadIds],
			sessionCount: state.lastKnownSessionCount,
		};
	};
	const seed = async (target: ProjectRelay, count: number) =>
		Effect.runPromise(
			Ref.update(await stateOf(target), (state) => ({
				...state,
				cachedParentMap: HashMap.set(state.cachedParentMap, "child", "parent"),
				cachedSideThreadIds: new Set(["side"]),
				lastKnownSessionCount: count,
			})),
		);
	return { daemon, register, relay, stop, snapshot, seed };
};

describe("daemon-owned session manager state", () => {
	it("keeps a project's manager state through a relay rebuild and apart from other projects", async () => {
		const daemon = await start("rebuild-keeps-state");
		await daemon.register("alpha");
		await daemon.register("beta");
		const alpha = await daemon.relay("alpha");
		const beta = await daemon.relay("beta");
		await daemon.seed(alpha, 7);
		await daemon.seed(beta, 3);
		await daemon.stop(alpha);
		const rebuilt = await daemon.relay("alpha");
		const observed = {
			alphaAfterRebuild: await daemon.snapshot(rebuilt),
			beta: await daemon.snapshot(beta),
		};
		evidence.observed = observed;
		expect(observed).toEqual({
			alphaAfterRebuild: {
				parents: { child: "parent" },
				sideThreads: ["side"],
				sessionCount: 7,
			},
			beta: {
				parents: { child: "parent" },
				sideThreads: ["side"],
				sessionCount: 3,
			},
		});
	});

	it("drops a project's manager state when the project is removed", async () => {
		const daemon = await start("remove-drops-state");
		await daemon.register("alpha");
		const alpha = await daemon.relay("alpha");
		await daemon.seed(alpha, 7);
		await daemon.stop(alpha);
		await daemon.daemon.runPromise(
			Effect.flatMap(OwnerScopes, (owners) =>
				owners.close({ kind: "project", projectId: "alpha" }, "remove"),
			),
		);
		const readded = await daemon.relay("alpha");
		const observed = { alphaAfterRemove: await daemon.snapshot(readded) };
		evidence.observed = observed;
		expect(observed).toEqual({
			alphaAfterRemove: { parents: {}, sideThreads: [], sessionCount: 0 },
		});
	});

	it("runs one delete when two relays of a project delete the same session", async () => {
		const daemon = await start("one-delete-across-relays");
		await daemon.register("alpha");
		const first = await daemon.relay("alpha");
		await first.effectRuntime.runtime.runPromise(
			Effect.flatMap(makeCommitAndSignal, (commit) =>
				commit([
					canonicalEvent("session.created", "doomed", {
						sessionId: "doomed",
						provider: "claude",
						title: "Doomed",
					}),
				]),
			),
		);
		const second = await daemon.relay("alpha");
		const remove = (target: ProjectRelay) =>
			target.effectRuntime.runtime.runPromise(
				Effect.flatMap(SessionManagerServiceTag, (service) =>
					service.deleteSession("doomed", { keepWorktrees: true }),
				),
			);
		const results = await Promise.all([remove(first), remove(second)]);
		evidence.observed = { results };
		expect([...results].sort()).toEqual([false, true]);
	});
});
