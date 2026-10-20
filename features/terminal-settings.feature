Feature: Terminal settings control desktop and phone keys and shared key behavior

Scenario Outline: Terminal has grouped desktop and phone controls and key behavior settings
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And Terminal settings have their defaults on <platform>
  When I open settings to the Terminal section
  Then Terminal shows the desktop and phone key groups and behavior controls on <platform>
  And the settings-panel region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | platform | baseline                  | threshold |
  | desktop  | macOS    | terminal-settings-desktop | 98        |
  | phone    | iOS      | terminal-settings-phone   | 98        |

Scenario Outline: A phone edits a row key with its current action selected
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And Terminal settings have their defaults on iOS
  When I open settings to the Terminal section
  And I set the first phone key Tap action to Home
  Then the phone key editor shows Home selected for Tap
  And the screen region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                           | threshold |
  | terminal-settings-phone-key-editor | 98        |

Scenario Outline: A phone introduces Terminal in the first settings group
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And Terminal settings have their defaults on iOS
  When I open the settings section list
  Then the Terminal tile follows General and has a New tag
  And the settings-panel region visually matches <baseline> at <threshold> percent
  When I open the Terminal tile and return to the settings section list
  Then the Terminal New tag is gone

Examples:
  | baseline                          | threshold |
  | terminal-settings-phone-root-new | 98        |

Scenario Outline: Desktop key groups follow their parent switch
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And Terminal settings have their defaults on <platform>
  When I open settings to the Terminal section
  And I turn off Keys in the tab bar
  Then Terminal hides the desktop key group switches
  And the settings-panel region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | platform | baseline                          | threshold |
  | desktop  | macOS    | terminal-settings-bar-off-desktop | 98        |
  | phone    | iOS      | terminal-settings-bar-off-phone   | 98        |
