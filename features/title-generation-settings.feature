Feature: One global picker chooses the account, model and effort used for session titles

Scenario Outline: Title generation uses the shared picker and saves a specific Claude account
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And title generation has a separate Work Claude account
  When I open settings to the Models & agents section
  Then title generation explains session titles and uses the built-in default
  When I open the title generation picker
  Then the title generation picker offers the Claude and OpenCode harnesses
  When I choose Work Claude, Sonnet 5 and high effort for titles
  Then the title generation RPC saves the specific Work Claude Sonnet high selection
  And the title-generation-picker region visually matches <picker_baseline> at <threshold> percent
  When I reload title generation settings
  And I open settings to the Models & agents section
  Then title generation shows Work Claude, Sonnet 5 and high effort
  And the settings-panel region visually matches <saved_baseline> at <threshold> percent

Examples:
  | viewport | picker_baseline                 | saved_baseline                   | threshold |
  | desktop  | title-generation-picker-desktop | title-generation-saved-desktop   | 98        |
  | phone    | title-generation-picker-phone   | title-generation-saved-phone     | 98        |

Scenario Outline: Reset clears the saved value and restores the built-in default after reload
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And title generation has a separate Work Claude account
  And title generation has the saved Work Claude Sonnet high selection
  When I open settings to the Models & agents section
  Then title generation shows Work Claude, Sonnet 5 and high effort
  When I reset title generation to the built-in default
  Then the title generation RPC clears the saved selection
  And title generation explains session titles and uses the built-in default
  When I reload title generation settings
  And I open settings to the Models & agents section
  Then title generation explains session titles and uses the built-in default
  And the settings-panel region visually matches <reset_baseline> at <threshold> percent

Examples:
  | viewport | reset_baseline                 | threshold |
  | desktop  | title-generation-reset-desktop | 98        |
  | phone    | title-generation-reset-phone   | 98        |

Scenario Outline: A saved selection reports a removed account and can be reset
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And title generation has a saved selection for a removed account
  When I open settings to the Models & agents section
  Then title generation shows the removed-account notice
  And the settings-panel region visually matches <removed_baseline> at <threshold> percent
  When I reload title generation settings
  And I open settings to the Models & agents section
  Then title generation shows the removed-account notice
  When I reset title generation to the built-in default
  Then title generation explains session titles and uses the built-in default

Examples:
  | viewport | removed_baseline                          | threshold |
  | desktop  | title-generation-removed-account-desktop   | 98        |
  | phone    | title-generation-removed-account-phone     | 98        |
