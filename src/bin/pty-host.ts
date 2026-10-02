import { DEFAULT_CONFIG_DIR } from "../lib/env.js";
import { runPtyHost } from "../lib/terminal/pty-host.js";
import {
	restartPtyHost,
	stopPtyHost,
} from "../lib/terminal/pty-host-client.js";

async function main(): Promise<void> {
	const action = process.argv[2];
	if (action === "stop") {
		const stopped = await stopPtyHost({
			configDir: DEFAULT_CONFIG_DIR,
			force: true,
		});
		console.log(stopped ? "PTY host stopped." : "PTY host is not running.");
	} else if (action === "restart") {
		const client = await restartPtyHost({ configDir: DEFAULT_CONFIG_DIR });
		console.log(`PTY host restarted (pid=${client.hello.pid}).`);
		client.disconnect();
	} else if (action === undefined) {
		await runPtyHost({ configDir: DEFAULT_CONFIG_DIR });
	} else {
		throw new Error("Usage: node dist/src/bin/pty-host.js [stop|restart]");
	}
}

main()
	.then(() => process.exit(0))
	.catch((error: unknown) => {
		console.error(error);
		process.exit(1);
	});
