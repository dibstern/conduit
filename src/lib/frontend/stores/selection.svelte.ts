// The route owns the open session; replies only place the id they answered.
import { untrack } from "svelte";
import { SvelteMap } from "svelte/reactivity";
import { effectiveWorkingDirectory } from "../../session/session-workspace.js";
import { getIsConnected } from "../transport/connection-status.svelte.js";
import { toastFailure } from "../transport/rpc-errors.js";
import { WsRpcError } from "../transport/ws-rpc.js";
import { rpc } from "../transport/ws-rpc-client.js";
import { handleInputSyncReceived } from "./chat.svelte.js";
import { getBrowserClientId } from "./client-identity.js";
import {
	applyGetFileTreeResponse,
	clearFileTreeState,
	fileTreeState,
	requestFileTree,
} from "./file-tree.svelte.js";
import { viewInputDraft } from "./input-draft.js";
import { getDraftProject, projectState } from "./project-state.svelte.js";
import {
	attachedProjectState,
	DRAFT_PROJECT_PARAM,
	getCurrentRoute,
	getCurrentSearchParams,
	getCurrentSessionId,
	navigate,
	replaceRoute,
	routerState,
} from "./router.svelte.js";
import { openSavedTranscript } from "./saved-transcripts.js";
import {
	findSession,
	followShownSession,
	getFilteredSessions,
	sessionState,
	setAttachedProject,
} from "./session.svelte.js";
import { viewFamily } from "./session-family-feed.js";
import { getSessionScope } from "./session-scope.js";
import { viewTodos } from "./todo.svelte.js";
import {
	drawSavedTranscript,
	leaveSavedDraw,
	placeSavedDraw,
	savedDraw,
	viewTranscript,
} from "./transcript.svelte.js";
import { closeFileViewer } from "./ui.svelte.js";

export type Shown =
	| { readonly kind: "none" }
	| { readonly kind: "draft"; readonly project: string | null }
	| { readonly kind: "drawn"; readonly sessionId: string }
	| { readonly kind: "placing"; readonly sessionId: string }
	| {
			readonly kind: "placed";
			readonly sessionId: string;
			readonly project: string;
	  }
	| { readonly kind: "missing"; readonly sessionId: string }
	| { readonly kind: "deleted"; readonly sessionId: string };

const placement = new SvelteMap<
	string,
	{ project: string } | "missing" | "deleted"
>();
const shown: Shown = $derived.by(() => {
	const route = getCurrentRoute();
	if (route.page !== "chat") return { kind: "none" };
	if (route.draft) return { kind: "draft", project: getDraftProject() };
	if (!route.sessionId) return { kind: "none" };
	const sessionId = route.sessionId;
	const placed = placement.get(sessionId);
	if (placed === "deleted" || placed === "missing")
		return { kind: placed, sessionId };
	const live =
		sessionState.liveSessions.get(sessionId) ??
		sessionState.familySessions.find((row) => row.id === sessionId);
	const project = live?.projectSlug ?? placed?.project;
	if (project) return { kind: "placed", sessionId, project };
	return {
		kind: savedDraw.sessionId === sessionId ? "drawn" : "placing",
		sessionId,
	};
});
const scope = $derived<{
	readonly project: string;
	readonly sessionId: string | null;
} | null>(
	shown.kind === "placed"
		? { project: shown.project, sessionId: shown.sessionId }
		: shown.kind === "draft" && shown.project
			? { project: shown.project, sessionId: null }
			: shown.kind === "none" &&
					getCurrentRoute().page === "chat" &&
					attachedProjectState.slug
				? {
						project: getDraftProject() ?? attachedProjectState.slug,
						sessionId: null,
					}
				: null,
);
const wantedProject = $derived.by(() => {
	if (shown.kind === "placed" || shown.kind === "draft") return shown.project;
	if (shown.kind === "none" && scope && getDraftProject() !== null)
		return scope.project;
	return getSessionScope();
});

export const selection = {
	open(sessionId: string): void {
		if (getCurrentSessionId() !== sessionId) navigate(`/s/${sessionId}`);
	},
	openDraft(project: string | null): void {
		const route = getCurrentRoute();
		const params = getCurrentSearchParams();
		if (project) params.set(DRAFT_PROJECT_PARAM, project);
		else params.delete(DRAFT_PROJECT_PARAM);
		const path = `/new${params.size ? `?${params}` : ""}`;
		if (route.page === "chat" && route.draft) replaceRoute(path);
		else navigate(path);
	},
	follow(
		from: typeof scope,
		sessionId: string,
		history: "push" | "replace",
	): void {
		if (!from) return;
		placement.set(sessionId, { project: from.project });
		if (scope?.project !== from.project || scope.sessionId !== from.sessionId)
			return;
		if (history === "replace") replaceRoute(`/s/${sessionId}`);
		else navigate(`/s/${sessionId}`);
	},
	get shown(): Shown {
		return shown;
	},
	get scope() {
		return scope;
	},
};

