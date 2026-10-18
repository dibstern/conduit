Feature: On-screen terminal keys

Scenario Outline: the desktop tab bar carries paste, esc, tab, the modifiers and the arrows
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  When I open a new terminal tab
  Then the terminal keys are paste, esc, tab, the four modifiers and the four arrows
  And the terminal-tab-bar region visually matches <baseline> at <threshold> percent

Examples:
  | baseline              | threshold |
  | terminal-keys-desktop | 98        |

Scenario Outline: a waiting ⌥ or ⌘ explains what its next key does
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  When I open a new terminal tab
  And I click the <modifier> terminal key
  Then the <modifier> terminal key is <state>
  And the terminal-panel region visually matches <baseline> at <threshold> percent

Examples:
  | modifier | state   | baseline                      | threshold |
  | Option   | waiting | terminal-keys-option-waiting  | 98        |
  | Command  | waiting | terminal-keys-command-waiting | 98        |

Scenario Outline: a second click locks a modifier
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  When I open a new terminal tab
  And I click the <modifier> terminal key
  And I click the <modifier> terminal key
  Then the <modifier> terminal key is <state>
  And the terminal-tab-bar region visually matches <baseline> at <threshold> percent

Examples:
  | modifier | state  | baseline                    | threshold |
  | Shift    | locked | terminal-keys-shift-locked  | 98        |

Scenario Outline: ⌘ then F opens the find bar over the terminal
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  When I open a new terminal tab
  And I click the Command terminal key
  And I type "f" on the keyboard
  And I type "<query>" on the keyboard
  Then the terminal find bar is open, searching for "<query>"
  And the terminal-panel region visually matches <baseline> at <threshold> percent

Examples:
  | query | baseline                | threshold |
  | build | terminal-keys-find-open | 98        |
