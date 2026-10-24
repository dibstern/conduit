Feature: Conduit Flow identifies session activity on desktop and phone

Scenario Outline: Session states share the Flow mark and Running headers stay still
  Given the session sheet theme is <theme>
  And the viewport is a <viewport>
  And the conduit app is served with the long-transcript mockup
  And the sidebar has the Flow status fixture
  Then the Flow session glyphs distinguish running, unread and idle
  And the Running group Flow glyph stays still
  And the session-list region visually matches <baseline> at <threshold> percent
  When the Flow motion preference is reduced
  Then the Flow session packet is a static highlight

Examples:
  | viewport | theme | baseline                  | threshold |
  | desktop  | dark  | flow-session-dark-desktop | 100       |
  | desktop  | light | flow-session-light-desktop| 100       |
  | phone    | dark  | flow-session-dark-phone   | 100       |
  | phone    | light | flow-session-light-phone  | 100       |
