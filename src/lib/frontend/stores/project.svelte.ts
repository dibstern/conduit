// Manages the list of registered projects and the current project slug.

import { Effect, Fiber, Stream } from "effect";
import type { RuntimeFiber } from "effect/Fiber";
import { getRuntime, runTransportEffect } from "../transport/runtime.js";
import { WsRpcClients } from "../transport/shared-client.js";
import { supervise } from "../transport/supervise.js";
import type {
	ProjectMutationResponse,
	WsRpcError,
} from "../transport/ws-rpc.js";
import {
	getAgentsRpc,
	removeProjectRpc,
	setProjectInstanceRpc,
} from "../transport/ws-rpc-client.js";
import type { ProjectInfo } from "../types.js";
import { applyGetAgentsResponse, selectInstance } from "./discovery.svelte.js";
import { applyInstanceListResponse } from "./instance.svelte.js";
import { getDraftProject, projectState } from "./project-state.svelte.js";
import {
	attachedProjectState,
	getCurrentSlug,
	replaceRoute,
} from "./router.svelte.js";
import { applyServerStatus, serverStatusFeed } from "./server-status.js";
import { sessionState } from "./session.svelte.js";
import { confirm } from "./ui.svelte.js";
import { applyUsageLimitsSetting, applyUsageReadings } from "./usage.svelte.js";

export { getDraftProject, projectState } from "./project-state.svelte.js";

/** Each project's newest instance pick the daemon has not confirmed, with the
 *  daemon's binding to fall back to if it fails. */
const pendingPicks = new Map<
	string,
	{ instanceId: string; confirmed: string | undefined }
>();

const withBinding = (
	projects: readonly ProjectInfo[],
	slug: string,
	instanceId: string | undefined,
): ProjectInfo[] =>
	projects.map((p) => {
		if (p.slug !== slug) return p;
		const { instanceId: _, ...rest } = p;
		return instanceId === undefined ? rest : { ...rest, instanceId };
	});

/** Apply a full project list: the subscription's, or an RPC's reply. A
 *  pending pick outlives it, since the list may predate the pick. */
export function applyProjectList(
	response: Pick<ProjectMutationResponse, "projects" | "current">,
): void {
	let projects = toProjectInfoList(response.projects);
	for (const [slug, pick] of pendingPicks) {
		pick.confirmed = projects.find((p) => p.slug === slug)?.instanceId;
		projects = withBinding(projects, slug, pick.instanceId);
	}
	projectState.projects = projects;
	if (response.current != null) projectState.currentSlug = response.current;

	// Removing the attached project returns to the session list.
	if (
		attachedProjectState.slug !== null &&
		!projects.some((p) => p.slug === attachedProjectState.slug)
	) {
		attachedProjectState.slug = null;
		replaceRoute("/?");
	}
}

/** Bind a project's new sessions to an instance. Applied locally first: the
 *  daemon replies only after rebuilding the project's relay (seconds), and a
 *  send in that gap must already land on the picked instance. */
export function bindProjectInstance(slug: string, instanceId: string): void {
	const current = projectState.projects.find(
		(p) => p.slug === slug,
	)?.instanceId;
	if (current === instanceId) return;
	const earlier = pendingPicks.get(slug);
	const pick = { instanceId, confirmed: earlier ? earlier.confirmed : current };
	pendingPicks.set(slug, pick);
	projectState.projects = withBinding(projectState.projects, slug, instanceId);
	// Re-aim this project's draft. A reused relay sends no shell resync, so
	// nothing else refetches the agents for the new harness.
	if (sessionState.currentId == null && getDraftProject() === slug) {
		selectInstance(instanceId);
		void getAgentsRpc({ projectSlug: slug, instanceId })
			.then(applyGetAgentsResponse)
			.catch(() => undefined);
	}
	// Only the newest pick settles the binding; an older reply is just a list.
	const settle = () => {
		const ours = pendingPicks.get(slug) === pick;
		if (ours) pendingPicks.delete(slug);
		return ours;
	};
	void setProjectInstanceRpc({ projectSlug: slug, slug, instanceId }).then(
		(reply) => {
			settle();
			applyProjectList(reply);
		},
		() => {
			if (settle())
				projectState.projects = withBinding(
					projectState.projects,
					slug,
					pick.confirmed,
				);
		},
	);
}

