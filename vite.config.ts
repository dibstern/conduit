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

export default defineConfig({
	root: "src/lib/frontend",
	publicDir: "static",
	plugins: [svelte(), tailwindcss(), serviceWorkerPlugin()],
	build: {
		outDir: "../../../dist/frontend",
		emptyOutDir: true,
		sourcemap: true,
		target: "es2022",
		rollupOptions: {
			input: {
				index: resolve(import.meta.dirname, "src/lib/frontend/index.html"),
				sw: resolve(import.meta.dirname, "src/lib/frontend/sw.ts"),
			},
			output: {
				// Service worker must be at /sw.js with no content hash
				entryFileNames: (chunk) =>
					chunk.name === "sw" ? "sw.js" : "assets/[name]-[hash].js",
			},
		},
	},
	server: {
		host: "127.0.0.1",
		// Dev server proxies WS and API to the relay server
		proxy: {
			"/ws": {
				target: "ws://localhost:2633",
				ws: true,
			},
			// Project-specific WebSocket paths (e.g., /p/my-project/ws)
			// Regex key: Vite interprets keys starting with ^ as RegExp.
			"^/p/[^/]+/ws": {
				target: "ws://localhost:2633",
				ws: true,
			},
			"/api": {
				target: "http://localhost:2633",
			},
			"/auth": {
				target: "http://localhost:2633",
			},
			"/health": {
				target: "http://localhost:2633",
			},
		},
	},
});
