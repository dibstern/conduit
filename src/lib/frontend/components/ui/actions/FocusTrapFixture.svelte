<script lang="ts">
	import { focusTrap } from "./use-focus-trap.svelte.js";

	let open = $state(false);
</script>

<button id="outside-btn" type="button">Outside</button>
<button
	id="trigger"
	type="button"
	onclick={() => {
		open = true;
	}}
>
	Open focus trap
</button>
{#if open}
	<section id="trap" aria-label="Focus trap" use:focusTrap>
		<button id="first" type="button">First</button>
		<input id="middle" aria-label="Middle" />
		<button
			id="last"
			type="button"
			onclick={() => {
				open = false;
			}}
		>
			Close focus trap
		</button>
	</section>
{/if}
