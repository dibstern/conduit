<script lang="ts">
	import Toggle from "../ui/Toggle.svelte";
	import { featureFlags, toggleFeature } from "../../stores/feature-flags.svelte.js";
</script>

<Toggle
	label="Connection debug panel"
	description="Shows WebSocket state transitions, timing, and lifecycle events."
	checked={featureFlags.debug}
	onchange={() => toggleFeature("debug")}
/>
<p class="text-text-dimmer">URL param: <code class="px-1 py-0.5 bg-bg-alt rounded text-text-secondary">?feats=debug</code></p>
<p class="text-text-dimmer">Keyboard: <kbd class="px-1.5 py-0.5 bg-bg-alt rounded text-text-secondary border border-border-subtle">Ctrl+Shift+D</kbd></p>
