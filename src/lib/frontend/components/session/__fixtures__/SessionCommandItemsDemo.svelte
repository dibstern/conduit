<script lang="ts">
	import Menu from "../../ui/Menu.svelte";
	import SessionCommandItems from "../SessionCommandItems.svelte";
	import type { SessionCommandEntry } from "../session-commands.js";

	let { presentation = "menu" }: { presentation?: "menu" | "sheet" } = $props();
	const commands: readonly SessionCommandEntry[] = [
		{ testId: "command-demo-settle", label: "Settle", icon: "check", run: () => {} },
		{ testId: "command-demo-auto", label: "Auto-settle when idle", checked: true, run: () => {} },
		{ testId: "command-demo-snooze", label: "Snooze…", icon: "moon", run: () => {} },
		{ divider: true },
		{ testId: "command-demo-delete", label: "Delete", danger: true, run: () => {} },
	];
</script>

<Menu open presentation={presentation === "sheet" ? "sheet" : "popover"} ariaLabel="Session commands">
	{#snippet trigger({ props })}<button {...props} type="button">Session commands</button>{/snippet}
	<SessionCommandItems {commands} {presentation} onselect={(run) => run()} />
</Menu>
