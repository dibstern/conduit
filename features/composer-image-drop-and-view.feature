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
  Then the media viewer shows the draft image
  And the screen region visually matches <baseline> at <threshold> percent
  When I close the media viewer
  Then the media viewer is dismissed
  And the composer shows the dropped PNG thumbnail
  And the file drop keeps the same page open

Examples:
  | viewport | baseline                              | threshold |
  | desktop  | composer-draft-image-media-viewer-desktop | 99        |
  | phone    | composer-draft-image-media-viewer-phone   | 99        |

Scenario Outline: view a sent image from the transcript
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And a session already exists on the Claude harness
  And the transcript contains a sent user message with an image attachment
  When I click the sent image thumbnail
  Then the media viewer shows the sent image
  And the screen region visually matches <baseline> at <threshold> percent
  When I dismiss the media viewer with Escape
  Then the media viewer is dismissed
  When I click the sent image thumbnail
  Then the media viewer shows the sent image
  When I close the media viewer
  Then the media viewer is dismissed

Examples:
  | viewport | baseline                         | threshold |
  | desktop  | transcript-image-media-viewer-desktop | 99        |
  | phone    | transcript-image-media-viewer-phone   | 99        |

Scenario: switching sessions closes the open media viewer
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And a session already exists on the Claude harness
  And a session already exists on the OpenCode harness
  When I switch to the "Claude session" session from the sidebar
  And the transcript contains a sent user message with an image attachment
  And I click the sent image thumbnail
  Then the media viewer shows the sent image
  When I go back in the browser to the previous session
  Then the media viewer is dismissed

Scenario: ctrl+wheel zooms the viewer image and Escape resets it before closing
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And a session already exists on the Claude harness
  And the transcript contains a sent user message with an image attachment
  When I click the sent image thumbnail
  Then the media viewer shows the sent image
  And the close button covers none of the viewer image's buttons
  When I turn the mouse wheel up over the viewer image while holding Control
  Then the viewer image is zoomed
  When I dismiss the media viewer with Escape
  Then the viewer image is back to its fit and the media viewer is still open
  When I dismiss the media viewer with Escape
  Then the media viewer is dismissed

Scenario: an image that fails to load in the media viewer says so
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And a session already exists on the Claude harness
  And the transcript contains a sent user message with an image that is still loading
  When I click the sent image thumbnail while it is still loading
  And the image fails to load
  Then the media viewer says Image couldn't load
