<script lang="ts">
	import { handoffReview } from "../../stores/handoff-review.svelte.js";
	import HandoffDialog from "./HandoffDialog.svelte";
</script>

{#if handoffReview.review}
	<HandoffDialog open onclose={() => (handoffReview.review = null)} to={handoffReview.review.to} summary={handoffReview.review.summary} />
{/if}
