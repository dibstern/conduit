Feature: Recover attachment saves in the composer

Scenario Outline: saving attachments block Send until acknowledged
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And a session already exists on the Claude harness
  And the next draft attachment save is held
  When I type Keep this text into the composer
  And I open the composer add menu
  And I choose a draft <kind> attachment
  Then the draft attachment is saving
  And the send button is false
  And the composer region visually matches <saving_baseline> at 98 percent
  When I acknowledge the held draft attachment save
  Then the draft attachment is saved
  And the send button is true
  And the composer region visually matches <saved_baseline> at 98 percent

Examples:
  | viewport | kind  | saving_baseline             | saved_baseline             |
  | desktop  | image | draft-image-saving-desktop  | draft-image-saved-desktop  |
  | phone    | file  | draft-file-saving-phone     | draft-file-saved-phone     |

Scenario Outline: failed attachments can be retried or removed
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And a session already exists on the Claude harness
  And the next draft attachment save is held
  When I type Keep this text into the composer
  And I open the composer add menu
  And I choose a draft <kind> attachment
  Then the draft attachment is saving
  When I fail the held draft attachment save
  Then the draft attachment is failed
  And the send button is false
  And the composer region visually matches <baseline> at 98 percent
  When I <action> the failed draft attachment
  Then the draft attachment recovery is <result>
  And the send button is true

Examples:
  | viewport | kind  | action | result | baseline                   |
  | desktop  | image | retry  | saved  | draft-image-failed-desktop  |
  | phone    | image | remove | absent | draft-image-failed-phone    |
  | desktop  | file  | remove | absent | draft-file-failed-desktop   |
  | phone    | file  | retry  | saved  | draft-file-failed-phone     |
