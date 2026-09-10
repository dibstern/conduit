Feature: Claude settings overrides are editable with truthful provenance

Background:
  Given the conduit app is served with the connected mockup

Scenario: opening the Claude tab shows the available settings
  When I open settings to the Claude tab
  Then the Claude settings are shown

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

Scenario Outline: the Claude tab matches the approved layout
  When I open settings to the Claude tab
  Then the settings-panel region visually matches <baseline> at <threshold> percent

Examples:
  | baseline           | threshold |
  | claude-settings-dark | 98        |
