<script lang="ts">
	import {
		rovingFocus,
		type RovingFocusOptions,
	} from "../../../../src/lib/frontend/components/ui/actions/use-roving-focus.svelte.js";

	let { options }: { options?: RovingFocusOptions } = $props();
</script>

<div data-testid="roving-host" role="listbox" tabindex="0" use:rovingFocus={options}>
	<button data-testid="roving-first" type="button" role="option" aria-selected="false">First</button>
	<button data-testid="roving-middle" type="button" role="option" aria-selected="false">Middle</button>
	<button data-testid="roving-last" type="button" role="option" aria-selected="false">Last</button>
</div>
