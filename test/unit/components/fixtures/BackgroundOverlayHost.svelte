<script lang="ts">
	import { backgroundInert, exemptFromBackgroundInert } from "../../../../src/lib/frontend/components/ui/actions/use-background-inert.svelte.js";
	let { enabled = false, overlay = false, inline = false }: { enabled?: boolean; overlay?: boolean; inline?: boolean } = $props();
</script>

<aside data-testid="background-branch">
	<button data-testid="unrelated-control" type="button">Background control</button>
	<div data-testid="overlay-path">
		{#if overlay && inline === false}
			<div data-testid="overlay" use:exemptFromBackgroundInert>Overlay</div>
		{/if}
	</div>
</aside>
<section data-testid="boundary" use:backgroundInert={enabled}>
	<button data-testid="modal-control" type="button">Modal control</button>
	{#if overlay && inline}
		<div data-testid="overlay" use:exemptFromBackgroundInert>Inline overlay</div>
	{/if}
</section>
