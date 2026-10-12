<script lang="ts">
	import SettingsGroup from "../ui/SettingsGroup.svelte";
	import SettingsRow from "../ui/SettingsRow.svelte";
	import { featureFlags, toggleFeature } from "../../stores/feature-flags.svelte.js";
</script>

<SettingsGroup
	id="settings-advanced"
	title="Advanced"
	collapsible
	summary={featureFlags.debug ? "Debug on" : "Debug off"}
>
	<SettingsRow
		label="Connection debug panel"
		description="Also ?feats=debug or Ctrl+Shift+D. Shows WebSocket state transitions, timing, and lifecycle events."
		checked={featureFlags.debug}
		onchange={() => toggleFeature("debug")}
	/>
</SettingsGroup>
