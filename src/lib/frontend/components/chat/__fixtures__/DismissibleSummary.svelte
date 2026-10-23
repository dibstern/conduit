<script lang="ts">
	import type { ComponentProps } from "svelte";
	import Button from "../../ui/Button.svelte";
	// biome-ignore lint/style/useImportType: Also rendered in the Svelte template.
	import SurfacingSummary from "../SurfacingSummary.svelte";

	let { onclose, ...props }: ComponentProps<typeof SurfacingSummary> = $props();
	let dismissed = $state(false);
	let closes = $state(0);
</script>

<Button data-testid="summary-open" onclick={() => { dismissed = false; }}>Open summary</Button>
<output hidden data-testid="summary-close-count">{closes}</output>
<SurfacingSummary {...props} open={props.open && !dismissed} onclose={() => { closes++; dismissed = true; onclose(); }} />
