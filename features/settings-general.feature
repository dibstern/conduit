Feature: General groups everyday settings and keeps connection debug in Advanced

Scenario Outline: General orders its groups and Advanced reflects the debug toggle
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And General auto-settle is set to 3 days
  When I open settings to the General section
  Then the General headings are Notifications, Appearance, Composer and Sessions in order
  And General keeps Theme in Appearance and auto-settle in Sessions
  And General has no log level control
  And the General Advanced group is collapsed with Debug off
  And the settings-panel region visually matches <collapsedBaseline> at <threshold> percent
  When I expand General Advanced
  Then the General Advanced group is expanded with Debug off
  When I toggle the General connection debug panel
  Then the General Advanced group is expanded with Debug on
  And the settings-panel region visually matches <expandedBaseline> at <threshold> percent

Examples:
  | viewport | collapsedBaseline                    | expandedBaseline                    | threshold |
  | desktop  | settings-general-collapsed-desktop    | settings-general-expanded-desktop   | 98        |
  | phone    | settings-general-collapsed-phone      | settings-general-expanded-phone     | 98        |
