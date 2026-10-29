<!--
  MediaViewer — the app-wide modal for an expanded image.
  Driven by getMediaViewer() from the ui store.
  Closes on Escape, backdrop, the close button, or a session change.
-->
<script lang="ts">
  import { sessionState } from "../../stores/session.svelte.js";
  import { closeMediaViewer, getMediaViewer } from "../../stores/ui.svelte.js";
  import Button from "../ui/Button.svelte";
  import Dialog from "../ui/Dialog.svelte";

  const item = $derived(getMediaViewer());

  // The only session-close call site: another session's content must never stay on screen.
  $effect(() => {
    void sessionState.currentId;
    return closeMediaViewer;
  });
</script>

<Dialog open={item !== null} onclose={closeMediaViewer} backdrop="dark">
    <!-- Empty colour axes keep the fixed white scrim colours without a theme hover wash. -->
    <!-- design-token-waiver: Close button sits on the media viewer's fixed dark backdrop, which does not follow the runtime theme; --overlay-rgb flips to black in light themes and would invert this hover tint to near-invisible against a black backdrop. -->
    <Button
      variant="ghost"
      size="content"
      tone="inherit"
      hoverFill="none"
      class="fixed top-4 right-4 bg-white/15 text-white w-9 h-9 rounded-full text-xl z-[var(--z-raised)] hover:bg-white/25"
      onclick={closeMediaViewer}
      ariaLabel="Close media viewer"
    >
      &times;
    </Button>
    <img
      id="media-viewer-image"
      class="max-w-[92vw] max-h-[90vh] object-contain rounded"
      src={item?.src ?? ""}
      alt="Preview"
    />
</Dialog>
