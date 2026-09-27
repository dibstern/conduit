<!--
  ImageLightbox — Fullscreen image preview overlay.
  Driven by uiState.lightboxSrc from the ui store.
  Shows when lightboxSrc is non-null; click anywhere or Escape to close.
-->
<script lang="ts">
  import { uiState, closeLightbox } from "../../stores/ui.svelte.js";
  import Button from "../ui/Button.svelte";
  import Modal from "./Modal.svelte";
</script>

<Modal open={!!uiState.lightboxSrc} onclose={closeLightbox} backdrop="dark">
    <!-- Empty colour axes keep the fixed white scrim colours without a theme hover wash. -->
    <!-- design-token-waiver: Close button sits on the lightbox's fixed dark backdrop, which does not follow the runtime theme; --overlay-rgb flips to black in light themes and would invert this hover tint to near-invisible against a black backdrop. -->
    <Button
      variant="ghost"
      size="content"
      tone="inherit"
      hoverFill="none"
      class="fixed top-4 right-4 bg-white/15 text-white w-9 h-9 rounded-full text-xl z-[var(--z-raised)] hover:bg-white/25"
      onclick={closeLightbox}
      ariaLabel="Close lightbox"
    >
      &times;
    </Button>
    <img
      id="image-lightbox"
      class="max-w-[92vw] max-h-[90vh] object-contain rounded"
      src={uiState.lightboxSrc ?? ""}
      alt="Preview"
    />
</Modal>

