Feature: Turn activity reads as a chronological log

Scenario Outline: Two skills appear where they happened with their own time column
  Given message surfacing is <jev> at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the turn log has two skills in a settled turn
  When I open the plain turn log
  Then the log shows both skills in order with sparkles, Skill, coloured names and times
  And the messages region visually matches turn-log-skills-<jev>-<viewport> at 98 percent

Examples:
  | viewport | jev      |
  | desktop  | active   |
  | phone    | active   |
  | desktop  | inactive |
  | phone    | inactive |
