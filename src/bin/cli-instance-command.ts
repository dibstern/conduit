import type { Request } from "effect/Request";
import {
	AddInstance,
	GetInstanceStatus,
	GetInstances,
	RemoveInstance,
	StartInstance,
	StopInstance,
} from "../lib/contracts/ws-rpc.js";
import { formatErrorDetail } from "../lib/errors.js";
import type { CommandContext } from "./cli-command-handlers.js";

export async function handleInstance(ctx: CommandContext): Promise<void> {
	const { args, stderr, exit, checkDaemon } = ctx;

	const running = await checkDaemon();
	if (!running) {
		stderr.write("Daemon is not running.\n");
		stderr.write("Start with: conduit serve or conduit service install\n");
		exit(1);
		return;
	}

	switch (args.instanceAction) {
		case "list":
			return handleGetInstances(ctx);
		case "add":
			return handleAddInstance(ctx);
		case "remove":
			return handleRemoveInstance(ctx);
		case "start":
			return handleStartInstance(ctx);
		case "stop":
			return handleStopInstance(ctx);
		case "status":
			return handleGetInstanceStatus(ctx);
		default:
			stderr.write(
				"Unknown instance action. Usage: --instance <list|add|remove|start|stop|status>\n",
			);
			exit(1);
			return;
	}
}
async function handleGetInstances(ctx: CommandContext): Promise<void> {
	const { stdout, stderr, exit, rpcSend } = ctx;

	let response: Request.Success<GetInstances>;
	try {
		response = await rpcSend(new GetInstances({}));
	} catch (err) {
		stderr.write(`Failed to list instances: ${formatErrorDetail(err)}\n`);
		exit(1);
		return;
	}
	const instances = response.instances;
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

async function handleAddInstance(ctx: CommandContext): Promise<void> {
	const { args, stdout, stderr, exit, rpcSend } = ctx;

	if (!args.instanceName) {
		stderr.write("Instance name is required. Usage: --instance add <name>\n");
		exit(1);
		return;
	}
	try {
		const response = await rpcSend(
			new AddInstance({
				name: args.instanceName,
				managed: args.instanceManaged ?? false,
				...(args.instancePort != null && { port: args.instancePort }),
				...(args.instanceUrl != null && { url: args.instanceUrl }),
			}),
		);
		stdout.write(
			`Instance added: ${response.addedInstanceId ?? args.instanceName}\n`,
		);
	} catch (err) {
		stderr.write(`Failed to add instance: ${formatErrorDetail(err)}\n`);
		exit(1);
	}
	return;
}

async function handleRemoveInstance(ctx: CommandContext): Promise<void> {
	const { args, stdout, stderr, exit, rpcSend } = ctx;

	if (!args.instanceName) {
		stderr.write("Instance id is required. Usage: --instance remove <id>\n");
		exit(1);
		return;
	}
	try {
		await rpcSend(new RemoveInstance({ instanceId: args.instanceName }));
		stdout.write(`Instance removed: ${args.instanceName}\n`);
	} catch (err) {
		stderr.write(`Failed to remove instance: ${formatErrorDetail(err)}\n`);
		exit(1);
	}
	return;
}

async function handleStartInstance(ctx: CommandContext): Promise<void> {
	const { args, stdout, stderr, exit, rpcSend } = ctx;

	if (!args.instanceName) {
		stderr.write("Instance id is required. Usage: --instance start <id>\n");
		exit(1);
		return;
	}
	try {
		await rpcSend(new StartInstance({ instanceId: args.instanceName }));
		stdout.write(`Instance started: ${args.instanceName}\n`);
	} catch (err) {
		stderr.write(`Failed to start instance: ${formatErrorDetail(err)}\n`);
		exit(1);
	}
	return;
}

async function handleStopInstance(ctx: CommandContext): Promise<void> {
	const { args, stdout, stderr, exit, rpcSend } = ctx;

	if (!args.instanceName) {
		stderr.write("Instance id is required. Usage: --instance stop <id>\n");
		exit(1);
		return;
	}
	try {
		await rpcSend(new StopInstance({ instanceId: args.instanceName }));
		stdout.write(`Instance stopped: ${args.instanceName}\n`);
	} catch (err) {
		stderr.write(`Failed to stop instance: ${formatErrorDetail(err)}\n`);
		exit(1);
	}
	return;
}

async function handleGetInstanceStatus(ctx: CommandContext): Promise<void> {
	const { args, stdout, stderr, exit, rpcSend } = ctx;

	if (!args.instanceName) {
		stderr.write("Instance id is required. Usage: --instance status <id>\n");
		exit(1);
		return;
	}
	let response: Request.Success<GetInstanceStatus>;
	try {
		response = await rpcSend(
			new GetInstanceStatus({ instanceId: args.instanceName }),
		);
	} catch (err) {
		stderr.write(`Failed to get instance status: ${formatErrorDetail(err)}\n`);
		exit(1);
		return;
	}
	const inst = response.instance;
	stdout.write(`Instance: ${inst.name} (${inst.id})\n`);
	stdout.write(`  Port:    ${inst.port}\n`);
	stdout.write(`  Managed: ${inst.managed}\n`);
	stdout.write(`  Status:  ${inst.status}\n`);
	return;
}
