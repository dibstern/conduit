import { Effect } from "effect";
import {
	type DaemonStoreImportCheckpoint,
	importRegisteredProjectStores,
	type ProjectStoreSource,
} from "../../src/lib/persistence/migrations/daemon-store-import.js";

interface CrashArgs {
	readonly configDir: string;
	readonly projects: readonly ProjectStoreSource[];
	readonly now: number;
	readonly checkpoint: DaemonStoreImportCheckpoint;
	readonly projectId: string;
}

const args = JSON.parse(process.argv[2] ?? "null") as CrashArgs;
await Effect.runPromise(
	importRegisteredProjectStores(args.configDir, args.projects, {
		now: () => args.now,
		checkpoint: (name, projectId) => {
			if (name === args.checkpoint && projectId === args.projectId)
				process.kill(process.pid, "SIGKILL");
		},
	}),
);
