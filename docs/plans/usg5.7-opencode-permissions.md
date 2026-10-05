# OpenCode extra-folder permissions

For conduit-test-usg5.7, OpenCode supports path-specific `external_directory`
rules. The installed SDK 1.18.32 defines `{ permission, pattern, action }` in
`node_modules/@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts:56-63`, accepts rules
when creating a session at `:8085-8101`, and when updating one at `:8203-8211`.
Its older client entrypoint omits the update field from its types, but forwards
the complete body. The v2 ruleset type is re-exported through conduit's existing
SDK type module; no SDK upgrade or worktree-directory API is needed.

[OpenCode's permission documentation](https://opencode.ai/docs/permissions/#external-directories)
allows directory patterns, and its wildcard section says `*` matches any number
of characters, including nested paths. Each existing extra folder therefore
gets an `allow` rule for its canonical absolute path followed by `/*`, which
does not also cover a sibling with the same name prefix. Literal `*` or `?` in
a folder name cannot be escaped by this matcher, so those folders keep `ask`.

Before each prompt, read `session.get(sessionId).permission` and keep the last
action for each exact `external_directory` folder pattern. The session-detail
decoder preserves these rules. Compare them with the canonical allow patterns
for the current `extraFolders`: append `ask` only for previously allowed patterns
that are no longer desired, and append `allow` only for desired patterns not
already allowed. Skip the update when this delta is empty. Never send a `*`
catch-all, and leave existing catch-alls untouched, so single-folder sessions
that never had extra-folder grants keep the user's global policy. Upstream
[session update](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts#L194-L198)
merges the existing session rules with each update; the
[merge](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/permission/index.ts#L182-L184)
concatenates rules, and the
[permission evaluator](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/permission/index.ts#L27-L38)
uses the last matching rule. Unchanged turns therefore append nothing, and
persisted session rules make removal work after a daemon restart. The known edge
is that resetting a removed folder to `ask` also overrides a broader global
allow covering that folder.

Keep the short system note naming the same resolved `extraFolders`. If an extra
folder disappears between dispatch and the prompt, skip its permission grant
without failing the turn; the system note remains unchanged. Other tool
permissions still apply, so an explicit read/edit denial remains a denial.

The process-harness test checks the fixed marker in the transcript and captures
the actual request bodies to assert rules and the note using replay-time paths.
It also checks no updates for single-folder sessions or unchanged extras,
exactly one `ask` for folder removal with and without a restart, no `*` rules,
a deleted extra, and a missing main folder. The mock appends permission patches
and returns the stored rules on session GET. Re-record with
`SCENARIO=multi-folder-project pnpm test:record-snapshots`; keep the generated
`.opencode.json.gz` and `.json` companion beside the other recordings.
