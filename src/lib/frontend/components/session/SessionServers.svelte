<!--
  The open session's live dev servers, as the daemon's PortWatcher last saw
  them. Open is a plain localhost link: right only when the browser runs on the
  daemon's host, until the Preview Gate (32.33.9) replaces it.
-->
<script lang="ts">
	import { clock } from "../../stores/clock.svelte.js";
	import { showToast } from "../../stores/ui.svelte.js";
	import { copyToClipboard } from "../../utils/clipboard.js";
	import { currentServers } from "../layout/session-views.js";
	import Button from "../ui/Button.svelte";
	import Icon from "../ui/Icon.svelte";
	import { taskAge } from "./background-tasks.svelte.js";

	const { visible = true }: { pane?: boolean; onClose?: () => void; visible?: boolean } = $props();
	const servers = $derived(currentServers());
	// Reading the clock ticks it every second, so a hidden pane leaves it alone.
	const now = $derived(visible ? clock.now : 0);
	// Past interpreters and flags to the program: `node .bin/vite --port 5173` reads vite.
	const INTERPRETERS = new Set(["node", "bun", "deno", "python", "python3", "ruby", "sh", "bash"]);
	const nameOf = (command: string) => {
		const programs = command.split(/\s+/).map((token) => token.split("/").at(-1) ?? token);
		return programs.find((program) => program && !program.startsWith("-") && !INTERPRETERS.has(program)) ?? programs[0] ?? command;
	};

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
				<li data-testid="session-server" class="flex flex-col gap-1 border-b border-border-subtle px-3 py-2.5 text-text">
					<div class="flex min-w-0 items-center gap-2">
						<Icon name="globe" size={14} class="shrink-0 text-accent" />
						<span data-testid="session-server-name" class="min-w-0 truncate font-medium">{name}</span>
						<span data-testid="session-server-port" class="font-mono text-xs text-text-muted">:{server.port}</span>
						<span class="flex-1"></span>
						<Button href={link} target="_blank" rel="noopener noreferrer" variant="secondary" size="sm" icon="external-link" ariaLabel={`Open ${name} at ${link}`}>Open</Button>
						<Button variant="secondary" size="sm" icon="copy" ariaLabel={`Copy link to ${name}`} onclick={() => copyLink(link)}>Copy link</Button>
					</div>
					<code data-testid="session-server-command" title={server.command} class="min-w-0 truncate font-mono text-[11px] text-text-secondary">{server.command}</code>
					<small class="flex min-w-0 items-center gap-1 text-[11px] text-text-muted">
						<span class="min-w-0 truncate font-mono">{link}</span>
						<span aria-hidden="true">·</span>
						<span data-testid="session-server-uptime" class="shrink-0">{taskAge({ firstSeenAt: server.startedAt }, now)}</span>
						<span aria-hidden="true">·</span>
						<span data-testid="session-server-source" class="shrink-0">{server.source === "declared" ? "marked by the agent" : "detected"}</span>
					</small>
				</li>
			{/each}
		</ul>
	{/if}
</div>
