Feature: A message can steer the running turn instead of waiting for it

Background:
  Given the conduit app is served with the connected mockup

Scenario Outline: a modified send steers, and a steering row sits above queued rows that offer Steer
  Given the viewport is a <viewport>
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  When the open session starts working
  And I type <steered> into the composer
  Then the send button title reads Queue message · ⌘/Ctrl+Enter or ⌘/Ctrl+click to steer
  When I steer the composer message with a modified click
  Then the relay is asked to steer <steered>
  When the mock relay steers <steered>
  And the mock relay queues <queued>
  Then the pending-input tray has 2 rows
  And pending-input row 1 is Steering <steered>
  And pending-input row 2 offers an enabled Steer
  And the stop button title reads Stop generating · A pending steer still runs
  And the composer region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | steered                          | queued                                 | baseline            | threshold |
  | phone    | Use the staging database instead | Also run the Linux baselines afterwards | steer-tray-phone    | 98        |
  | desktop  | Use the staging database instead | Also run the Linux baselines afterwards | steer-tray-desktop  | 98        |

Scenario Outline: Steer waits while the running turn has a prompt open
  Given the viewport is a <viewport>
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  When the open session starts working
  And the mock relay queues <queued>
  Then pending-input row 1 offers an enabled Steer
  When a prompt opens in the running turn
  Then pending-input row 1 offers a disabled Steer
  And hovering Steer on row 1 explains Answer the open prompt before steering
  And the screen region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | queued                                 | baseline                 | threshold |
  | phone    | Also run the Linux baselines afterwards | steer-prompt-open-phone   | 98        |
  | desktop  | Also run the Linux baselines afterwards | steer-prompt-open-desktop | 98        |

Scenario Outline: a refused steer keeps the draft and says why
  Given the viewport is a <viewport>
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  When the open session starts working
  And the relay refuses steers with model_differs
  And I type <message> into the composer
  And I steer the composer message with the keyboard
  Then the relay is asked to steer <message>
  And the composer says Not steered. The running turn uses a different model.
  And the composer still holds <message>
  And the pending-input tray is not visible
  And the composer region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | message                          | baseline              | threshold |
  | phone    | Use the staging database instead | steer-refused-phone   | 98        |
  | desktop  | Use the staging database instead | steer-refused-desktop | 98        |

Scenario Outline: a steered message is labelled in the transcript
  Given the viewport is a <viewport>
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  When the open session starts working
  And the transcript receives the steered message <message>
  Then the last user message is labelled Steered
  And the last-user-message region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | message                          | baseline              | threshold |
  | phone    | Use the staging database instead | steered-message-phone   | 98        |
  | desktop  | Use the staging database instead | steered-message-desktop | 98        |
