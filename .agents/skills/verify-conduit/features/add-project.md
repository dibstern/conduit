# Add a project

A user adds a folder as a new project from the scope chip at the top of the sidebar. The Add a project dialog suggests folders as you type, fills in the project name, and offers a setup script and a default session mode. After **Add project**, conduit opens a new draft in that project, with the project chip set, and every browser can start sessions there. Adding a project doesn't depend on the harness. A first send in the new project was tried on all four harnesses: Claude and Cursor work, and OpenCode and Codex hit replay limits (see Gotchas).

## Sub-features

- `project-add-open` opens the dialog from the scope chip's **Add a project…**.
- `project-add-pick` covers typing a path, picking it from the folder suggestions, the breadcrumbs, and the name autofill.
- `project-add-options` covers the Project name, Setup script, and Default session mode (Use global default, Local folder, New worktree) fields. Only the name was used.
- `project-add-save` covers **Add project**, which saves the project and opens a draft in it.
- `project-add-send` covers the first session in the new project, per harness.

## How to get to it (user POV)

- Click the scope chip at the top of the sidebar (it reads **All projects** or a project name). The menu lists All projects, each project, **Select projects…** and **Add a project…**.
- **Add project** stays disabled until a folder is picked.

## Driving it with playwright-cli

The folder must exist inside your run's root. Never point it at a real folder of yours.

```bash
D="test-results/verify-conduit/$RUN_ID/add-project"
mkdir -p "$D"
$V up
F=$($V info | node -pe 'JSON.parse(require("fs").readFileSync(0)).root')/t3code
mkdir -p "$F"
$V click '[data-testid=session-scope-chip]'
$V click 'role=menuitem[name="Add a project…"]'
$V screenshot --file "$D/01-dialog.png"
$V fill 'role=combobox[name="Add folder"]' "$F"
$V click "role=option[name='$F']"
$V screenshot --file "$D/02-picked.png"
$V click 'role=dialog >> role=button[name="Add project"]'
$V eval '() => [location.pathname + location.search, document.querySelector("[data-testid=draft-project-chip]")?.textContent.trim(), document.querySelector("[data-testid=session-scope-chip]")?.textContent.trim()]'
$V snapshot --file "$D/03-after-add.aria.yml"
cfg=$($V info | node -pe 'JSON.parse(require("fs").readFileSync(0)).configDir')
python3 -c "import json;print([(p['slug'],p['folders']) for p in json.load(open('$cfg/daemon.json'))['projects']])"

# First session in the new project
$V send 'Say hello' --harness claude --model opus --provider claude
$V new-session    # still in t3code
$V send 'Say hello' --harness cursor --model composer-2.5 --provider cursor
$V store sql "select project_id, model_provider, title from sessions"
```

Check these results:

- The dialog is titled `Add a project`. It has a combobox `Add folder`, Project name, Setup script, a Default session mode select, Cancel, and a disabled `Add project`.
- After picking the folder, breadcrumbs and a `Folder matches` list appear. The list reads `Main folder: …/t3code`, and Project name fills in as `t3code`.
- After **Add project** the dialog closes with no alert. The path is `/draft/<uuid>?p=t3code&project=t3code`, `draft-project-chip` reads `TC t3code`, and the scope chip reads `t3code`.
- `daemon.json` lists `('t3code', ['<root>/t3code'])` next to `process-test`.
- In another browser context, a new session also offers `TC t3code` (URL `?project=t3code`), with the scope chip at `All projects`.
- In `t3code`, Claude replies `pong` and Cursor replies with its usual greeting. Both rows have `project_id` `t3code` and the title `Process harness session`.

## Gotchas

- The suggestion's accessible name is the full path. `role=option[name="t3code"]` matches nothing. Use `role=option[name='<full path>']`.
- OpenCode in a new project is a replay artifact, not a product check. The first send timed out waiting for the `/s/` URL. The second made a session titled `Pong reply`, whose stored messages are the recording's (`Reply with just the word 'pong'. Nothing else.` and `pong`, with the recorded `created_at`), not the prompt that was sent.
- Codex in a new project shows `No models available`. Authentication is cached per account home, while catalogs are cached per account home and workspace. The new workspace skips `account/read`, but the discovery replay still expects it and reports `{"expected":"account/read","actual":"model/list","at":4}`. The transport scenario does not distinguish this path. Proposed fix: bead `conduit-test-9jmlm`.
- OpenCode shares one mock server, recorded inventory and prompt counter across projects. Its replay needs directory and session isolation before second-project sends can count as proof. See bead `conduit-test-9jmlm`.
- `send` now selects the model before filling the prompt, so a failed model selection leaves no new prompt text. Drafts left by older runs can be cleared with **Clear all** in the drafts tray.
- Not checked: Select projects…, setup scripts, New worktree mode, removing or renaming a project, and project sort order (Recent, Created, Manual).
