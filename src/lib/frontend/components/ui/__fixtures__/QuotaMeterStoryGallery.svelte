<script lang="ts">
	import type { ComponentProps } from "svelte";
	// biome-ignore lint/style/useImportType: used as a component in the markup
	import QuotaMeter from "../QuotaMeter.svelte";

	// Accepts (and ignores) QuotaMeter's props so Storybook can type the story's
	// render fn against the meta component.
	let { ..._meterProps }: ComponentProps<typeof QuotaMeter> = $props();

	const rows: { label: string; props: ComponentProps<typeof QuotaMeter> }[] = [
		{ label: "23% used", props: { used: 23 } },
		{ label: "79% used", props: { used: 79 } },
		{ label: "80% used, amber", props: { used: 80 } },
		{ label: "96% used, amber", props: { used: 96 } },
		{ label: "100% used, red", props: { used: 100, caption: "limited · Mon 9:00" } },
		{ label: "checking", props: { used: "checking" } },
		{ label: "unknown", props: { used: "unknown" } },
	];
	const sizes = ["sm", "md", "lg"] as const;
</script>

<!-- One block per track width; they sit side by side where there is room and
     stack on a phone. -->
<div class="flex flex-wrap gap-x-10 gap-y-6 text-[11.5px] text-text-secondary">
	{#each sizes as size (size)}
		<section class="grid grid-cols-[max-content_max-content] items-center gap-x-4 gap-y-3">
			<h3 class="col-span-2 font-mono text-[10px] text-text-dimmer">size="{size}"</h3>
			{#each rows as row (row.label)}
				<span>{row.label}</span>
				<QuotaMeter {...row.props} {size} />
			{/each}
		</section>
	{/each}
	<section class="grid grid-cols-[max-content_max-content] items-center gap-x-4 gap-y-3 self-start">
		<h3 class="col-span-2 font-mono text-[10px] text-text-dimmer">track=&#123;false&#125;</h3>
		<span>caption only</span>
		<QuotaMeter used={23} track={false} />
	</section>
</div>
