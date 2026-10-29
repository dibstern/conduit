Feature: Phone header controls fire when the finger lifts

# In the installed iOS app, a tap above about screen y64 never becomes a click,
# though pointerdown and pointerup still arrive (conduit-test-uwxj8). Header
# controls therefore fire on a short, still touch lift, and the browser's own
# click, if one follows, is dropped. "Never becomes a click" steps send only the
# pointer events, as iOS does in that band.

Background:
  Given the viewport is a phone
  And the conduit app is served with the long-transcript mockup

Scenario: A lift that iOS never turns into a click still goes back
  Given I count clicks on the session back button
  When I lift a touch on the session back button that never becomes a click
  Then the session list is open
  And the session back button received 1 click

Scenario: A tap that does become a click goes back once
  Given I count clicks on the session back button
  When I tap the session back button with a finger
  Then the session list is open
  And the session back button received 1 click

Scenario: The click that follows a lift does not reach what the lift revealed
  When I tap back to the session list
  And I tap the list Settings cog with a finger
  Then settings opens at the section list
  And the settings Done button sits over the list Settings cog
  When I tap the settings Done button with a finger
  Then settings stays closed

Scenario Outline: A touch that moves before it lifts is a drag, not a tap
  Given I count clicks on the session back button
  When I lift a touch on the session back button after moving <distance> pixels
  Then the session back button received <clicks> click

Examples:
  | distance | clicks |
  | 6        | 1      |
  | 14       | 0      |

Scenario Outline: A touch held too long before it lifts is not a tap
  Given I count clicks on the session back button
  When I lift a touch on the session back button after holding it for <ms> milliseconds
  Then the session back button received <clicks> click

Examples:
  | ms  | clicks |
  | 300 | 1      |
  | 900 | 0      |

Scenario: A click with no touch before it still goes back
  Given I count clicks on the session back button
  When a click with no touch arrives on the session back button
  Then the session list is open
  And the session back button received 1 click

Scenario: A mouse click goes back once
  Given I count clicks on the session back button
  When I click the session back button with a mouse
  Then the session list is open
  And the session back button received 1 click

Scenario: Enter goes back once
  Given I count clicks on the session back button
  When I press Enter on the session back button
  Then the session list is open
  And the session back button received 1 click

Scenario: A key pressed straight after a tap is not taken for its click
  When I tap the session back button with a finger
  And I press Enter on the list Select button
  Then the session list is selecting

Scenario: A menu trigger that opens on lift by itself opens once
  When I tap the session overflow button with a finger
  Then the overflow session sheet stays open

Scenario: A pen press on a menu trigger is left to the menu
  When I press the session overflow button with a pen for 600ms
  Then the overflow session sheet stays open

Scenario: A disabled header control stays inert
  Given the session header holds a disabled probe button
  And I count clicks on the probe button
  When I lift a touch on the probe button that never becomes a click
  Then the probe button received 0 click

Scenario: A control inside another fires itself once
  Given the session header holds a probe button inside a probe row
  And I count clicks on the probe button
  And I count clicks on the probe row
  When I lift a touch on the probe button that never becomes a click
  Then the probe button received 1 click
  And the probe row received 1 click
