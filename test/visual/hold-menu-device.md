# Physical HoldMenu proof

From `rd/voxy.5`, build and serve Storybook on the LAN:

```sh
export npm_config_verify_deps_before_run=false pnpm_config_verify_deps_before_run=false
mise exec -- pnpm storybook:build </dev/null
mise exec -- pnpm exec http-server dist/storybook -a 0.0.0.0 -p 6148 -c-1 </dev/null
```

On a physical iPhone in Safari and an Android phone in Chrome, open
`http://<host-LAN-IP>:6148/iframe.html?id=ui-holdmenu--device-probe&viewMode=story`.
Record the screen for the whole sequence on each phone:

1. Tap Snooze. Wait a second; the list stays open. Tap the dimmed view cards;
   only the list closes, the sheet stays open, and no action runs.
2. Hold Snooze for at least 450ms. Keep the finger down while the list opens,
   then slide down through several rows. The highlight follows the finger;
   the sheet stays still, nothing scrolls, and no callout or text selection
   appears. Release on This evening;
   the list and sheet close with one pick.
3. Reopen the sheet. Hold Snooze, slide off the list onto the view cards, and
   release. The list stays open. Tap the dimmed cards; only the list closes.
4. Swipe up starting on Snooze before 450ms. The long sheet scrolls without
   opening the list. Scroll back to the top and repeat the hold and downward
   slide; the sheet must stay still. Release on a time to pick it.
5. Close the sheet with its outer scrim, then tap Export device probe.

Save the recordings and exported logs under the gitignored directory
`test-results/hold-menu-devices/`: `iphone-safari.mov`, `iphone-safari.json`,
`android-chrome.mp4`, and `android-chrome.json`. Give the foreman the actual
paths, OS/browser versions, and any failed step for `conduit-test-voxy.5`.
Simulator evidence does not replace these physical recordings.
