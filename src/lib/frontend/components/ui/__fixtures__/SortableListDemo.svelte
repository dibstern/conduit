<script lang="ts">
	import SortableList from "../SortableList.svelte";

	let { disabled = false }: { disabled?: boolean | undefined } = $props();

	let accounts = $state([
		{ id: "work", name: "work2claude", left: "0% left" },
		{ id: "personal", name: "personal", left: "62% left" },
		{ id: "team", name: "team", left: "88% left" },
	]);
</script>

<div class="flex w-[320px] flex-col gap-3">
	<SortableList
		items={accounts}
		key={(account) => account.id}
		label={(account) => account.name}
		onreorder={(next) => (accounts = next)}
		ariaLabel="Account order"
		{disabled}
	>
		{#snippet row(account, index)}
			<span class="font-mono text-[10.5px] text-text-secondary">{index + 1}</span>
			<span class="min-w-0 flex-1 truncate">{account.name}</span>
			<span class="font-mono text-[10.5px] text-text-secondary">{account.left}</span>
		{/snippet}
	</SortableList>
	<output class="sr-only" data-testid="sortable-order">{accounts.map((account) => account.id).join(",")}</output>
</div>
