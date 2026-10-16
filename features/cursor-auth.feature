Feature: Cursor login and credential status in the browser

Scenario Outline: log in without a terminal and use the authenticated account
  Given the conduit app is served with the connected mockup
  And Cursor UI authentication is logged out
  And the harness logo is viewed in the <tier> tier
  When I open settings to the Server section
  Then Cursor settings reports Not logged in
  When I start Cursor login in settings
  Then the Cursor login link and its separate flow deadline are shown
  And the instances-settings region visually matches cursor-login-<tier> at <threshold> percent
  When Cursor login completes for person@example.test
  Then Cursor settings reports Logged in as person@example.test
  And Cursor settings shows the key expiry without a login deadline
  And the Cursor account directory has one authenticated account
  When I close Cursor settings
  And I start a new session
  And I open the model picker
  And I view Harness choices in the picker
  Then the Cursor provider rail choice is available

Examples:
  | tier  | threshold |
  | wide  | 98        |
  | phone | 98        |

Scenario Outline: cancellation ignores a late status reply
  Given the conduit app is served with the connected mockup
  And Cursor UI authentication is logged out
  And the harness logo is viewed in the <tier> tier
  When I open settings to the Server section
  And I start Cursor login in settings
  Then the Cursor login link and its separate flow deadline are shown
  When a Cursor login status reply is held
  And I cancel Cursor login in settings
  And the late Cursor login status reply arrives
  Then Cursor login remains cancelled without a link

Examples:
  | tier  |
  | wide  |
  | phone |

Scenario Outline: warn before the key expires and log out
  Given the conduit app is served with the connected mockup
  And Cursor UI authentication is expiring
  And the harness logo is viewed in the <tier> tier
  When I open settings to the Server section
  Then Cursor settings reports Logged in as person@example.test
  And Cursor settings warns that the key expires soon
  And Cursor settings shows the key expiry without a login deadline
  And the instances-settings region visually matches cursor-expiry-<tier> at <threshold> percent
  When I log out of Cursor in settings
  Then Cursor settings reports Not logged in
  And Cursor settings no longer shows a key expiry
  And the Cursor account directory is unavailable

Examples:
  | tier  | threshold |
  | wide  | 98        |
  | phone | 98        |

Scenario Outline: the environment key takes precedence over SDK login
  Given the conduit app is served with the connected mockup
  And Cursor UI authentication is from environment
  And the harness logo is viewed in the <tier> tier
  When I open settings to the Server section
  Then Cursor settings reports From environment (CURSOR_API_KEY)
  And Cursor login and logout actions are hidden

Examples:
  | tier  |
  | wide  |
  | phone |

Scenario Outline: an authentication discovery failure offers login directly
  Given the conduit app is served with the connected mockup
  And Cursor UI authentication is logged out
  And a Cursor account is unavailable with reason Cursor authentication required. Log in to Cursor in Settings.
  And the harness logo is viewed in the <tier> tier
  When I start a new session
  And I open the model picker
  And I view Harness choices in the picker
  Then the model-picker region visually matches cursor-auth-picker-<tier> at <threshold> percent
  When I use the Cursor discovery login action
  Then the Cursor login link and its separate flow deadline are shown

Examples:
  | tier  | threshold |
  | wide  | 98        |
  | phone | 98        |
