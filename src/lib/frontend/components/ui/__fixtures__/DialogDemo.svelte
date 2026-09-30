<script lang="ts">
	import Dialog from "../Dialog.svelte";

	let { backdrop = "default" }: { backdrop?: "default" | "dark" | "subtle" } = $props();
</script>

<Dialog open onclose={() => {}} labelledBy="dialog-preview-title" {backdrop}>
	<div class="w-72 rounded-xl border border-border bg-bg-alt p-5 text-text shadow-modal">
		<h2 id="dialog-preview-title" class="text-base font-semibold">Dialog preview</h2>
		<p class="mt-2 text-sm text-text-secondary">The dialog and backdrop live in the browser top layer.</p>
		<button type="button" class="mt-4 rounded-md border border-border px-3 py-2">Continue</button>
	</div>
</Dialog>
