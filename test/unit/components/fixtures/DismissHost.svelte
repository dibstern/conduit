<script lang="ts">
	import {
		dismiss,
		type DismissOptions,
	} from "../../../../src/lib/frontend/components/ui/actions/use-dismiss.svelte.js";

	let { options }: { options: DismissOptions } = $props();
</script>

<div data-testid="dismiss-host" use:dismiss={options}>
	<button type="button">Inside</button>
</div>
<button data-testid="dismiss-ignore" type="button">Ignored</button>
