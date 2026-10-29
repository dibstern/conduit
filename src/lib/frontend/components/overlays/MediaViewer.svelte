<!--
  MediaViewer — the app-wide modal for an expanded image or diagram.
  Driven by getMediaViewer() from the ui store.
  Closes on Escape, backdrop, the close button, or a session change.
  Fullscreen on compact screens, centred otherwise.
-->
<script lang="ts">
  import { sessionState } from "../../stores/session.svelte.js";
  import { sessionViewState } from "../../stores/session-view.svelte.js";
  import { closeMediaViewer, getMediaViewer, getMediaViewerOpener } from "../../stores/ui.svelte.js";
  import Diagram from "../chat/Diagram.svelte";
  import Button from "../ui/Button.svelte";
  import Dialog from "../ui/Dialog.svelte";

  const item = $derived(getMediaViewer());
  // The shown content's zoom; Escape resets it before it can close the viewer.
  let content = $state<{ resetZoom(): boolean }>();

  // The only session-close call site: another session's content must never stay on screen.
  $effect(() => {
    void sessionState.currentId;
    return closeMediaViewer;
  });
</script>

<Dialog
  open={item !== null}
  onclose={closeMediaViewer}
  backdrop="dark"
  placement={sessionViewState.compact ? "fullscreen" : "center"}
  ariaLabel={item?.kind === "diagram" ? "Expanded diagram" : "Expanded image"}
  returnFocus={getMediaViewerOpener}
  onescape={() => content?.resetZoom() ?? false}
>
    <!-- Empty colour axes keep the fixed white scrim colours without a theme hover wash. -->
    <!-- design-token-waiver: Close button sits on the media viewer's fixed dark backdrop, which does not follow the runtime theme; --overlay-rgb flips to black in light themes and would invert this hover tint to near-invisible against a black backdrop. -->
    <Button
      variant="ghost"
      size="content"
      tone="inherit"
      hoverFill="none"
      class="fixed top-4 right-4 bg-white/15 text-white rounded-full text-xl z-[var(--z-raised)] hover:bg-white/25 {sessionViewState.compact ? 'w-[44px] h-[44px]' : 'w-9 h-9'}"
      onclick={closeMediaViewer}
      ariaLabel="Close media viewer"
    >
      &times;
    </Button>
    <!-- Taps on the empty space around the content fall through to the dialog, which treats them as backdrop taps. -->
    <div class="flex h-full items-center justify-center pointer-events-none *:pointer-events-auto">
      {#if item?.kind === "diagram"}
        <!-- The close button is fixed to the dialog's top-right corner, so a 60px strip above the box keeps it off the diagram's header buttons. -->
        <div class="mt-[60px] h-[min(85dvh,calc(100dvh-8rem))] w-[min(90vw,1200px)]">
          <Diagram bind:this={content} source={item.source} variant="viewer" />
        </div>
      {:else}
        <img
          id="media-viewer-image"
          class="max-w-[92vw] max-h-[90vh] object-contain rounded"
          src={item?.src ?? ""}
          alt="Preview"
        />
      {/if}
    </div>
</Dialog>
