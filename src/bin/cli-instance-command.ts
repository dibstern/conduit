import {
	InstanceAdd,
	InstanceList,
	InstanceRemove,
	InstanceStart,
	InstanceStatus,
	InstanceStop,
} from "../lib/contracts/ipc-requests.js";
import type { CommandContext } from "./cli-command-handlers.js";

export async function handleInstance(ctx: CommandContext): Promise<void> {
	const { args, stderr, exit, checkDaemon } = ctx;

	const running = await checkDaemon();
	if (!running) {
		stderr.write("Daemon is not running.\n");
		stderr.write("Start with: npx conduit\n");
		exit(1);
		return;
	}

	switch (args.instanceAction) {
		case "list":
			return handleInstanceList(ctx);
		case "add":
			return handleInstanceAdd(ctx);
		case "remove":
			return handleInstanceRemove(ctx);
		case "start":
			return handleInstanceStart(ctx);
		case "stop":
			return handleInstanceStop(ctx);
		case "status":
			return handleInstanceStatus(ctx);
		default:
			stderr.write(
				"Unknown instance action. Usage: --instance <list|add|remove|start|stop|status>\n",
			);
			exit(1);
			return;
	}
}
async function handleInstanceList(ctx: CommandContext): Promise<void> {
	const { stdout, stderr, exit, ipcSend } = ctx;

	const response = await ipcSend(new InstanceList({}));
	if (!response.ok) {
		stderr.write(
			`Failed to list instances: ${response.error ?? "unknown error"}\n`,
		);
		exit(1);
		return;
	}
	const instances = (response.instances ?? []) as Array<{
		id: string;
		name: string;
		port: number;
		managed: boolean;
		status: string;
	}>;
	if (instances.length === 0) {
		stdout.write("No instances configured.\n");
		return;
	}
	stdout.write(`Instances (${instances.length}):\n`);
	for (const inst of instances) {
		stdout.write(
			`  ${inst.name} (${inst.id})  port=${inst.port}  managed=${inst.managed}  status=${inst.status}\n`,
		);
	}
	return;
}

async function handleInstanceAdd(ctx: CommandContext): Promise<void> {
	const { args, stdout, stderr, exit, ipcSend } = ctx;

	if (!args.instanceName) {
		stderr.write("Instance name is required. Usage: --instance add <name>\n");
		exit(1);
		return;
	}
	const response = await ipcSend(
		new InstanceAdd({
			name: args.instanceName,
			managed: args.instanceManaged ?? false,
			...(args.instancePort != null && { port: args.instancePort }),
			...(args.instanceUrl != null && { url: args.instanceUrl }),
		}),
	);
	if (response.ok) {
		stdout.write(
			`Instance added: ${(response.instance as { id: string })?.id ?? args.instanceName}\n`,
		);
	} else {
		stderr.write(
			`Failed to add instance: ${response.error ?? "unknown error"}\n`,
		);
		exit(1);
	}
	return;
}

async function handleInstanceRemove(ctx: CommandContext): Promise<void> {
	const { args, stdout, stderr, exit, ipcSend } = ctx;

	if (!args.instanceName) {
		stderr.write("Instance id is required. Usage: --instance remove <id>\n");
		exit(1);
		return;
	}
	const response = await ipcSend(
		new InstanceRemove({
			id: args.instanceName,
		}),
	);
	if (response.ok) {
		stdout.write(`Instance removed: ${args.instanceName}\n`);
	} else {
		stderr.write(
			`Failed to remove instance: ${response.error ?? "unknown error"}\n`,
		);
		exit(1);
	}
	return;
}

async function handleInstanceStart(ctx: CommandContext): Promise<void> {
	const { args, stdout, stderr, exit, ipcSend } = ctx;

	if (!args.instanceName) {
		stderr.write("Instance id is required. Usage: --instance start <id>\n");
		exit(1);
		return;
	}
	const response = await ipcSend(
		new InstanceStart({
			id: args.instanceName,
		}),
	);
	if (response.ok) {
		stdout.write(`Instance started: ${args.instanceName}\n`);
	} else {
		stderr.write(
			`Failed to start instance: ${response.error ?? "unknown error"}\n`,
		);
		exit(1);
	}
	return;
}

async function handleInstanceStop(ctx: CommandContext): Promise<void> {
	const { args, stdout, stderr, exit, ipcSend } = ctx;

	if (!args.instanceName) {
		stderr.write("Instance id is required. Usage: --instance stop <id>\n");
		exit(1);
		return;
	}
	const response = await ipcSend(
		new InstanceStop({
			id: args.instanceName,
		}),
	);
	if (response.ok) {
		stdout.write(`Instance stopped: ${args.instanceName}\n`);
	} else {
		stderr.write(
			`Failed to stop instance: ${response.error ?? "unknown error"}\n`,
		);
		exit(1);
	}
	return;
}

async function handleInstanceStatus(ctx: CommandContext): Promise<void> {
	const { args, stdout, stderr, exit, ipcSend } = ctx;

	if (!args.instanceName) {
		stderr.write("Instance id is required. Usage: --instance status <id>\n");
		exit(1);
		return;
	}
	const response = await ipcSend(
		new InstanceStatus({
			id: args.instanceName,
		}),
	);
	if (!response.ok) {
		stderr.write(
			`Failed to get instance status: ${response.error ?? "unknown error"}\n`,
		);
		exit(1);
		return;
	}
	const inst = response.instance as {
		id: string;
		name: string;
		port: number;
		managed: boolean;
		status: string;
	};
	stdout.write(`Instance: ${inst.name} (${inst.id})\n`);
	stdout.write(`  Port:    ${inst.port}\n`);
	stdout.write(`  Managed: ${inst.managed}\n`);
	stdout.write(`  Status:  ${inst.status}\n`);
	return;
}
