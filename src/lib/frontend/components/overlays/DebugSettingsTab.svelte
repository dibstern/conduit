<script lang="ts">
	import Toggle from "../ui/Toggle.svelte";
	import { featureFlags, toggleFeature } from "../../stores/feature-flags.svelte.js";
</script>

<div class="space-y-2">
	<Toggle
		label="Connection debug panel"
		description="Shows WebSocket state transitions, timing, and lifecycle events."
		checked={featureFlags.debug}
		onchange={() => toggleFeature("debug")}
		class="bg-bg-surface border border-border rounded-panel px-5 py-4 gap-4 font-brand"
	/>
	<div class="text-xs text-text-dimmer space-y-1.5 px-1 font-brand">
		<div>URL param: <code class="px-1 py-0.5 bg-white/[0.08] rounded text-text-muted">?feats=debug</code></div>
		<div>Keyboard: <kbd class="px-1.5 py-0.5 bg-white/[0.08] rounded text-text-muted border border-border/50">Ctrl+Shift+D</kbd></div>
	</div>
</div>
