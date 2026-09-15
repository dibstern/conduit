<!--
  ImageLightbox — Fullscreen image preview overlay.
  Driven by uiState.lightboxSrc from the ui store.
  Shows when lightboxSrc is non-null; click anywhere or Escape to close.
-->
<script lang="ts">
  import { uiState, closeLightbox } from "../../stores/ui.svelte.js";
  import Modal from "./Modal.svelte";
</script>

<Modal open={!!uiState.lightboxSrc} onclose={closeLightbox} backdrop="dark">
    <button
      class="fixed top-4 right-4 bg-white/15 border-none text-white w-9 h-9 rounded-full text-xl cursor-pointer z-[var(--z-raised)] hover:bg-white/25"
      onclick={closeLightbox}
      aria-label="Close lightbox"
    >
      &times;
    </button>
    <img
      id="image-lightbox"
      class="max-w-[92vw] max-h-[90vh] object-contain rounded"
      src={uiState.lightboxSrc ?? ""}
      alt="Preview"
    />
</Modal>