/** Asks once for all of them, then removes; resolves whether the user confirmed. */
export async function confirmRemoveProjects(
	slugs: readonly string[],
	returnFocus?: () => HTMLElement | null,
): Promise<boolean> {
	const [first] = slugs;
	if (first === undefined) return false;
	const title =
		projectState.projects.find((project) => project.slug === first)?.title ||
		first;
	const confirmed = await confirm(
		slugs.length === 1
			? `Remove project '${title}' from conduit?`
			: `Remove ${slugs.length} projects from conduit?`,
		"Remove",
		returnFocus,
	);
	if (!confirmed) return false;
	// Each RPC routes through a project's relay, so prefer one that survives;
	// only when every project goes does a removal route through itself.
	const router = [
		getCurrentSlug(),
		...projectState.projects.map((project) => project.slug),
	].find((slug) => slug != null && !slugs.includes(slug));
	// One at a time: each reply carries the whole project list, so concurrent
	// replies could land out of order and resurrect a removed project.
	void (async () => {
		for (const slug of slugs) {
			applyProjectList(
				await removeProjectRpc({ projectSlug: router ?? slug, slug }),
			);
		}
	})().catch(() => undefined);
	return true;
}

const toProjectInfoList = (
	projects: ProjectMutationResponse["projects"],
): ProjectInfo[] =>
	projects.map((project) => ({
		slug: project.slug,
		title: project.title,
		folders: project.folders,
		...(project.git != null ? { git: project.git } : {}),
		...(project.clientCount != null
			? { clientCount: project.clientCount }
			: {}),
		...(project.instanceId != null ? { instanceId: project.instanceId } : {}),
	}));

let followedConnection: string | null = null;
let generation = 0;
let fiber: RuntimeFiber<void, never> | null = null;

/**
 * Follow the daemon-global project and instance lists over `connection`'s
 * socket pair. The lists are the same on every pair; the argument only picks
 * the pair this tab already holds, so following never opens a second one.
 * `null` stops following.
 */
export function followDaemonLists(connection: string | null): void {
	if (followedConnection === connection) return;
	followedConnection = connection;
	const currentGeneration = ++generation;
	const old = fiber;
	fiber = null;
	const follow = <A extends object>(
		subscribe: () => Stream.Stream<A, WsRpcError>,
		apply: (list: A) => void,
	) =>
		Stream.runForEach(
			supervise(Stream.suspend(subscribe), () => undefined),
			(list) =>
				Effect.sync(() => {
					if (currentGeneration === generation) apply(list);
				}),
		);
	void (old ? runTransportEffect(Fiber.interrupt(old)) : Promise.resolve())
		.catch(() => undefined)
		.then(async () => {
			if (currentGeneration !== generation || connection === null) return;
			const runtime = await getRuntime();
			if (currentGeneration !== generation) return;
			const next = runtime.runFork(
				Effect.flatMap(WsRpcClients, (clients) =>
					Effect.flatMap(
						clients.forProject(connection),
						({ subscriptions, control }) =>
							Effect.all(
								[
									follow(subscriptions.projects, (list) => {
										applyProjectList(list);
										projectState.newSessionProject =
											list.newSessionProject ?? null;
									}),
									follow(subscriptions.instances, applyInstanceListResponse),
									Stream.runForEach(
										supervise(
											Stream.suspend(subscriptions.usage),
											() => undefined,
										),
										({ readings }) =>
											Effect.gen(function* () {
												if (currentGeneration !== generation) return;
												applyUsageReadings(readings);
												// Reload the shared order after reconnect and each snapshot.
												yield* control.GetUsageLimitsSetting({}).pipe(
													Effect.tap(({ usageLimits }) =>
														Effect.sync(() => {
															if (currentGeneration === generation)
																applyUsageLimitsSetting(usageLimits);
														}),
													),
													Effect.catchAll(() => Effect.void),
												);
											}),
									),
									follow(
										() => serverStatusFeed(subscriptions),
										applyServerStatus,
									),
								],
								{ concurrency: "unbounded", discard: true },
							),
					),
				),
			);
			if (currentGeneration === generation) fiber = next;
			else runtime.runFork(Fiber.interrupt(next));
		});
}
