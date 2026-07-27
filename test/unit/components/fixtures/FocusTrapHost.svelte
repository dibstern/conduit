<script lang="ts">
	import {
		focusTrap,
		type FocusTrapOptions,
	} from "../../../../src/lib/frontend/components/ui/actions/use-focus-trap.svelte.js";

	let { options }: { options?: FocusTrapOptions } = $props();
</script>

<button data-testid="focus-trigger" type="button">Trigger</button>
<section data-testid="focus-trap" use:focusTrap={options}>
	<button data-testid="focus-first" type="button">First</button>
	<input data-testid="focus-middle" aria-label="Middle" />
	<button data-testid="focus-last" type="button">Last</button>
</section>
<button data-testid="focus-background" type="button">Background</button>
