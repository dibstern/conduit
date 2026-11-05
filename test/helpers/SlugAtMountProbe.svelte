<!--
  Stands in for ChatLayout: records the project filter visible when the child
  initialises, which is when ChatLayout opens its daemon socket.
-->
<script lang="ts">
	import { routerState } from "../../src/lib/frontend/stores/router.svelte.js";

	const slugAtMount = new URLSearchParams(routerState.search).get("p");
</script>

<p data-testid="slug-at-mount">{slugAtMount ?? "none"}</p>