/** Called only for a confirmed deletion, including a deletion in another tab. */
export function markSessionDeleted(sessionId: string): void {
	placement.set(sessionId, "deleted");
}

/** The shell owns this lifecycle, as it does catalog and subscription lifetimes. */
export function watchSelection(): () => void {
	return $effect.root(() => {
		let alive = true;
		const attaching = new Set<string>();
		const resolving = new Set<string>();
		let attachedOnce = attachedProjectState.slug !== null;
		let previousAttached = attachedProjectState.slug;
		const loadSessionId = getCurrentSessionId();
		if (loadSessionId)
			void openSavedTranscript(loadSessionId).then((record) => {
				if (
					alive &&
					record &&
					getCurrentSessionId() === loadSessionId &&
					shown.kind === "placing"
				)
					drawSavedTranscript(record);
			});
		$effect(() => () => {
			alive = false;
		});

		// A live row continues to place its id after that row leaves the current feed.
		$effect(() => {
			const rows = [
				...sessionState.liveSessions.values(),
				...sessionState.familySessions,
			];
			untrack(() => {
				for (const row of rows) {
					const held = placement.get(row.id);
					if (
						held !== "deleted" &&
						(typeof held !== "object" || held.project !== row.projectSlug)
					)
						placement.set(row.id, { project: row.projectSlug });
				}
			});
		});
		$effect(() => {
			const current = shown;
			untrack(() => {
				if (current.kind === "missing") {
					placeSavedDraw(current.sessionId, null);
					routerState.sessionNotFound = true;
					replaceRoute("/");
				} else if (current.kind === "deleted") {
					placeSavedDraw(current.sessionId, null);
					const next = getFilteredSessions().find(
						(row) => row.id !== current.sessionId,
					);
					replaceRoute(next ? `/s/${next.id}` : "/");
				}
			});
		});
		$effect(() => {
			const current = shown;
			const routeId = getCurrentSessionId();
			untrack(() => {
				leaveSavedDraw(routeId ?? undefined);
				if (
					current.kind === "placed" &&
					placeSavedDraw(current.sessionId, current.project)
				)
					followShownSession(current.sessionId, null);
				else if (current.kind === "missing" || current.kind === "deleted")
					placeSavedDraw(current.sessionId, null);
			});
		});
		let previousId: string | null = null;
		const currentId = $derived(
			shown.kind === "placed" ||
				shown.kind === "placing" ||
				shown.kind === "drawn"
				? shown.sessionId
				: null,
		);
		$effect(() => {
			const id = currentId;
			untrack(() => followShownSession(id, previousId));
			previousId = id;
		});

		$effect(() => {
			const wanted = wantedProject;
			const attached = attachedProjectState.slug;
			const current = shown;
			const route = getCurrentRoute();
			const connected = getIsConnected();
			untrack(() => {
				if (previousAttached !== null && attached === null)
					attachedOnce = false;
				previousAttached = attached;
				if (!connected || route.page !== "chat") return;
				const sessionId =
					current.kind === "placing" || current.kind === "drawn"
						? current.sessionId
						: null;
				if (
					(wanted !== null && wanted !== attached) ||
					(!attachedOnce && attached === null)
				) {
					const key = JSON.stringify([wanted, sessionId]);
					if (attaching.has(key)) return;
					attaching.add(key);
					void rpc("AttachProject", {
						originId: getBrowserClientId(),
						...(sessionId
							? { sessionId }
							: wanted
								? { projectSlug: wanted }
								: {}),
					})
						.then(({ projectSlug, sessionSlug }) => {
							if (!alive) return;
							// Place only this reply's id; a delete always wins over a late reply.
							const matches =
								wantedProject === wanted &&
								(!sessionId || getCurrentSessionId() === sessionId);
							if (sessionId && placement.get(sessionId) !== "deleted")
								placement.set(
									sessionId,
									sessionSlug ? { project: sessionSlug } : "missing",
								);
							if (!matches) return;
							attachedOnce = true;
							if (projectSlug !== null) setAttachedProject(projectSlug);
						})
						.catch((error: unknown) => {
							if (!alive) return;
							if (
								sessionId &&
								error instanceof WsRpcError &&
								error.code === "unknown-session"
							) {
								if (placement.get(sessionId) !== "deleted")
									placement.set(sessionId, "missing");
							} else if (
								wantedProject === wanted &&
								(!sessionId || getCurrentSessionId() === sessionId)
							)
								toastFailure("Failed to switch projects")(error);
						})
						.finally(() => attaching.delete(key));
					return;
				}
				if (!sessionId || resolving.has(sessionId)) return;
				resolving.add(sessionId);
				void rpc("ResolveSession", { sessionId })
					.then(({ projectSlug }) => {
						if (alive && placement.get(sessionId) !== "deleted")
							placement.set(
								sessionId,
								projectSlug ? { project: projectSlug } : "missing",
							);
					})
					.catch((error: unknown) => {
						if (!alive) return;
						if (
							error instanceof WsRpcError &&
							error.code === "unknown-session"
						) {
							if (placement.get(sessionId) !== "deleted")
								placement.set(sessionId, "missing");
						} else {
							resolving.delete(sessionId);
							if (getCurrentSessionId() === sessionId)
								toastFailure("Failed to open session")(error);
						}
					});
			});
		});
		const placedKey = $derived(
			shown.kind === "placed"
				? JSON.stringify([shown.sessionId, shown.project])
				: null,
		);
		$effect(() => {
			const key = placedKey;
			let viewing = true;
			untrack(() => {
				if (!key || shown.kind !== "placed") return;
				const current = shown;
				void rpc("ViewSession", {
					sessionId: current.sessionId,
					originId: getBrowserClientId(),
				})
					.then(({ draft }) => {
						if (
							alive &&
							viewing &&
							draft !== undefined &&
							shown.kind === "placed" &&
							shown.sessionId === current.sessionId &&
							shown.project === current.project
						)
							handleInputSyncReceived({ text: draft });
					})
					.catch(toastFailure("Failed to open session"));
			});
			return () => {
				viewing = false;
			};
		});
		let feedKey: string | null | undefined;
		const feedScopeKey = $derived(
			shown.kind === "placed" && shown.project === attachedProjectState.slug
				? placedKey
				: null,
		);
		$effect(() => {
			const key = feedScopeKey;
			if (key === feedKey) return;
			feedKey = key;
			untrack(() => {
				const current = shown;
				const project = key && current.kind === "placed" ? current.project : "";
				const id = key && current.kind === "placed" ? current.sessionId : null;
				viewTranscript(project, id);
				viewTodos(project, id);
				viewInputDraft(project, id);
				viewFamily(project, id);
			});
		});
		$effect(() => () => {
			viewTranscript("", null);
			viewTodos("", null);
			viewInputDraft("", null);
			viewFamily("", null);
		});

		const fileScope = $derived.by(() => {
			if (!scope) return null;
			const session = scope.sessionId
				? findSession(scope.sessionId)
				: undefined;
			const folders =
				projectState.projects.find((project) => project.slug === scope.project)
					?.folders ?? [];
			const directory = effectiveWorkingDirectory(
				folders[0] ?? "",
				session?.workspace,
			);
			return {
				...scope,
				key: JSON.stringify([
					scope.project,
					scope.sessionId,
					directory,
					folders,
					session?.workspace,
				]),
			};
		});
		const fileKey = $derived(
			fileScope?.project === attachedProjectState.slug ? fileScope.key : null,
		);
		$effect(() => {
			const key = fileKey;
			const connected = getIsConnected();
			untrack(() => {
				const current = fileScope;
				if (!key || !current) {
					clearFileTreeState();
					return;
				}
				if (!connected) return;
				if (fileTreeState.scope !== current.key) {
					clearFileTreeState();
					fileTreeState.scope = current.key;
					closeFileViewer();
				}
				requestFileTree();
				void rpc(
					"GetFileTree",
					current.sessionId
						? { sessionId: current.sessionId }
						: { projectSlug: current.project },
				)
					.then((response) => {
						if (alive) applyGetFileTreeResponse(response, current.key);
					})
					.catch((error: unknown) => {
						if (
							alive &&
							getIsConnected() &&
							fileTreeState.scope === current.key
						) {
							fileTreeState.loading = false;
							toastFailure("Failed to load file tree")(error);
						}
					});
			});
		});
	});
}
