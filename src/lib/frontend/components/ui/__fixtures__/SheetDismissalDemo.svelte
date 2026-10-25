<script lang="ts">
	import Dialog from "../Dialog.svelte";
	import SheetChrome from "../SheetChrome.svelte";

	let { backdrop = "default" }: { backdrop?: "default" | "dark" | "subtle" } = $props();
	let open = $state(true);
	let saving = $state(false);
</script>

<Dialog {open} {backdrop} onclose={() => { open = false; }} placement="sheet" dismissible={!saving} ariaLabel="Sheet form">
	<SheetChrome bodyClass="p-4">
		<label class="flex flex-col gap-2 text-text">Draft<input aria-label="Draft" class="rounded border border-border bg-bg p-2 text-text" /></label>
		<button type="button" data-testid="sheet-save-toggle" aria-pressed={saving} class="mt-4 rounded border border-border px-4 py-2 text-text" onclick={() => { saving = !saving; }}>Toggle saving</button>
	</SheetChrome>
</Dialog>
