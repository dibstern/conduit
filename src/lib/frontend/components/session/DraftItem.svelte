<script lang="ts">
	import type { DraftListItem } from "../../types.js";
	import Button from "../ui/Button.svelte";
	import DraftPencil from "./DraftPencil.svelte";
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

<!-- Keep the link full width and overlay the separate discard button on its time slot. -->
<div class="group relative" data-testid="draft-row" data-draft-id={draft.draftId}>
	<Button
		{href} variant="ghost" size="content" layout="flow" hoverFill="none"
		class="grid w-full grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-x-[10px] gap-y-px rounded-panel px-[8px] py-[6px] min-h-[44px] font-sans leading-[1.4] {active ? 'bg-sidebar-active' : 'group-hover:bg-hover'}"
		ariaLabel="Draft: {title}, {projectLabel}, {age}" aria-current={active ? "page" : undefined}
		onclick={(event) => {
			if (!onopen || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
			event.preventDefault();
			onopen();
		}}
	>
		<span class="grid place-items-center text-text-dimmer"><DraftPencil /></span>
		<span class="min-w-0 truncate text-[13.5px] font-normal italic text-text-muted" title={title}>{title}</span>
		<span class="font-mono text-mono-xs whitespace-nowrap text-text-dimmer pointer-coarse:invisible pointer-coarse:min-w-[36px] pointer-fine:group-hover:invisible pointer-fine:group-focus-within:invisible">{age}</span>
		<span class="col-span-2 col-start-2 flex min-w-0 items-center gap-[5px] text-[11.5px] text-text-dimmer pointer-coarse:pr-[36px]">
			<ProjectSquare label={projectLabel} accent={projectAccent} dot />
			<span class="truncate">{projectLabel}</span>
		</span>
	</Button>
	<Button
		variant="ghost" size="content" iconOnly tone="inherit" hoverFill="none" icon="trash" iconSize={13} ariaLabel="Discard draft" data-testid="draft-row-discard"
		class="absolute right-0 top-1/2 size-[44px] -translate-y-1/2 rounded-[6px] text-text-muted hover:bg-sidebar-hover hover:text-error pointer-fine:right-[8px] pointer-fine:top-[6px] pointer-fine:size-[22px] pointer-fine:translate-y-0 pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:group-focus-within:opacity-100"
		onclick={() => ondiscard?.()}
	/>
</div>
