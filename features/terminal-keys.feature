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

Scenario Outline: a narrow desktop terminal panel folds the keys into a menu
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  When I open a new terminal tab
  And I narrow the terminal panel
  Then the terminal keys are folded into the Keys menu
  And the terminal-tab-bar region visually matches <bar_baseline> at <threshold> percent
  When I open the terminal Keys menu
  Then the terminal Keys menu contains paste, esc, tab, the four modifiers and the four arrows
  And the terminal-keys-menu region visually matches <menu_baseline> at <threshold> percent

Examples:
  | bar_baseline                 | menu_baseline              | threshold |
  | terminal-keys-folded-desktop | terminal-keys-menu-desktop | 98        |

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

Scenario Outline: a touch phone gets the flick row under the terminal instead
  Given the viewport is a touch phone
  And the conduit app is served with the long-transcript mockup
  When I open a new terminal tab
  Then the terminal key row is paste or copy, esc or tab, ⌃ or ⌘, ⌥ or ⇧, the arrow pad and the keyboard toggle
  And the keyboard is up
  And the terminal-panel region visually matches <baseline> at <threshold> percent

Examples:
  | baseline            | threshold |
  | terminal-keys-phone | 98        |

Scenario Outline: flicking up shows the corner key in a bubble before it's sent
  Given the viewport is a touch phone
  And the conduit app is served with the long-transcript mockup
  When I open a new terminal tab
  And I flick up on the <key> terminal key and hold
  Then the flick bubble shows <corner>
  And the terminal-panel region visually matches <baseline> at <threshold> percent
  And I lift my finger

Examples:
  | key    | corner | baseline                   | threshold |
  | Escape | Tab    | terminal-keys-phone-bubble | 98        |

Scenario Outline: a phone key's tap and flick modifiers wait and lock on their own
  Given the viewport is a touch phone
  And the conduit app is served with the long-transcript mockup
  When I open a new terminal tab
  And I tap the Control terminal key
  And I <gesture> terminal key
  And I <gesture> terminal key
  Then the Control terminal key is waiting
  And the <locked> terminal key is locked
  And the terminal-key-row region visually matches <baseline> at <threshold> percent

Examples:
  | gesture                     | locked  | baseline                                 | threshold |
  | tap the Option              | Option  | terminal-keys-phone-ctrl-waiting-opt-locked | 98     |
  | flick up on the Control     | Command | terminal-keys-phone-ctrl-waiting-cmd-locked | 98     |

Scenario Outline: the keyboard toggle hides the software keyboard and keeps the row
  Given the viewport is a touch phone
  And the conduit app is served with the long-transcript mockup
  When I open a new terminal tab
  And I tap the Keyboard terminal key
  Then the keyboard is down
  And the terminal-key-row region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                          | threshold |
  | terminal-keys-phone-keyboard-down | 98        |
