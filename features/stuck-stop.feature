Feature: A stuck Stop asks before it ends background tasks

Scenario: The stuck Stop names the tasks that closing would end, and the confirm carries the entry it showed
  Given message surfacing is active at Most
  And the conduit app is served with the connected mockup
  And the panel choice session has a live turn
  When the Stop is stuck at snapshot entry 7 with a dev server and a vitest shell without its command
  Then the panel choice turn head reads "Stop is stuck. Closing will end 2 tasks: pnpm dev (shell), (shell): Run vitest in watch mode"
  When I press Stop now on the stuck Stop
  Then the confirm reads "Stopping now will end: pnpm dev (shell), (shell): Run vitest in watch mode. Continue?"
  When I accept the confirm
  Then the stuck Stop was confirmed at snapshot entries 7

Scenario: With no snapshot the stuck Stop says the background state is unknown
  Given message surfacing is active at Most
  And the conduit app is served with the connected mockup
  And the panel choice session has a live turn
  When the Stop is stuck at snapshot entry 3 with no snapshot
  Then the panel choice turn head reads "Stop is stuck. Background state unknown"
  When I press Stop now on the stuck Stop
  Then the confirm reads "Background state unknown. Stopping now may end background work. Continue?"
  When I accept the confirm
  Then the stuck Stop was confirmed at snapshot entries 3

Scenario: A confirm made against an older snapshot is refused and asked again with the current list
  Given message surfacing is active at Most
  And the conduit app is served with the connected mockup
  And the panel choice session has a live turn
  When the Stop is stuck at snapshot entry 7 with a dev server and a vitest shell without its command
  And a newer snapshot at entry 8 names only the dev server before the confirm lands
  And I press Stop now on the stuck Stop
  And I accept the confirm
  Then the confirm reads "Stopping now will end: pnpm dev (shell). Continue?"
  When I accept the confirm
  Then the stuck Stop was confirmed at snapshot entries 7, 8

Scenario: Stop tasks first asks for every task without confirming, and waiting changes nothing
  Given message surfacing is active at Most
  And the conduit app is served with the connected mockup
  And the panel choice session has a live turn
  When the Stop is stuck at snapshot entry 7 with a dev server and a vitest shell without its command
  And I press Stop now on the stuck Stop
  And I cancel the confirm
  Then the stuck Stop was confirmed at snapshot entries none
  When I press Stop tasks first on the stuck Stop
  Then the stuck Stop asked to stop all tasks without confirming
  When the stuck Stop's ask ends
  Then the panel choice turn head reads "Working"

Scenario: On a phone the stuck Stop's whole label and both actions stay on screen
  Given message surfacing is active at Most
  And the conduit app is served with the connected mockup
  And the viewport is a phone
  And the panel choice session has a live turn
  When the Stop is stuck at snapshot entry 7 with a dev server and a vitest shell without its command
  Then the stuck Stop's whole label and both actions are on screen
  When I press Stop now on the stuck Stop
  Then the confirm reads "Stopping now will end: pnpm dev (shell), (shell): Run vitest in watch mode. Continue?"

Scenario: Deleting a session with live tasks asks with the tasks it would end, and the delete carries the entry
  Given message surfacing is active at Most
  And the conduit app is served with the connected mockup
  And the panel choice session has a live turn
  And the panel choice session's background is a dev server and a vitest shell without its command, and deleting it needs a confirm of snapshot entry 7
  When I delete the panel choice session
  And I accept the delete
  Then the confirm reads "Deleting will end: pnpm dev (shell), (shell): Run vitest in watch mode. Continue?"
  When I accept the delete
  Then the panel choice session's deletes carried confirms none, 7

Scenario: Dismissing the delete ask sends nothing more, and unknown tasks say so
  Given message surfacing is active at Most
  And the conduit app is served with the connected mockup
  And the panel choice session has a live turn
  And the panel choice session's background is being checked, and deleting it needs a confirm of snapshot entry 3
  When I delete the panel choice session
  And I accept the delete
  Then the confirm reads "Background state unknown. Deleting may end background work. Continue?"
  When I cancel the confirm
  Then the panel choice session's deletes carried confirms none
