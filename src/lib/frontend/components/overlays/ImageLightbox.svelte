<!--
  ImageLightbox — Fullscreen image preview overlay.
  Driven by uiState.lightboxSrc from the ui store.
  Shows when lightboxSrc is non-null; click anywhere or Escape to close.
-->
<script lang="ts">
  import { uiState, closeLightbox } from "../../stores/ui.svelte.js";

  function handleBackdropClick(): void {
    closeLightbox();
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
    class="modal-backdrop fixed inset-0 bg-black/85 flex items-center justify-center z-[300] transition-opacity duration-200 ease-linear"
    onclick={handleBackdropClick}
  >
    <button
      class="absolute top-4 right-4 bg-white/15 border-none text-white w-9 h-9 rounded-full text-xl cursor-pointer z-[1] hover:bg-white/25"
      onclick={closeLightbox}
      aria-label="Close lightbox"
    >
      &times;
    </button>
    <img
      class="max-w-[92vw] max-h-[90vh] object-contain rounded"
      src={uiState.lightboxSrc}
      alt="Preview"
      role="presentation"
      onclick={(e: MouseEvent) => e.stopPropagation()}
    />
  </div>
{/if}
