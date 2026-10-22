Feature: Phone send button sends while the keyboard is open

Background:
  Given the viewport is a phone
  And the conduit app is served with the long-transcript mockup

Scenario Outline: tapping send with the keyboard open sends the message
  When I type <message> into the composer
  And I tap the send button with the keyboard open
  Then the relay receives the sent text <message>

Examples:
  | message     |
  | hello world |

Scenario Outline: a second tap where send was does not stop the turn it started
  When I type <message> into the composer
  And I tap the send button
  And the mock relay starts a composer turn
  And I tap where the send button was
  Then the relay receives the sent text <message>
  And the relay is not asked to stop the turn
  When I tap the stop button after it arms
  Then the relay is asked to stop the turn

Examples:
  | message     |
  | hello world |
