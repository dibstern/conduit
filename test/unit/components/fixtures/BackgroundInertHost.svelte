<script lang="ts">
	import { backgroundInert } from "../../../../src/lib/frontend/components/ui/actions/use-background-inert.svelte.js";

	let { enabled = true }: { enabled?: boolean } = $props();
</script>

<button data-testid="background-control" type="button" aria-hidden="false">
	Background
</button>
<svg data-testid="background-svg" aria-hidden="false">
	<a href="/help"><text>Help</text></a>
</svg>
<aside data-testid="preexisting-background" inert aria-hidden="true">
	Already hidden
</aside>
<section data-testid="modal-content" use:backgroundInert={enabled}>
	Modal content
</section>
