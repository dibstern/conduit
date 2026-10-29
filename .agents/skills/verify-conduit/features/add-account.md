# Add an account

A user adds an account for a harness in Settings › Server › Instances. The form picks a type (Claude account, OpenCode server, Cursor account, Codex account), a name, and an optional config folder. The new account shows in the instance list with its login status. Once a harness has an account, it appears in the model picker and new sessions run on it. A second account of the same type can be made the default, and removing it falls back to the first. Cursor was added from scratch and used for a session. A second Claude account was added, made default and removed. Codex and OpenCode were seen in the type picker but not added.

## Sub-features

- `account-add-open` covers opening the form with **Add** under Instances. The model picker's **Add account** should open the same place. That path was not clicked.
- `account-add-type` covers the Type radios. The name placeholder follows the type (`Work Claude`, `Work Cursor`). Cursor and Codex also show an Environment variables expander.
- `account-add-save` covers **Add instance**, the new row, and its login status.
- `account-use` covers the harness appearing in the picker, and a session running on the new account.
- `account-default` covers **Make default** on a second account of the same type.
- `account-remove` covers **Remove**, its confirm dialog, and the default falling back.

## How to get to it (user POV)

- More actions › **Settings** › **Server**. Under **Instances**, click **Add**.
- Or open the model picker in a draft and click **Add account** (`picker-add-account-btn`). The code sends it to the same tab, but that was not driven.
- Click a row to open it. Edit, Make default and Remove are inside.

## Driving it with playwright-cli

Launch without the seeded Cursor account, so Cursor starts missing.

```bash
D="test-results/verify-conduit/$RUN_ID/add-account"
mkdir -p "$D"
$V up --no-seed-accounts
cfg=$($V info | node -pe 'JSON.parse(require("fs").readFileSync(0)).configDir')
root=$($V info | node -pe 'JSON.parse(require("fs").readFileSync(0)).root')
$V click '[data-testid=model-picker-trigger]'
$V screenshot --file "$D/01-picker-before.png"
$V press Escape

$V click 'role=button[name="More actions"]'
$V click '[data-testid=overflow-settings]'
$V click '[data-testid=settings-tab-server]'
$V click '[data-testid=add-instance-btn]'
$V click 'role=radio[name="Cursor account"]'
$V fill '[data-testid=instance-form-name]' 'Cursor replay'
$V click '[data-testid=instance-form-save]'
$V eval '() => [...document.querySelectorAll("[data-testid^=instance-row-]")].map(e => e.dataset.testid + ": " + e.textContent.replace(/\s+/g, " ").trim())'
$V screenshot --file "$D/02-after-add.png"
$V click '[data-testid=settings-close-btn]'

$V click '[data-testid=model-picker-trigger]'
$V eval '() => [...document.querySelectorAll("[data-testid^=picker-harness-]")].map(e => e.dataset.testid)'
$V press Escape
$V send 'Say hello' --harness cursor --model composer-2.5 --provider cursor
$V store sql "select id, provider, model_provider from sessions"

# A second Claude account: make it default, then remove it
mkdir -p "$root/claude-work"
$V click 'role=button[name="More actions"]'
$V click '[data-testid=overflow-settings]'
$V click '[data-testid=settings-tab-server]'
$V click '[data-testid=add-instance-btn]'
$V fill '[data-testid=instance-form-name]' 'Work Claude'
$V fill '[data-testid=instance-form-configdir]' "$root/claude-work"
$V click '[data-testid=instance-form-save]'
$V click '[data-testid=instance-row-work-claude]'
$V click '[data-testid=instance-row-work-claude] [data-testid=make-default-btn]'
python3 -c "import json;d=json.load(open('$cfg/daemon.json'));print([i['id'] for i in d['instances']], d['accountDefaults'])"
$V click '[data-testid=instance-row-work-claude] [data-testid=remove-instance-btn]'
$V screenshot --file "$D/03-remove-confirm.png"
$V click 'role=dialog[name^="Remove instance"] >> role=button[name="Confirm"]'
python3 -c "import json;d=json.load(open('$cfg/daemon.json'));print([i['id'] for i in d['instances']], d['accountDefaults'])"
$V home    # then reopen Settings › Server and list the rows again
```

Check these results:

- Before: the picker offers Claude, Codex and OpenCode, with no Cursor. Instances lists `claude`, `codex-2` and `opencode`.
- The form is titled `New instance`. Type defaults to Claude account, and the name placeholder is `Work Claude`. Picking Cursor account changes it to `Work Cursor` and shows Environment variables.
- After **Add instance** the form closes with no alert. The new row is `instance-row-cursor-replay` and reads `Cursor replay default Logged in`, with Log in to Cursor, Log out and Refresh status.
- `daemon.json` `instances` gains `{id: "cursor-replay", name: "Cursor replay", driver: "cursor"}`, and `accountDefaults.cursor` is `cursor-replay`.
- The picker now has `picker-harness-cursor`. A Cursor send replies `Hi David — good to meet you. What would you like to work on today?`. The session's `provider` is `cursor-replay`, which is the new account's id.
- `Work Claude` shows its config folder in its row. Inside the row are Edit, Make default and Remove.
- **Make default** moves the `default` label to Work Claude and sets `accountDefaults.claude` to `work-claude`.
- **Remove** asks `Remove instance "Work Claude"? This cannot be undone.` with Cancel and Confirm. After Confirm, `work-claude` is gone and `accountDefaults.claude` is back to `claude`.
- After the reload, the rows are `claude`, `cursor-replay`, `codex-2` and `opencode`.

## Gotchas

- Without `--no-seed-accounts`, the launcher has already added `Cursor replay`, so Cursor is never missing. With the default launch, add a second account instead.
- "Logged in" comes from the Cursor recording, which stores a credential. No real login runs, so Log in to Cursor, Log out and Refresh status are unverified.
- Even before any Cursor account exists, the Server tab's Cursor account section shows a `Logged in` status. That looks wrong. It is probably the replay's stored credential showing through, but it is not confirmed.
- No session was run on `Work Claude`, so sending on a second Claude account is unverified.
- `$V eval` on `[role=dialog]` returns nothing for the Remove confirm, but `snapshot` and `role=dialog[...]` selectors find it.
- Not checked: adding Codex accounts or OpenCode servers, Edit, environment variables, **Scan**, and the picker's **Add account** path.
