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
import { removeProjectRpc } from "../transport/ws-rpc-client.js";
import type { ProjectInfo } from "../types.js";
import { applyInstanceListResponse } from "./instance.svelte.js";
import {
	attachedProjectState,
	getCurrentSlug,
	replaceRoute,
} from "./router.svelte.js";
import { confirm } from "./ui.svelte.js";

// This store has no client half: the project list and the current slug both
// come from the server, and `applyProjectList` below is the only writer.

export const projectState = $state({
	projects: [] as ProjectInfo[],
	currentSlug: null as string | null,
});

/** Apply a full project list: the subscription's, or an RPC's reply. */
export function applyProjectList(
	response: Pick<ProjectMutationResponse, "projects" | "current">,
): void {
	const projects = toProjectInfoList(response.projects);
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
					Effect.flatMap(clients.forProject(connection), ({ subscriptions }) =>
						Effect.all(
							[
								follow(subscriptions.projects, applyProjectList),
								follow(subscriptions.instances, applyInstanceListResponse),
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
