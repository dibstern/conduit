Feature: Cursor forks use the existing conversation view

Scenario Outline: fork a completed reply and continue without changing its source
  Given the conduit app is served with the connected mockup
  And a Cursor account is available with its live models
  And the harness logo is viewed in the <tier> tier
  And a completed <provider> conversation is ready to fork
  Then the completed reply offers Fork from here
  When I fork the completed reply
  Then the relay receives the selected fork point
  And the fork opens with collapsed prior conversation and a source link
  And the messages region visually matches <shot> at <threshold> percent
  And the fork composer keeps the <provider> account
  When I expand the fork's prior conversation
  Then the fork shows only context through the selected reply
  When I continue the fork with a marker question
  Then the fork reply appears outside its prior conversation
  When I return through the fork's source link
  Then the source conversation still has its original messages

Examples:
  | tier  | provider | shot                       | threshold |
  | wide  | Cursor   | cursor-fork-cursor-wide    | 98        |
  | phone | Cursor   | cursor-fork-cursor-phone   | 98        |
  | wide  | Claude   | cursor-fork-claude-wide    | 98        |
  | phone | Claude   | cursor-fork-claude-phone   | 98        |
  | wide  | OpenCode | cursor-fork-opencode-wide  | 98        |
  | phone | OpenCode | cursor-fork-opencode-phone | 98        |
