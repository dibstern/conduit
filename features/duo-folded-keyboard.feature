Feature: The folded iPhone Duo hands the rail's controls to a full composer above the keyboard

# Folded portrait with the keyboard open (conduit-test-tw49i.5, mockup cards 7
# and 7f). iOS 26 floats its form bar at y316-363 and the keyboard from y375;
# the strip beside the form bar shows the page but takes no taps, so nothing
# tappable may sit below y316. Focusing the composer moves the rail's controls
# into one row of a full composer (K-full) at x22-374, y202-302, above the form
# bar, and the rail empties. With the keyboard closed, Effort and Directory live
# in the Model sheet. The controls glide there and back on one 350ms clock,
# 25ms apart, nearest first and Send last.
#
# The keyboard is up exactly while an editable field has focus, so focusing the
# composer opens it here, and blurring the field (the form bar's tick) closes it.
#
# Coordinates are CSS px in the installed app's measured 466x657 layout
# viewport, which the keyboard does not change.

Background:
  Given the conduit app is served with the long-transcript mockup
  And a session already exists on the Claude harness
  And the viewport is a duo folded portrait
  And the model offers effort levels low, medium, high, xhigh, max
  And the mock relay reports context 42 percent

Scenario Outline: Focusing the composer moves the rail into a full composer above the form bar
  When I focus the composer
  Then the keyboard is open
  And the composer row reads Attach at 26, Model at 74 to 190, Effort at 194, Permissions at 238, Directory at 282, Send at 326
  And the message field spans x 22 to 374 and y 202 to 302
  And the context hairline spans y 304 to 316
  And nothing tappable sits below y 316
  And nothing tappable sits in the rail
  And the composer region visually matches <composer> at <threshold> percent
  When the open session starts working
  Then the composer row reads Attach at 26, Model at 74 to 190, Effort at 194, Permissions at 238, Directory at 282, Stop at 326
  When I type keep going into the composer
  Then the composer row reads Attach at 26, Model at 74 to 118, Effort at 122, Permissions at 166, Directory at 210, Stop at 282, Send at 326
  And nothing tappable sits below y 316
  And the composer region visually matches <composer_working> at <threshold> percent

Examples:
  | composer   | composer_working   | threshold |
  | duo-kfull  | duo-kfull-working  | 98        |

Scenario: The controls glide in on one clock, nearest first and Send last
  When I focus the composer
  Then the controls glide in the order Permissions, Model, Effort, Directory, Attach, Send, 25 ms apart over 350 ms
  And Effort and Directory bud out of Model

Scenario: Closing the keyboard plays the glide in reverse and refills the rail
  When I focus the composer
  And the handoff settles
  And I close the keyboard
  Then the keyboard is closed
  And the controls glide in the order Send, Attach, Directory, Effort, Model, Permissions, 25 ms apart over 350 ms
  And Effort and Directory fold back into Model
  When the handoff settles
  Then the rail reads Settle at 260, More at 308, Send at 447, Permissions at 495, Model at 543, Attach at 591
  And the message field spans x 12 to 374 and y 587 to 639

Scenario: Reduced motion swaps the glide for a 150ms crossfade
  Given the motion preference is reduced
  When I focus the composer
  Then the controls crossfade over 150 ms without moving
  When the handoff settles
  Then the composer row reads Attach at 26, Model at 74 to 190, Effort at 194, Permissions at 238, Directory at 282, Send at 326

Scenario: A control keeps its state and handler in both places, and a tap keeps the keyboard up
  When I set effort to high
  And I focus the composer
  And the handoff settles
  And I tap the composer's Effort control
  Then the keyboard is open
  And the effort control names Extra high
  When I close the keyboard
  And the handoff settles
  And I open the phone Session panel
  Then the phone Session panel Effort row reads xhigh

Scenario Outline: Send in the full composer sends and keeps the keyboard up
  When I type <message> into the composer
  And the handoff settles
  And I tap the composer's Send control
  Then the relay receives the sent text <message>
  And the keyboard is open

Examples:
  | message     |
  | hello world |

Scenario: With the keyboard closed, Effort and Directory live in the Model sheet
  Then the composer shows no Effort or Directory control
  When I open the phone Session panel
  Then the Model sheet holds the Effort and Checkout rows
