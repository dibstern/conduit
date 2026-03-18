<!-- ─── Step: Done ────────────────────────────────────────────────────────── -->
<!-- Final setup step showing success message.                                -->

<script lang="ts">
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
	<button
		class="inline-flex items-center justify-center gap-2 bg-accent text-bg no-underline px-6 py-3 rounded-xl font-semibold text-sm border-none cursor-pointer font-sans hover:opacity-90 transition-opacity"
		onclick={ongotodone}
	>
		Open OpenCode Relay
	</button>
</div>
