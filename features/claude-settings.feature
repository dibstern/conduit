Feature: Claude settings overrides are editable with truthful provenance

Background:
  Given the conduit app is served with the connected mockup

Scenario: opening the Claude tab shows the available settings
  When I open settings to the Claude tab
  Then the Claude settings are shown

Scenario: the Claude tab shows the default model and thinking level
  Given the default model is Claude Sonnet 4 with a thinking level of high
  When I open settings to the Claude tab
  Then the default model row shows Claude Sonnet 4
  And the default model row shows Thinking level: high

Scenario: changing auto-compact identifies when the change applies
  When I open settings to the Claude tab
  And I toggle Claude auto-compact
  Then the auto-compact provenance reads Applies to your next session

Scenario: resetting auto-compact returns it to inherited
  When I open settings to the Claude tab
  And I reset the Claude auto-compact setting
  Then the auto-compact provenance reads From your user settings

Scenario: managed policy locks a Claude setting
  When I open settings to the Claude tab
  Then the managed auto-compact threshold is disabled

Scenario: turning hooks off stores the inverted setting truthfully
  When I open settings to the Claude tab
  And I turn off Claude hooks and status line
  Then disableAllHooks is stored as true
  And the Claude hooks and status line toggle reads off

Scenario: changing the session link preserves inherited attribution
  When I open settings to the Claude tab
  And I turn off the Claude attribution session link
  Then the attribution override keeps the inherited commit text with the session link off

Scenario: changing the default approval mode elevates new sessions
  Given the default approval mode is Ask
  When I open settings to the Claude tab
  And I choose Full access as the default approval mode
  Then a SetDefaultPermissionMode RPC is sent with mode full
  And the default approval mode row shows the elevated-permissions warning

Scenario Outline: the Claude tab matches the approved layout
  When I open settings to the Claude tab
  Then the settings-panel region visually matches <baseline> at <threshold> percent

Examples:
  | baseline           | threshold |
  | claude-settings-dark | 98        |

Scenario Outline: the Claude tab attribution controls match the approved layout
  When I open settings to the Claude tab
  And I scroll the Claude settings to the Attribution row
  Then the settings-panel region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                         | threshold |
  | claude-settings-attribution-dark | 98        |
