<!--
  ImageLightbox — Fullscreen image preview overlay.
  Driven by uiState.lightboxSrc from the ui store.
  Shows when lightboxSrc is non-null; click anywhere or Escape to close.
-->
<script lang="ts">
  import { uiState, closeLightbox } from "../../stores/ui.svelte.js";
  import Button from "../ui/Button.svelte";

  // Only a click on the backdrop itself closes; clicks on the image fall through
  // to here with a different target and are ignored.
  function handleBackdropClick(e: MouseEvent): void {
    if (e.target === e.currentTarget) {
      closeLightbox();
    }
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      closeLightbox();
    }
  }
</script>

<svelte:window onkeydown={uiState.lightboxSrc ? handleKeydown : undefined} />

{#if uiState.lightboxSrc}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="modal-backdrop fixed inset-0 bg-black/85 flex items-center justify-center z-[var(--z-modal)] transition-opacity duration-200 ease-linear"
    onclick={handleBackdropClick}
  >
    <!-- Empty colour axes keep the fixed white scrim colours without a theme hover wash. -->
    <!-- design-token-waiver: Close button sits on the lightbox's fixed bg-black/85 backdrop, which does not follow the runtime theme; --overlay-rgb flips to black in light themes and would invert this hover tint to near-invisible against a black backdrop. -->
    <Button
      variant="ghost"
      size="content"
      tone="inherit"
      hoverFill="none"
      class="absolute top-4 right-4 bg-white/15 text-white w-9 h-9 rounded-full text-xl z-[var(--z-raised)] hover:bg-white/25"
      onclick={closeLightbox}
      ariaLabel="Close lightbox"
    >
      &times;
    </Button>
    <img
      class="max-w-[92vw] max-h-[90vh] object-contain rounded"
      src={uiState.lightboxSrc}
      alt="Preview"
    />
  </div>
{/if}
