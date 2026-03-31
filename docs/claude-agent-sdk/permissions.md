# Configure permissions

> Source: https://platform.claude.com/docs/en/agent-sdk/permissions
> Extracted: 2026-03-31

Control how your agent uses tools with permission modes, hooks, and declarative allow/deny rules.

---

The Claude Agent SDK provides permission controls to manage how Claude uses tools. Use permission modes and rules to define what's allowed automatically, and the `canUseTool` callback to handle everything else at runtime.

## How permissions are evaluated

When Claude requests a tool, the SDK checks permissions in this order:

1. **Hooks**: Run hooks first, which can allow, deny, or continue to the next step
2. **Deny rules**: Check `deny` rules (from `disallowed_tools` and settings.json). If a deny rule matches, the tool is blocked, even in `bypassPermissions` mode.
3. **Permission mode**: Apply the active permission mode. `bypassPermissions` approves everything that reaches this step. `acceptEdits` approves file operations. Other modes fall through.
4. **Allow rules**: Check `allow` rules (from `allowed_tools` and settings.json). If a rule matches, the tool is approved.
5. **canUseTool callback**: If not resolved by any of the above, call your `canUseTool` callback for a decision. In `dontAsk` mode, this step is skipped and the tool is denied.

## Allow and deny rules

| Option | Effect |
| :--- | :--- |
| `allowed_tools=["Read", "Grep"]` | `Read` and `Grep` are auto-approved. Tools not listed still exist and fall through to permission mode and `canUseTool`. |
| `disallowed_tools=["Bash"]` | `Bash` is always denied. Deny rules hold in every permission mode, including `bypassPermissions`. |

For a locked-down agent, pair `allowedTools` with `permissionMode: "dontAsk"`:

```typescript
const options = {
  allowedTools: ["Read", "Glob", "Grep"],
  permissionMode: "dontAsk"
};
```

> **`allowed_tools` does not constrain `bypassPermissions`.** Unlisted tools fall through to the permission mode, where `bypassPermissions` approves them. If you need specific tools blocked, use `disallowed_tools`.

## Permission modes

### Available modes

| Mode | Description | Tool behavior |
| :--- | :---------- | :------------ |
| `default` | Standard permission behavior | No auto-approvals; unmatched tools trigger `canUseTool` callback |
| `dontAsk` (TS only) | Deny instead of prompting | Anything not pre-approved is denied; `canUseTool` never called |
| `acceptEdits` | Auto-accept file edits | File edits and filesystem operations auto-approved |
| `bypassPermissions` | Bypass all permission checks | All tools run without prompts (use with caution) |
| `plan` | Planning mode | No tool execution; Claude plans without making changes |

> **Subagent inheritance:** When using `bypassPermissions`, all subagents inherit this mode and it cannot be overridden.

### Set permission mode

Pass `permission_mode` (Python) or `permissionMode` (TypeScript) when creating a query.

You can also change the mode mid-session with `set_permission_mode()` (Python) or `setPermissionMode()` (TypeScript).

### Accept edits mode (`acceptEdits`)

Auto-approves file operations so Claude can edit code without prompting:
- File edits (Edit, Write tools)
- Filesystem commands: `mkdir`, `touch`, `rm`, `mv`, `cp`

### Don't ask mode (`dontAsk`, TypeScript only)

Converts any permission prompt into a denial. Listed tools are approved; everything else is denied.

### Bypass permissions mode (`bypassPermissions`)

Auto-approves all tool uses without prompts. Use with extreme caution.

### Plan mode (`plan`)

Prevents tool execution entirely. Claude can analyze code and create plans but cannot make changes.

## Related resources

- [Handle approvals and user input](./user-input.md)
- [Hooks guide](./hooks.md)
