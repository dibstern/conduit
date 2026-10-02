// One foreground server controls all of its project runners. A restart RPC sets
// this before scoped disposal; ordinary stop, signals and project removal kill.
let restarting = false;

export function setClaudeRunnerRestart(restart: boolean): void {
	restarting = restart;
}
export function preserveClaudeRunners(): boolean {
	return restarting;
}
