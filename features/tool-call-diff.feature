Feature: Tool-call diffs
  A file-writing step in a turn's log opens the change its tool reported,
  labelled with where that change came from. A shell step reports no change
  of its own, so it links to its turn's diff, where shell writes show.

Scenario Outline: A file-writing step opens its own diff, labelled with where the change came from
  Given message surfacing is inactive at Most
  And the conduit app is served with the connected mockup
  And the viewport is a desktop
  And the Edit step's change to <path> came from <source>
  And the tool session has a settled turn
  When I expand the surfaced turn
  And I open the Edit step
  And I open the step's diff
  Then the step diff lists <path>
  And the <path> diff shows its patch
  And the step diff says "<label>"
  And the messages region visually matches <baseline> at 98 percent

Examples:
  | path       | source         | label                      | baseline           |
  | src/app.ts | the provider   | Reported by the provider   | tool-diff-provider |
  | src/app.ts | the tool input | Read from the tool's input | tool-diff-input    |

Scenario Outline: A Write the provider called new is labelled when the file was already there
  Given message surfacing is inactive at Most
  And the conduit app is served with the connected mockup
  And the viewport is a desktop
  And the Write step's change to <path> came from the provider, noting <note>
  And the tool session has a settled turn
  When I expand the surfaced turn
  And I open the Write step
  And I open the step's diff
  Then the step diff lists <path>
  And the <path> diff is labelled "<label>"

Examples:
  | path       | note      | label                        |
  | notes.md   | replaced  | Replaced an existing file    |
  | draft.md   | unchecked | May replace an existing file |

Scenario Outline: A shell step links to its turn's diff instead of a diff of its own
  Given message surfacing is inactive at Most
  And the conduit app is served with the connected mockup
  And the viewport is a desktop
  And the tool session's turn changed <first_path> and <second_path>
  And the tool session has a settled turn
  When I expand the surfaced turn
  And I open the Bash step
  Then the Bash step has no diff of its own
  When I open the turn diff from the Bash step
  Then the turn diff lists <first_path> and <second_path>
  And the messages region visually matches <baseline> at 98 percent

Examples:
  | first_path | second_path | baseline           |
  | shell.txt  | src/util.ts | tool-diff-bash-turn |
