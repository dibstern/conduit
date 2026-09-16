<script lang="ts">
	import type { ComponentProps } from "svelte";
	import Disclosure from "../Disclosure.svelte";

	// Storybook passes the meta-level args down to the gallery; absorb and
	// discard them so the gallery controls every row itself.
	type DisclosureStoryGalleryProps = ComponentProps<
		typeof import("../Disclosure.svelte").default
	>;

	let {
		children: _children,
		..._disclosureProps
	}: DisclosureStoryGalleryProps = $props();

	const densities = ["default", "compact", "tight"] as const;

	// Rows are rendered in both states side by side so the chevron rotation and
	// the three vertical rhythms are all comparable in one baseline.
	let expanded = $state<Record<string, boolean>>({
		"default-open": true,
		"compact-open": true,
		"tight-open": true,
		"nochevron-open": true,
	});
</script>

<div class="flex flex-col gap-4 bg-bg-surface rounded-panel p-3 max-w-[520px]">
	{#each densities as density}
		{#each [false, true] as open}
			{@const key = `${density}-${open ? "open" : "closed"}`}
			<Disclosure
				expanded={expanded[key] ?? false}
				onToggle={() => (expanded[key] = !expanded[key])}
				{density}
			>
				<span class="font-medium">{density}</span>
				<span>· {open ? "expanded" : "collapsed"}</span>
				<span class="flex-1"></span>
			</Disclosure>
		{/each}
	{/each}

	<Disclosure
		expanded={expanded["nochevron-open"] ?? false}
		onToggle={() =>
			(expanded["nochevron-open"] = !expanded["nochevron-open"])}
		chevron={false}
	>
		<span class="font-mono text-border text-xs shrink-0 w-3 text-center">
			└
		</span>
		<span class="font-medium">chevron={false}</span>
		<span class="flex-1"></span>
	</Disclosure>
</div>
