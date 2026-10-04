import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";

/** Build sw.ts as a standalone script (no hash, no module wrapper). */
function serviceWorkerPlugin(): Plugin {
	return {
		name: "service-worker",
		// Dev: rewrite /sw.js requests to /sw.ts so Vite transforms it
		configureServer(server) {
			server.middlewares.use((req, _res, next) => {
				if (req.url === "/sw.js") {
					req.url = "/sw.ts";
				}
				next();
			});
		},
	};
}

/**
 * Strip `/static/` prefix from icon paths inside `.webmanifest` assets.
 *
 * Vite's `publicDir` copies `static/` contents to the build root without the
 * prefix, but treats `.webmanifest` files as opaque — so internal icon `src`
 * values like `/static/foo.png` end up as 404s.  This plugin rewrites them
 * at bundle-emit time.
 */
function manifestIconPlugin(): Plugin {
	return {
		name: "manifest-icon-paths",
		generateBundle(_options, bundle) {
			for (const asset of Object.values(bundle)) {
				if (asset.type !== "asset" || !asset.fileName.endsWith(".webmanifest"))
					continue;

				try {
					const json = JSON.parse(
						typeof asset.source === "string"
							? asset.source
							: new TextDecoder().decode(asset.source),
					);

					if (!Array.isArray(json.icons)) continue;

					let changed = false;
					for (const icon of json.icons) {
						if (
							typeof icon.src === "string" &&
							icon.src.startsWith("/static/")
						) {
							icon.src = icon.src.replace(/^\/static\//, "/");
							changed = true;
						}
					}

					if (changed) {
						asset.source = JSON.stringify(json, null, "\t");
					}
				} catch {
					// Silently skip malformed JSON
				}
			}
		},
	};
}

const relayProxy = {
	target: process.env.CONDUIT_DEV_SERVER ?? "http://localhost:2633",
	secure: false,
};

const config = defineConfig({
	root: "src/lib/frontend",
	publicDir: "static",
	plugins: [
		svelte(),
		tailwindcss(),
		serviceWorkerPlugin(),
		manifestIconPlugin(),
	],
	build: {
		outDir: "../../../dist/frontend",
		emptyOutDir: true,
		sourcemap: true,
		target: "es2022",
		// The main chunk deliberately carries every highlight.js language
		// (~1 MB) and sits near 2.1 MB. The limit sits just above that so the
		// warning still flags regressions; mermaid and xterm load on demand.
		chunkSizeWarningLimit: 2500,
		rollupOptions: {
			input: {
				index: resolve(import.meta.dirname, "src/lib/frontend/index.html"),
				sw: resolve(import.meta.dirname, "src/lib/frontend/sw.ts"),
			},
			output: {
				// Service worker must be at /sw.js with no content hash
				entryFileNames: (chunk) =>
					chunk.name === "sw" ? "sw.js" : "assets/[name]-[hash].js",
				manualChunks: {
					// Isolate Effect.ts into its own chunk for lazy-loading.
					// @effect/schema is merged into `effect` as of Effect 3.x.
					effect: ["effect"],
				},
			},
		},
	},
	// In Vite 6 `preview.proxy` falls back to `server.proxy`. The dev-only
	// proxy targets (localhost:2633) aren't running during E2E tests that use
	// `vite preview`, so disable preview-mode proxying to avoid noisy
	// ECONNREFUSED errors.
	preview: { proxy: {} },
	server: {
		host: "127.0.0.1",
		// Dev server proxies WS and API to the relay server. dev:all points this
		// at the server it drives, which may serve HTTPS with a local cert.
		proxy: {
			"/ws": { ...relayProxy, ws: true },
			// Project-specific WebSocket paths (e.g., /p/my-project/ws)
			// Regex key: Vite interprets keys starting with ^ as RegExp.
			"^/p/[^/]+/ws": { ...relayProxy, ws: true },
			"/api": relayProxy,
			"/auth": relayProxy,
			"/health": relayProxy,
		},
	},
});

export default defineConfig(({ command }) => ({
	...config,
	define: {
		__CONDUIT_BUILD_ID__: JSON.stringify(
			command === "build"
				? (process.env["CONDUIT_BUILD_ID"] ?? randomUUID())
				: "dev",
		),
	},
}));
