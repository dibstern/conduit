Feature: Theme menu in the session list bar

Scenario Outline: Choosing a theme applies it at once and survives a reload
  Given the theme starts as <start> with the OS in dark mode
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the session list is showing
  Then the app shows the <start> theme
  And the theme button shows a <start_icon>
  When I open the theme menu
  Then the theme menu offers Light, Dark and System with <start> checked
  And the screen region visually matches theme-menu-open-<viewport>-<start> at <threshold> percent
  When I choose the <choice> theme
  Then the theme menu is closed
  And the app shows the <choice> theme
  And the theme button shows a <choice_icon>
  When I reload the theme session list
  Then the app shows the <choice> theme
  And the theme button shows a <choice_icon>
  When I open the theme menu
  Then the theme menu offers Light, Dark and System with <choice> checked

Examples:
  | viewport | start | start_icon | choice | choice_icon | threshold |
  | desktop  | dark  | moon       | light  | sun         | 99        |
  | desktop  | light | sun        | dark   | moon        | 99        |
  | phone    | dark  | moon       | light  | sun         | 99        |
  | phone    | light | sun        | dark   | moon        | 99        |

Scenario Outline: System follows the OS appearance live
  Given the theme starts as dark with the OS in light mode
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the session list is showing
  When I open the theme menu
  And I choose the system theme
  Then the app shows the light theme
  And the theme button shows a sun
  When the OS switches to dark mode
  Then the app shows the dark theme
  And the theme button shows a moon
  When I open the theme menu
  Then the theme menu offers Light, Dark and System with system checked

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario: Escape closes the theme menu without changing the theme
  Given the theme starts as dark with the OS in light mode
  And the conduit app is served with the connected mockup
  And the session list is showing
  When I open the theme menu
  And I press Escape in the theme menu
  Then the theme menu is closed
  And the app shows the dark theme
  And the theme button shows a moon

Scenario: The phone list bar fits the theme button and keeps touch-sized rows
  Given the theme starts as dark with the OS in dark mode
  And the conduit app is served with the connected mockup
  And the viewport is a phone
  And the session list is showing
  Then the phone list bar fits Theme, Select, New session and Settings
  When I open the theme menu
  Then every theme menu row is at least 44 pixels tall
