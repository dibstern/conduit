<!--
  The open session's live dev servers, as the daemon's PortWatcher last saw
  them. Open is a plain localhost link: right only when the browser runs on the
  daemon's host, until the Preview Gate (32.33.9) replaces it. Stop asks first,
  then reads "Stopping…" until the next scan's server_gone removes the row.
-->
<script lang="ts">
	import { clock } from "../../stores/clock.svelte.js";
	import { findSession, sessionState } from "../../stores/session.svelte.js";
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import { confirm, showToast } from "../../stores/ui.svelte.js";
	import { failureLine } from "../../transport/rpc-errors.js";
	import { rpc } from "../../transport/ws-rpc-client.js";
	import type { SessionServer } from "../../../shared-types.js";
	import { copyToClipboard } from "../../utils/clipboard.js";
	import { currentServers } from "../layout/session-views.js";
	import Button from "../ui/Button.svelte";
	import Icon from "../ui/Icon.svelte";
	import { taskAge } from "./background-tasks.svelte.js";

	const { visible = true }: { pane?: boolean; onClose?: () => void; visible?: boolean } = $props();
	const servers = $derived(currentServers());
	// The background task each linked server writes to (8.7), by task id.
	const tasks = $derived(new Map((findSession(sessionState.currentId ?? "")?.backgroundTasks ?? []).map((task) => [task.id, task.description])));
	// Reading the clock ticks it every second, so a hidden pane leaves it alone.
	const now = $derived(visible ? clock.now : 0);
	// Past interpreters and flags to the program: `node .bin/vite --port 5173` reads vite.
	const INTERPRETERS = new Set(["node", "bun", "deno", "python", "python3", "ruby", "sh", "bash"]);
	const nameOf = (command: string) => {
		const programs = command.split(/\s+/).map((token) => token.split("/").at(-1) ?? token);
		return programs.find((program) => program && !program.startsWith("-") && !INTERPRETERS.has(program)) ?? programs[0] ?? command;
	};

	// Each server's Stop by `pid:startedAt:port`: in flight, or the failure it ended with.
	const stops = $state<Record<string, { failure?: string }>>({});
	async function stop(server: SessionServer, name: string, trigger: EventTarget | null) {
		const sessionId = sessionState.currentId;
		if (!sessionId || !(await confirm(`Stop ${name} on port ${server.port}?`, "Stop", () => (trigger instanceof HTMLElement ? trigger : null)))) return;
		const key = `${server.pid}:${server.startedAt}:${server.port}`;
		stops[key] = {};
		try {
			await rpc("StopServer", { sessionId, server: { pid: server.pid, startedAt: server.startedAt, port: server.port } });
		} catch (error) {
			stops[key] = { failure: failureLine(error, `Could not stop ${name}`) };
		}
	}

	async function copyLink(link: string) {
		if (await copyToClipboard(link)) showToast("Link copied");
		else showToast("Failed to copy", { variant: "error" });
	}
</script>

<div data-testid="session-servers" class="flex min-h-0 flex-1 flex-col overflow-y-auto">
	{#if servers.length === 0}
		<p class="m-0 px-4 py-8 text-center text-sm text-text-dimmer">No servers running</p>
	{:else}
		<ul class="m-0 list-none p-0">
			{#each servers as server (server.port)}
				{@const name = nameOf(server.command)}
				{@const link = `http://localhost:${server.port}`}
				{@const stopState = stops[`${server.pid}:${server.startedAt}:${server.port}`]}
				{@const stopping = stopState !== undefined && stopState.failure === undefined}
				{@const task = server.taskId === undefined ? undefined : tasks.get(server.taskId)}
				<li data-testid="session-server" class="flex flex-col gap-1 border-b border-border-subtle px-3 py-2.5 text-text">
					<!-- Phones give the actions their own row of thumb-sized buttons. -->
					<div class="flex min-w-0 flex-wrap items-center gap-2">
						<Icon name="globe" size={14} class="shrink-0 text-accent" />
						<span data-testid="session-server-name" class="min-w-0 truncate font-medium">{name}</span>
						<span data-testid="session-server-port" class="font-mono text-xs text-text-muted">:{server.port}</span>
						<span class="flex-1"></span>
						<div class="flex gap-2 {sessionViewState.compact ? 'order-last basis-full *:min-h-[44px] *:flex-1' : ''}">
							<Button href={link} target="_blank" rel="noopener noreferrer" variant="secondary" size="sm" icon="external-link" ariaLabel={`Open ${name} at ${link}`}>Open</Button>
							<Button variant="secondary" size="sm" icon="copy" ariaLabel={`Copy link to ${name}`} onclick={() => copyLink(link)}>Copy link</Button>
							<Button variant="secondary" size="sm" icon="square" iconSize={9} data-testid="session-server-stop" ariaLabel={`Stop ${name}`} loading={stopping} onclick={(event) => stop(server, name, event.currentTarget)}>{stopping ? "Stopping…" : "Stop"}</Button>
						</div>
					</div>
					<code data-testid="session-server-command" title={server.command} class="min-w-0 truncate font-mono text-[11px] text-text-secondary">{server.command}</code>
					<small class="flex min-w-0 items-center gap-1 text-[11px] text-text-muted">
						<span class="min-w-0 truncate font-mono">{link}</span>
						<span aria-hidden="true">·</span>
						<span data-testid="session-server-uptime" class="shrink-0">{taskAge({ firstSeenAt: server.startedAt }, now)}</span>
						<span aria-hidden="true">·</span>
						<span data-testid="session-server-source" class="shrink-0">{server.source === "declared" ? "marked by the agent" : "detected"}</span>
						{#if task !== undefined}
							<span aria-hidden="true">·</span>
							<span data-testid="session-server-task" title={task} class="min-w-0 truncate">{task}</span>
						{/if}
					</small>
					{#if stopState?.failure}
						<p data-testid="session-server-stop-error" role="alert" class="m-0 text-[11px] text-status-red">{stopState.failure}</p>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</div>
