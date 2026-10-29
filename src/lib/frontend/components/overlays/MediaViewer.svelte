<!--
  MediaViewer — the app-wide modal for an expanded image or diagram.
  Driven by getMediaViewer() from the ui store.
  Closes on Escape, backdrop, the close button, or a session change.
  Fullscreen on compact screens, centred otherwise.
-->
<script lang="ts">
  import { sessionState } from "../../stores/session.svelte.js";
  import { sessionViewState } from "../../stores/session-view.svelte.js";
  import { closeMediaViewer, getMediaViewer } from "../../stores/ui.svelte.js";
  import Diagram from "../chat/Diagram.svelte";
  import Button from "../ui/Button.svelte";
  import Dialog from "../ui/Dialog.svelte";

  const item = $derived(getMediaViewer());

  // The only session-close call site: another session's content must never stay on screen.
  $effect(() => {
    void sessionState.currentId;
    return closeMediaViewer;
  });

  // The control that opened the viewer, read before the dialog takes focus, so closing hands focus back to it.
  let opener: Element | null = null;
  $effect.pre(() => {
    if (item) opener = document.activeElement;
  });
</script>

<Dialog
  open={item !== null}
  onclose={closeMediaViewer}
  backdrop="dark"
  placement={sessionViewState.compact ? "fullscreen" : "center"}
  ariaLabel={item?.kind === "diagram" ? "Expanded diagram" : "Expanded image"}
  returnFocus={() => (opener instanceof HTMLElement ? opener : null)}
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
    <div class="flex h-full items-center justify-center">
      {#if item?.kind === "diagram"}
        <!-- At most 100dvh - 8rem tall, so the close button above never covers the diagram's header. -->
        <div class="h-[min(85dvh,calc(100dvh-8rem))] w-[min(90vw,1200px)]">
          <Diagram source={item.source} variant="viewer" />
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
