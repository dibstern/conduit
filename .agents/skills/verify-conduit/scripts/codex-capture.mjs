// Loaded only by the isolated harness through NODE_OPTIONS. Preserve every
// transport's wire rows, including later discovery and usage polls.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const capture = process.env.CONDUIT_CODEX_APP_SERVER_CAPTURE;
const open = fs.openSync;
if (capture) {
	fs.openSync = (path, flags, mode) =>
		open(path, path === capture && flags === "w" ? "a" : flags, mode);
	syncBuiltinESMExports();
}
