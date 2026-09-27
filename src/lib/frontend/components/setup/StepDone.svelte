<!-- ─── Step: Done ────────────────────────────────────────────────────────── -->
<!-- Final setup step showing success message.                                -->

<script lang="ts">
	import Button from "../ui/Button.svelte";

	let {
		ongotodone,
	}: {
		ongotodone: () => void;
	} = $props();
</script>

<div class="animate-fadeIn text-center py-10">
	<div class="text-5xl mb-4">&#10003;</div>
	<div class="text-xl font-semibold mb-2">All set!</div>
	<div class="text-sm text-text-muted mb-6">
		Your device is configured. You can change these settings anytime from
		the app.
	</div>
	<Button
		variant="primary"
		size="content"
		class="gap-2 no-underline px-6 py-3 rounded-xl font-semibold text-sm font-sans"
		onclick={ongotodone}
	>
		Open Conduit
	</Button>
</div>
