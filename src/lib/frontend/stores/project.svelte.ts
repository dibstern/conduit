// Manages the list of registered projects and the current project slug.

import { Effect, Fiber, Stream } from "effect";
import type { RuntimeFiber } from "effect/Fiber";
import type { ShellEnvelope } from "../../contracts/ws-rpc.js";
import { getRuntime, runTransportEffect } from "../transport/runtime.js";
import { WsRpcClients } from "../transport/shared-client.js";
import { supervise } from "../transport/supervise.js";
import type {
	ProjectMutationResponse,
	WsRpcError,
} from "../transport/ws-rpc.js";
import { rpc } from "../transport/ws-rpc-client.js";
import type { ProjectInfo } from "../types.js";
import { applyInstanceListResponse } from "./instance.svelte.js";
import { projectState } from "./project-state.svelte.js";
import {
	attachedProjectState,
	getCurrentSlug,
	replaceRoute,
} from "./router.svelte.js";
import { applyServerStatus, serverStatusFeed } from "./server-status.svelte.js";
import { confirm } from "./ui.svelte.js";
import { applyUsageLimitsSetting, applyUsageReadings } from "./usage.svelte.js";

export { getDraftProject, projectState } from "./project-state.svelte.js";

/** Project mutation replies only update the attached project hint. */
export function applyProjectList(
	response: Pick<ProjectMutationResponse, "projects" | "current">,
): void {
	if (response.current != null) projectState.currentSlug = response.current;
}

/** The shell feed owns the registered project list. */
export function applyShellProjects(
	frame: Extract<ShellEnvelope, { readonly _tag: "projects" }>,
): void {
	const projects = toProjectInfoList(frame.projects);
	projectState.projects = projects;
	projectState.newSessionProject = frame.newSessionProject ?? null;

	// Removing the attached project returns to the session list.
	if (
		attachedProjectState.slug !== null &&
		!projects.some((p) => p.slug === attachedProjectState.slug)
	) {
		attachedProjectState.slug = null;
		replaceRoute("/?");
	}
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
	// Remove one at a time so a later request cannot route through a project
	// whose removal is still in flight.
	void (async () => {
		for (const slug of slugs) {
			applyProjectList(
				await rpc("RemoveProject", { projectSlug: router ?? slug, slug }),
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
		...(project.setupScript !== undefined
			? { setupScript: project.setupScript }
			: {}),
		...(project.sessionMode !== undefined
			? { sessionMode: project.sessionMode }
			: {}),
		...(project.repositoryIdentities != null
			? { repositoryIdentities: project.repositoryIdentities }
			: {}),
		...(project.git != null ? { git: project.git } : {}),
		...(project.missing !== undefined ? { missing: project.missing } : {}),
		...(project.unavailableReason !== undefined
			? { unavailableReason: project.unavailableReason }
			: {}),
		...(project.clientCount != null
			? { clientCount: project.clientCount }
			: {}),
	}));

let following = false;
let generation = 0;
let fiber: RuntimeFiber<void, never> | null = null;

/**
 * Follow the daemon-global instance, usage and status lists over the
 * tab's one socket pair. None is project-scoped, so a project switch must not
 * re-follow: each new usage subscription re-reads every account's limits.
 */
export function followDaemonLists(on: boolean): void {
	if (following === on) return;
	following = on;
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
			if (currentGeneration !== generation || !on) return;
			const runtime = await getRuntime();
			if (currentGeneration !== generation) return;
			const next = runtime.runFork(
				Effect.flatMap(WsRpcClients, (clients) =>
					Effect.flatMap(clients.forProject(""), ({ subscriptions, control }) =>
						Effect.all(
							[
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
											yield* control("GetUsageLimitsSetting", {}).pipe(
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
