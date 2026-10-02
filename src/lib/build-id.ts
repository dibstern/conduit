// Vite replaces this constant; the server build stamps the emitted module.
// Source execution and the Vite dev server always use the same dev sentinel.
declare const __CONDUIT_BUILD_ID__: string;

export const BUILD_ID: string =
	typeof __CONDUIT_BUILD_ID__ === "string" ? __CONDUIT_BUILD_ID__ : "dev";
