# Rewind file changes with checkpointing

> Source: https://platform.claude.com/docs/en/agent-sdk/file-checkpointing
> Extracted: 2026-03-31

Track file changes during agent sessions and restore files to any previous state

---

File checkpointing tracks file modifications made through the Write, Edit, and NotebookEdit tools during an agent session, allowing you to rewind files to any previous state.

With checkpointing, you can:
- **Undo unwanted changes** by restoring files to a known good state
- **Explore alternatives** by restoring to a checkpoint and trying a different approach
- **Recover from errors** when the agent makes incorrect modifications

> Only changes made through the Write, Edit, and NotebookEdit tools are tracked. Changes made through Bash commands (like `echo > file.txt` or `sed -i`) are not captured.

## How checkpointing works

When you enable file checkpointing, the SDK creates backups of files before modifying them. User messages in the response stream include a checkpoint UUID that you can use as a restore point.

| Tool | Description |
|------|-------------|
| Write | Creates a new file or overwrites an existing file |
| Edit | Makes targeted edits to specific parts of a file |
| NotebookEdit | Modifies cells in Jupyter notebooks |

> File rewinding restores files on disk to a previous state. It does not rewind the conversation itself.

## Implement checkpointing

### Step 1: Enable checkpointing

| Option | Python | TypeScript | Description |
|--------|--------|------------|-------------|
| Enable checkpointing | `enable_file_checkpointing=True` | `enableFileCheckpointing: true` | Tracks file changes |
| Receive checkpoint UUIDs | `extra_args={"replay-user-messages": None}` | `extraArgs: { 'replay-user-messages': null }` | Required to get UUIDs |

### Step 2: Capture checkpoint UUID and session ID

With `replay-user-messages`, each user message has a UUID that serves as a checkpoint. Capture the first user message UUID for restoring to original state.

### Step 3: Rewind files

To rewind after the stream completes, resume the session with an empty prompt and call `rewind_files()` / `rewindFiles()` with your checkpoint UUID.

```typescript
const rewindQuery = query({
  prompt: "",
  options: { ...opts, resume: sessionId }
});

for await (const msg of rewindQuery) {
  await rewindQuery.rewindFiles(checkpointId);
  break;
}
```

```python
async with ClaudeSDKClient(
    ClaudeAgentOptions(enable_file_checkpointing=True, resume=session_id)
) as client:
    await client.query("")
    async for message in client.receive_response():
        await client.rewind_files(checkpoint_id)
        break
```

## Common patterns

### Checkpoint before risky operations

Keep only the most recent checkpoint UUID, updating before each agent turn. If something goes wrong, immediately rewind.

### Multiple restore points

Store all checkpoint UUIDs in an array with metadata. After the session completes, rewind to any previous checkpoint.

## Limitations

| Limitation | Description |
|------------|-------------|
| Write/Edit/NotebookEdit tools only | Bash changes not tracked |
| Same session | Checkpoints tied to creating session |
| File content only | Directory operations not undone |
| Local files | Remote files not tracked |
