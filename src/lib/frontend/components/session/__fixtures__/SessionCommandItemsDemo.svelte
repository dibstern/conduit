<script lang="ts">
	import Menu from "../../ui/Menu.svelte";
	import SessionCommandItems from "../SessionCommandItems.svelte";
	import type { SessionCommandEntry } from "../session-commands.js";

	const commands: readonly SessionCommandEntry[] = [
		{ testId: "command-demo-settle", section: "triage", label: "Settle", icon: "check", run: () => {} },
		{ testId: "command-demo-auto", section: "triage", label: "Auto-settle when idle", icon: "zap", checked: true, run: () => {} },
		{ testId: "command-demo-snooze", section: "triage", label: "Snooze…", icon: "moon", run: () => {} },
		{ testId: "command-demo-delete", section: "danger", label: "Delete", icon: "trash-2", danger: true, run: () => {} },
	];
</script>

<Menu open presentation="popover" ariaLabel="Session commands">
	{#snippet trigger({ props })}<button {...props} type="button">Session commands</button>{/snippet}
	<SessionCommandItems {commands} onselect={(run) => run()} />
</Menu>
