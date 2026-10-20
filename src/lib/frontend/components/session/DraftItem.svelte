<script lang="ts">
	import type { DraftListItem } from "../../types.js";
	import Button from "../ui/Button.svelte";
	import Icon from "../ui/Icon.svelte";
	import ProjectSquare from "./ProjectSquare.svelte";

	let { draft, href, projectLabel, projectAccent = 1, active = false, now = Date.now(), onopen, ondiscard }: {
		draft: DraftListItem;
		href: string;
		projectLabel: string;
		projectAccent?: number;
		active?: boolean;
		now?: number;
		onopen?: () => void;
		ondiscard?: () => void;
	} = $props();
	const title = $derived(draft.firstLine.trim() || "Untitled draft");
	// Compact age ("2m", "1h", "3d") so the time fits the title line beside a long draft.
	const age = $derived.by(() => {
		const minutes = Math.floor((now - draft.updatedAt) / 60_000);
		if (minutes < 1) return "now";
		if (minutes < 60) return `${minutes}m`;
		const hours = Math.floor(minutes / 60);
		return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
	});
</script>

<!-- The discard button can't nest inside the link, so it overlays the time slot: the row keeps the
     full tray width, and on fine pointers the trash replaces the time on hover, as session rows do. -->
<div class="group relative" data-testid="draft-row" data-draft-id={draft.draftId}>
	<Button
		{href} variant="ghost" size="content" layout="flow" hoverFill="none"
		class="grid w-full grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-x-[10px] gap-y-px rounded-panel px-[8px] py-[6px] pointer-coarse:pr-[44px] min-h-[44px] font-brand leading-[1.4] group-hover:bg-sidebar-hover {active ? 'bg-sidebar-active' : ''}"
		ariaLabel="Draft: {title}, {projectLabel}, {age}" aria-current={active ? "page" : undefined}
		onclick={(event) => {
			if (!onopen || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
			event.preventDefault();
			onopen();
		}}
	>
		<span class="grid place-items-center text-text-dimmer"><Icon name="pencil-line" size={13} /></span>
		<span class="truncate text-[13.5px] italic text-text-muted" title={title}>{title}</span>
		<span class="font-mono text-[11px] tabular-nums text-text-dimmer pointer-fine:group-hover:invisible pointer-fine:group-focus-within:invisible">{age}</span>
		<span class="col-span-2 col-start-2 flex min-w-0 items-center gap-[5px] text-[11.5px] text-text-dimmer">
			<ProjectSquare label={projectLabel} accent={projectAccent} dot />
			<span class="truncate">{projectLabel}</span>
		</span>
	</Button>
	<Button
		variant="ghost" size="content" iconOnly tone="inherit" hoverFill="none" icon="trash-2" iconSize={13} ariaLabel="Discard draft" data-testid="draft-row-discard"
		class="absolute right-0 top-1/2 size-[44px] -translate-y-1/2 rounded-[6px] text-text-muted hover:bg-sidebar-active hover:text-error pointer-fine:right-[6px] pointer-fine:top-[5px] pointer-fine:size-[22px] pointer-fine:translate-y-0 pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:group-focus-within:opacity-100"
		onclick={() => ondiscard?.()}
	/>
</div>
