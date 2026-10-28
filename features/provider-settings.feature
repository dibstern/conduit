Feature: Providers shows a read-only account directory

Background:
  Given the conduit app is served with the connected mockup

Scenario Outline: four provider cards and the first account detail
  Given Providers has the approved account directory
  When I open settings to the Providers section
  Then Providers lists Claude, Codex, Cursor and OpenCode in order with account counts
  And the Providers detail shows personal with Max and default
  And Providers has no account actions, quota, models or defaults
  And every settings tab uses the wider dialog and Server keeps Instances
  And the settings-panel region visually matches provider-settings-desktop at <threshold> percent

Examples:
  | threshold |
  | 98        |

Scenario: signed-out Codex and OpenCode identity
  Given Providers has the approved account directory
  When I open settings to the Providers section
  Then the Codex lab row says Not signed in in amber
  When I pick the Providers account codex-lab
  Then the Providers detail shows lab with Codex login
  When I pick the Providers account ccs
  Then the Providers detail shows ccs with discovered
  When I pick the Providers account gpu-box
  Then the Providers detail shows gpu-box with stopped

Scenario Outline: an unavailable Cursor account says why in amber
  Given Providers has the approved account directory
  And the Providers Cursor account is unavailable because <reason>
  When I open settings to the Providers section
  Then the Providers cursor row says <reason> in amber

Examples:
  | reason                    |
  | Cursor SDK could not load |

Scenario Outline: empty provider cards explain how to get started
  Given no provider accounts are configured
  When I open settings to the Providers section
  Then Providers explains its empty cards and empty selection
  And the settings-panel region visually matches provider-settings-empty at <threshold> percent

Examples:
  | threshold |
  | 98        |

Scenario: account changes from another device update the open directory
  Given Providers has the approved account directory
  When I open settings to the Providers section
  And another device adds, renames and removes provider accounts
  Then Providers reflects the live account changes and keeps a valid selection
  When another device removes every provider account
  Then Providers explains its empty cards and empty selection

Scenario: the account list is keyboard navigable across cards
  Given Providers has the approved account directory
  When I open settings to the Providers section
  And I navigate Providers accounts with the keyboard
  Then the Providers detail shows codex with Plus and default

Scenario: long account lists scroll inside the fixed split
  Given Providers has many accounts
  When I open settings to the Providers section
  Then Providers has independent columns with a sticky header and a conditional fade

Scenario Outline: phone accounts push a named detail page
  Given the viewport is a phone
  And Providers has the approved account directory
  When I open settings to the Providers section
  Then the phone Providers page shows the account list only
  And the settings-panel region visually matches provider-settings-phone-list at <threshold> percent
  When I pick the Providers account codex-lab
  Then the phone Providers detail is titled lab with a back button to Providers
  And the settings-panel region visually matches provider-settings-phone-detail at <threshold> percent
  When I return from the Providers detail
  Then the phone Providers page shows the account list only

Examples:
  | threshold |
  | 98        |
