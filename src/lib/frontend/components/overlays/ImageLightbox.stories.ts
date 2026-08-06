import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { uiState } from "../../stores/ui.svelte.js";
import ImageLightbox from "./ImageLightbox.svelte";

const meta = {
	title: "Overlays/ImageLightbox",
	component: ImageLightbox,
	tags: ["autodocs"],
	parameters: {
		docs: { story: { inline: false, height: "400px" } },
	},
	beforeEach: () => {
		uiState.lightboxSrc = null;
	},
} satisfies Meta<typeof ImageLightbox>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * An 800x600 inline SVG, not a URL. This story used to point at
 * `https://picsum.photos/seed/opencode/800/600`, which made a committed visual
 * baseline depend on a third-party CDN being reachable and returning identical
 * bytes (conduit-test-de3.23). It was not: the baseline shows a photograph
 * while the capture shows a near-black viewport with only the close button, and
 * the diff magnitude tracked concurrency — 815,785 pixels alone, 1,253,248
 * under load. npm-release.yml Job 4 gates `release` on this suite, so an outage
 * at picsum.photos was one failed release.
 *
 * Intrinsic dimensions are declared on the SVG so the lightbox's fit/scale
 * maths sees exactly what an 800x600 raster would, and a data URI decodes with
 * no network round trip — which removes the load race along with the
 * dependency.
 */
const FIXTURE_IMAGE_SRC = `data:image/svg+xml;utf8,${encodeURIComponent(
	`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600">
	<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
		<stop offset="0%" stop-color="#1c2333"/><stop offset="100%" stop-color="#0a0d14"/>
	</linearGradient></defs>
	<rect width="800" height="600" fill="url(#g)"/>
	<circle cx="260" cy="220" r="110" fill="#00e5ff" fill-opacity="0.55"/>
	<circle cx="470" cy="330" r="140" fill="#ff2d7b" fill-opacity="0.45"/>
	<rect x="80" y="470" width="640" height="10" rx="5" fill="#e6e6e6" fill-opacity="0.7"/>
</svg>`,
)}`;

export const WithImage: Story = {
	beforeEach: () => {
		uiState.lightboxSrc = FIXTURE_IMAGE_SRC;
	},
};

export const Hidden: Story = {
	beforeEach: () => {
		uiState.lightboxSrc = null;
	},
};
