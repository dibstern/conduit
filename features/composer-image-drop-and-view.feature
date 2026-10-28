Feature: Drop and view image attachments

Scenario: drop a PNG outside the composer without leaving the page
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And a session already exists on the Claude harness
  When I drop a PNG onto the page outside the composer
  Then the draft attachment is saved
  And the composer shows the dropped PNG thumbnail
  And the relay receives only the dropped PNG with its original bytes and name
  And the file drop keeps the same page open

Scenario: keep the dropped image and explain unsupported files on Cursor
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And a Cursor account is available with its live models
  When I start a new session
  And I open the model picker
  And I view Harness choices in the picker
  And I select the Cursor Harness tab in the picker
  And I view Model choices in the picker
  And I select model Composer 2.5 in the picker
  And I close the model picker
  And I drop a PNG and a text file onto the page outside the composer
  Then the draft attachment is saved
  And the composer shows the dropped PNG thumbnail
  And the composer explains which harnesses support file attachments
  And the relay receives only the dropped PNG with its original bytes and name
  And the file drop keeps the same page open

Scenario Outline: view a draft image at full size
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And a session already exists on the Claude harness
  When I drop a PNG onto the page outside the composer
  Then the draft attachment is saved
  When I click the draft image thumbnail
  Then the lightbox shows the draft image
  And the screen region visually matches <baseline> at <threshold> percent
  When I close the image lightbox
  Then the image lightbox is dismissed
  And the composer shows the dropped PNG thumbnail
  And the file drop keeps the same page open

Examples:
  | viewport | baseline                              | threshold |
  | desktop  | composer-draft-image-lightbox-desktop | 99        |
  | phone    | composer-draft-image-lightbox-phone   | 99        |

Scenario Outline: view a sent image from the transcript
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And a session already exists on the Claude harness
  And the transcript contains a sent user message with an image attachment
  When I click the sent image thumbnail
  Then the lightbox shows the sent image
  And the screen region visually matches <baseline> at <threshold> percent
  When I dismiss the image lightbox with Escape
  Then the image lightbox is dismissed
  When I click the sent image thumbnail
  Then the lightbox shows the sent image
  When I close the image lightbox
  Then the image lightbox is dismissed

Examples:
  | viewport | baseline                         | threshold |
  | desktop  | transcript-image-lightbox-desktop | 99        |
  | phone    | transcript-image-lightbox-phone   | 99        |
