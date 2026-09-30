<script lang="ts">
	import Modal from "../ui/Modal.svelte";
	import { sessionViews, viewShortcutHint } from "../layout/session-views.js";
	import { globalKeyHint, sessionVerbKeys } from "./session-verbs.js";

	let { open, onclose }: { open: boolean; onclose: () => void } = $props();

	const sections = [
		{
			title: "Session list",
			shortcuts: [
				["j / k", "Next / previous session"],
				["Enter", "Open focused session"],
				["1–9 / 0", "Project scope / all projects"],
				["/", "Search sessions"],
				["⌘P", "Choose project scope"],
				["⌘K", "Search every session"],
			],
		},
		{
			title: "Focused row, or open session from the transcript",
			shortcuts: [
				[sessionVerbKeys.settle.key, "Settle / un-settle"],
				[sessionVerbKeys.snooze.key, "Snooze / unsnooze"],
				[sessionVerbKeys.pin.key, "Pin / unpin"],
				[sessionVerbKeys.read.key, "Mark read / unread"],
				[sessionVerbKeys.rename.key, "Rename"],
			],
		},
		{
			title: "Open session, from anywhere",
			shortcuts: [
				[globalKeyHint(sessionVerbKeys.settle.global), "Settle / un-settle"],
				[globalKeyHint(sessionVerbKeys.read.global), "Mark read / unread"],
				...sessionViews.map((view) => [viewShortcutHint(view), `${view.label} view`] as const),
			],
		},
		{
			title: "Anywhere",
			shortcuts: [
				["⌘Z", "Undo latest action"],
				["?", "Show keyboard shortcuts"],
				["Esc", "Close menu or sheet"],
			],
		},
	] as const;
</script>

{#snippet body()}
	<div data-testid="shortcut-sheet" class="flex flex-col gap-5 font-brand">
		{#each sections as { title, shortcuts } (title)}
			<section class="flex flex-col gap-2">
				<h3 class="text-xs text-text-muted">{title}</h3>
				<dl class="grid grid-cols-[4.5rem_1fr] gap-x-4 gap-y-1.5 text-sm">
					{#each shortcuts as [key, verb] (key)}
						<dt class="font-mono text-text whitespace-nowrap">{key}</dt>
						<dd class="text-text-secondary">{verb}</dd>
					{/each}
				</dl>
			</section>
		{/each}
	</div>
{/snippet}

<Modal {open} {onclose} title="Keyboard shortcuts" size="md" children={body} />
