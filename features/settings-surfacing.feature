Feature: Surfacing settings keep secrets on the server and category edits in a draft

Scenario Outline: General shows key state and saves opt-in preferences
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And Surfacing has a <key_state> key in the <theme> theme
  When I open settings to Surfacing
  Then Surfacing shows the <key_state> key state without a saved secret
  And Surfacing is off with its disclosure visible
  And Jev availability matches the <key_state> key state
  And the settings-panel region visually matches surfacing-general-<key_state>-<viewport>-<theme> at <threshold> percent
  When I save a key if needed and enable Jev with Key as the default
  Then Surfacing preferences are saved through the daemon from the <key_state> key state
  And summary model timing and tuning persist while Surfacing is off

Examples:
  | viewport | key_state | theme | threshold |
  | desktop  | none      | dark  | 98        |
  | desktop  | valid     | light | 98        |
  | desktop  | invalid   | dark  | 98        |
  | desktop  | env       | light | 98        |
  | phone    | none      | light | 98        |
  | phone    | valid     | dark  | 98        |
  | phone    | invalid   | light | 98        |
  | phone    | env       | dark  | 98        |

Scenario Outline: Rejected environment keys stay read-only from the first load
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And Surfacing has a invalid-env key in the dark theme
  When I open settings to Surfacing
  Then Surfacing shows the invalid-env key state without a saved secret

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: Key entry is write-only
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And Surfacing has a none key in the dark theme
  When I open settings to Surfacing
  Then I can save and remove a TypeSafe key without showing it back

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: Categories support draft save discard retire restore reset and custom editing
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And Surfacing has a valid key in the <theme> theme
  When I open settings to Surfacing
  And I open Surfacing Categories
  Then category changes stay in a draft until Save
  And the settings-panel region visually matches surfacing-categories-<viewport>-<theme> at <threshold> percent
  Then I can discard save retire restore and reset a built-in category
  And I can validate add edit and delete a custom category
  And category limits and conflicting identities are validated

Examples:
  | viewport | theme | threshold |
  | desktop  | dark  | 98        |
  | desktop  | light | 98        |
  | phone    | dark  | 98        |
  | phone    | light | 98        |

Scenario Outline: A stale category version keeps the draft for comparison
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And Surfacing has a valid key in the dark theme
  When I open settings to Surfacing
  And I open Surfacing Categories
  And categories change elsewhere while I edit
  Then Surfacing reloads the current set and keeps my draft visible
  And the settings-panel region visually matches surfacing-stale-<viewport> at <threshold> percent
  Then discarding the stale draft allows saving against the reloaded version

Examples:
  | viewport | threshold |
  | desktop  | 98        |
  | phone    | 98        |
