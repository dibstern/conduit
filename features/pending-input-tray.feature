Feature: Messages sent while a turn runs wait in a tray above the composer

Background:
  Given the conduit app is served with the connected mockup

Scenario Outline: one queued message shows as one Queued row
  Given the viewport is a <viewport>
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  When the open session starts working
  Then the pending-input tray is not visible
  When the mock relay queues <first>
  Then the pending-input tray has 1 row
  And pending-input row 1 reads <first>
  And pending-input row 1 shows no images
  And the composer region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | first                                  | baseline                   | threshold |
  | phone    | Also run the Linux baselines afterwards | pending-tray-one-phone     | 98        |
  | desktop  | Also run the Linux baselines afterwards | pending-tray-one-desktop   | 98        |

Scenario Outline: two queued messages keep their order and leave as each starts
  Given the viewport is a <viewport>
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  When the open session starts working
  And the mock relay queues <first>
  And the mock relay queues <second> with 2 images
  Then the pending-input tray has 2 rows
  And pending-input row 1 reads <first>
  And pending-input row 1 shows no images
  And pending-input row 2 reads <second>
  And pending-input row 2 shows 2 images
  And the composer region visually matches <baseline> at <threshold> percent
  When the queued message <first> starts
  Then the pending-input tray has 1 row
  And pending-input row 1 reads <second>
  When the queued message <second> starts
  Then the pending-input tray is not visible

Examples:
  | viewport | first                                  | second                                                                  | baseline                 | threshold |
  | phone    | Also run the Linux baselines afterwards | Compare these two screenshots and tell me which spacing matches the design | pending-tray-two-phone   | 98        |
  | desktop  | Also run the Linux baselines afterwards | Compare these two screenshots and tell me which spacing matches the design | pending-tray-two-desktop | 98        |

Scenario Outline: the send button queues while working and sends when idle
  Given the viewport is a <viewport>
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  When the open session starts working
  Then send is hidden while the field is empty
  And stop is a 32 pixel square filled with the text colour around a 10 pixel square
  When I type <message> into the composer
  Then the send button reads Queue message
  And send and stop are both visible
  And the composer region visually matches <baseline> at <threshold> percent
  When the open session goes idle
  Then the send button reads Send

Examples:
  | viewport | message                | baseline                     | threshold |
  | phone    | Then update the README | composer-queue-message-phone   | 98        |
  | desktop  | Then update the README | composer-queue-message-desktop | 98        |
