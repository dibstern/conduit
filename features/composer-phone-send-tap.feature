Feature: Phone send button sends while the keyboard is open

Scenario Outline: tapping send with the keyboard open sends the message
  Given the viewport is a phone
  And the conduit app is served with the long-transcript mockup
  When I type <message> into the composer
  And I tap the send button with the keyboard open
  Then the relay receives the sent text <message>

Examples:
  | message     |
  | hello world |
