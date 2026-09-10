<!-- ─── Message Time ────────────────────────────────────────────────────────── -->
<!-- The send time shown in a message card header.
     Renders nothing when the message has no `createdAt`: live messages stamp it
     on arrival and history carries it from the event store, but rows persisted
     before conduit rendered times have none, and a blank is better than a lie. -->

<script lang="ts">
	import { formatClockTime } from "../../utils/format.js";

	let { createdAt }: { createdAt?: number } = $props();
</script>

{#if createdAt != null}
	<time
		class="text-xs font-mono tabular-nums text-text-dimmer shrink-0"
		datetime={new Date(createdAt).toISOString()}>{formatClockTime(createdAt)}</time
	>
{/if}
