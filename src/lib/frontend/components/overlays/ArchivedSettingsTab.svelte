<script lang="ts">
	import { onMount } from "svelte";
	import { selection } from "../../stores/selection.svelte.js";
	import { failureLine } from "../../transport/rpc-errors.js";
	import { rpc } from "../../transport/ws-rpc-client.js";
	import type { SessionInfo } from "../../types.js";
	import { formatTimeAgo } from "../../utils/format.js";
	import { sessionCommandActions } from "../session/session-commands.js";
	import { getProjectLabel } from "../session/session-list-project.js";
	import Button from "../ui/Button.svelte";

	type ListRpc = typeof rpc<"ListArchivedSessions">;
	type Response = Awaited<ReturnType<ListRpc>>;
	let { load = rpc, onClose }: { load?: ListRpc; onClose?: (() => void) | undefined } = $props();
	let sessions = $state<SessionInfo[]>([]);
	let cursor = $state<Response["nextCursor"]>(null);
	let hasMore = $state(false);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let unavailable = $state<string[]>([]);
	let pending = $state<string[]>([]);

	const groups = $derived.by(() => {
		const byProject = new Map<string, { slug: string; label: string; rows: SessionInfo[] }>();
		const sorted = [...sessions].sort((a, b) =>
			(b.archivedAt ?? 0) - (a.archivedAt ?? 0) || b.id.localeCompare(a.id),
		);
		for (const session of sorted) {
			const slug = session.projectSlug ?? "";
			const group = byProject.get(slug);
			if (group) group.rows.push(session);
			else byProject.set(slug, { slug, label: getProjectLabel(session) || slug, rows: [session] });
		}
		return [...byProject.values()];
	});

	onMount(() => { void fetchPage(); });

	async function fetchPage(): Promise<void> {
		loading = true;
		error = null;
		try {
			const response = await load("ListArchivedSessions", {
				limit: 50,
				...(cursor ? { cursor } : {}),
			});
			const seen = new Set(sessions.map((session) => session.id));
			sessions = [...sessions, ...response.sessions.filter((session) => !seen.has(session.id))];
			cursor = response.nextCursor;
			hasMore = response.hasMore;
			unavailable = response.availability.filter((project) => !project.available).map((project) => project.projectSlug);
		} catch (cause) {
			error = failureLine(cause, "Couldn't load archived sessions");
		} finally {
			loading = false;
		}
	}

	async function act(session: SessionInfo, action: "unarchive" | "delete", origin: EventTarget | null): Promise<void> {
		pending = [...pending, session.id];
		try {
			const succeeded = action === "unarchive"
				? await sessionCommandActions.archive(session, false)
				: await sessionCommandActions.remove(session, () => origin instanceof HTMLElement ? origin : null);
			if (succeeded) sessions = sessions.filter((row) => row.id !== session.id);
		} finally {
			pending = pending.filter((id) => id !== session.id);
		}
	}

	function choose(session: SessionInfo): void {
		onClose?.();
		selection.open(session.id);
	}
</script>

<section aria-label="Archived sessions" class="min-w-0">
	<h3 class="text-[14px] font-semibold text-text">Archived sessions</h3>
	{#if error}
		<p role="alert" class="mt-3 text-error">{error}</p>
		<Button variant="secondary" size="sm" class="mt-2" disabled={loading} onclick={() => void fetchPage()}>Retry</Button>
	{/if}
	{#if unavailable.length > 0}
		<p role="status" class="mt-3 text-text-dimmer">Some projects are unavailable. Their archived sessions could not be loaded.</p>
	{/if}
	{#each groups as group (group.slug)}
		<div data-testid="archived-project-group" data-project-slug={group.slug} class="mt-4">
			<h4 class="mb-1 text-[11px] font-semibold text-text-dimmer">{group.label}</h4>
			{#each group.rows as session (session.id)}
				<div data-testid="archived-session-row" data-session-id={session.id} class="flex items-center gap-2 border-b border-border-subtle py-3">
					<div class="min-w-0 flex-1">
						<Button variant="ghost" size="content" layout="flow" tone="inherit" class="block max-w-full truncate text-left text-[12px] font-medium text-text" onclick={() => choose(session)}>{session.title || "New Session"}</Button>
						<p class="mt-1 text-[11px] text-text-dimmer">Archived {formatTimeAgo(session.archivedAt ?? undefined)} · Last active {formatTimeAgo(session.updatedAt)}</p>
					</div>
					<Button variant="secondary" size="sm" data-testid="archived-unarchive" disabled={pending.includes(session.id)} onclick={(event) => void act(session, "unarchive", event.currentTarget)}>Unarchive</Button>
					<Button variant="ghost" size="sm" tone="error" data-testid="archived-delete" disabled={pending.includes(session.id)} onclick={(event) => void act(session, "delete", event.currentTarget)}>Delete</Button>
				</div>
			{/each}
		</div>
	{/each}
	{#if loading}
		<p role="status" class="py-6 text-text-dimmer">Loading archived sessions…</p>
	{:else if !error && unavailable.length === 0 && sessions.length === 0}
		<div data-testid="archived-empty" class="py-8 text-center">
			<p class="text-[12px] font-medium text-text">No archived sessions</p>
			<p class="mt-1 text-text-dimmer">Archived sessions will appear here.</p>
		</div>
	{/if}
	{#if hasMore}
		<Button variant="secondary" size="sm" data-testid="archived-show-more" class="mt-4" disabled={loading} onclick={() => void fetchPage()}>Show more</Button>
	{/if}
</section>
