<script lang="ts">
	import type { ComponentProps } from "svelte";
	import Badge from "../Badge.svelte";

	// Accepts (and ignores) Badge's props so Storybook can type the story's
	// render fn against the meta component.
	let {
		children: _children,
		..._badgeProps
	}: ComponentProps<typeof Badge> = $props();

	const rows = [
		{
			label: "neutral / rounded",
			variant: "neutral",
			shape: "rounded",
		},
		{ label: "accent / pill", variant: "accent", shape: "pill" },
		{
			label: "accent-solid / pill",
			variant: "accent-solid",
			shape: "pill",
		},
		{ label: "tag / rounded", variant: "tag", shape: "rounded" },
		{ label: "tag / pill", variant: "tag", shape: "pill" },
	] as const;

	const sizes = ["xs", "sm"] as const;
</script>

<div class="flex flex-col gap-3">
	{#each rows as row}
		<div class="flex flex-wrap items-center gap-3">
			{#each sizes as size}
				<Badge variant={row.variant} shape={row.shape} {size}>
					{row.label} {size}
				</Badge>
			{/each}
		</div>
	{/each}
	<div class="flex flex-wrap items-center gap-3">
		<Badge variant="accent-solid" size="count" shape="pill">3</Badge>
		<Badge variant="accent-solid" size="count" shape="pill">12</Badge>
		<Badge variant="tag" size="sm" shape="rounded" class="font-mono">
			font-mono
		</Badge>
	</div>
</div>
