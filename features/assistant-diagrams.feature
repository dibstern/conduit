Feature: Assistant messages draw mermaid diagrams with pele in conduit's theme

Scenario Outline: a finished message draws its diagram in the current theme
  Given the theme starts as <theme> with the OS in <theme> mode
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And I open a composer session
  When the transcript contains a finished assistant message with a flowchart diagram
  Then the assistant message draws the diagram
  And the last-diagram region visually matches assistant-diagram-<viewport>-<theme> at <threshold> percent

Examples:
  | viewport | theme | threshold |
  | desktop  | light | 99        |
  | desktop  | dark  | 99        |
  | phone    | light | 99        |
  | phone    | dark  | 99        |

Scenario: switching theme recolours the diagram without redrawing it
  Given the theme starts as dark with the OS in dark mode
  And the conduit app is served with the connected mockup
  And the viewport is a desktop
  And I open a composer session
  When the transcript contains a finished assistant message with a flowchart diagram
  Then the assistant message draws the diagram
  When I note the drawn diagram and its node colour
  And I open the theme menu
  And I choose the light theme
  Then the noted diagram is still on screen with a different node colour

Scenario: a streaming diagram stays a code block until the message finishes
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And I open a composer session
  When the mock relay starts a composer turn
  And the mock relay streams an assistant message with a flowchart diagram
  Then the streaming message shows the diagram source in a mermaid code block
  And no diagram is drawn
  When the mock relay finishes the assistant message
  Then the assistant message draws the diagram
  And no mermaid code block is left

Scenario: a diagram with a syntax error shows where it broke and its source
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And I open a composer session
  When the transcript contains a finished assistant message with a broken flowchart diagram
  Then the diagram error names line 2 and puts a caret under column 22
  And the diagram source is shown below the error

Scenario: an unsupported diagram type says why it cannot be drawn
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And I open a composer session
  When the transcript contains a finished assistant message with an unknown diagram type
  Then the diagram error says No diagram type detected for the given text.
  And the diagram source is shown below the error

Scenario: clicking or pressing Enter on a drawn diagram does not copy the message
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And I open a composer session
  When the transcript contains a finished assistant message with a flowchart diagram
  Then the assistant message draws the diagram
  When I click the drawn diagram twice
  And I press Enter on the drawn diagram twice
  Then the assistant message is not primed to copy
  When I click the assistant message text
  Then the assistant message is primed to copy

Scenario: a session's diagrams are drawn once its replay ends
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And I open a composer session
  And the transcript contains a finished assistant message with a flowchart diagram
  When I reload the page
  Then the assistant message draws the diagram

Scenario: one Retry recovers every diagram whose renderer failed to download
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And I open a composer session
  And the sequence diagram renderer fails to download once
  When the transcript contains a finished assistant message with a flowchart and two sequence diagrams
  Then the first diagram is drawn and the other two say the renderer failed to load
  When I note the drawn diagram and its node colour
  And I press Retry on one failed diagram
  Then every diagram in the assistant message is drawn
  And the noted diagram is still on screen

Scenario: only a diagram shrunk to fit shows zoom controls
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And I open a composer session
  When the transcript contains a finished assistant message with a wide and a small flowchart
  Then the wide diagram shows zoom controls and the small one does not

Scenario: a plain wheel over a diagram scrolls the conversation and ctrl+wheel zooms it
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And I open a composer session
  When the transcript contains a finished assistant message with a tall, a wide and a tall flowchart
  And I scroll the wide diagram to the middle of the conversation
  And I turn the mouse wheel down over the wide diagram
  Then the conversation scrolls and the wide diagram is not zoomed
  When I turn the mouse wheel up over the wide diagram while holding Control
  Then the wide diagram is zoomed

Scenario: pressing + on a focused diagram zooms it
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And I open a composer session
  When the transcript contains a finished assistant message with a wide flowchart
  And I focus the wide diagram and press +
  Then the wide diagram is zoomed

Scenario: a tall diagram fits a capped height without being cropped
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And I open a composer session
  When the transcript contains a finished assistant message with a tall flowchart
  Then the diagram is at most 380 pixels tall and shows all of it

Scenario: the code toggle shows the source and switches back to the same drawing
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And I open a composer session
  When the transcript contains a finished assistant message with a flowchart diagram
  Then the assistant message draws the diagram
  When I note the drawn diagram and its node colour
  And I press Show code on the diagram
  Then the diagram shows its source instead of the drawing
  When I press Show diagram on the diagram
  Then the noted diagram is still on screen
  When I press Copy code on the diagram
  Then the clipboard holds the diagram source

Scenario: Expand opens the diagram centred in the media viewer with zoom controls and all of it visible
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And I open a composer session
  When the transcript contains a finished assistant message with a tall flowchart
  And I press Expand diagram on the diagram
  Then the media viewer shows the diagram centred with zoom controls and all of it visible

Scenario: on a phone Expand opens the diagram fullscreen and the close button closes it
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And I open a composer session
  When the transcript contains a finished assistant message with a flowchart diagram
  And I press Expand diagram on the diagram
  Then the media viewer fills the screen with a close button at least 44 pixels square
  When I close the media viewer
  Then the media viewer is dismissed

Scenario: ctrl+wheel zooms the expanded diagram, Escape resets it and a second Escape closes it
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And I open a composer session
  When the transcript contains a finished assistant message with a flowchart diagram
  And I press Expand diagram on the diagram
  And I turn the mouse wheel up over the expanded diagram while holding Control
  Then the expanded diagram is zoomed
  When I press Escape in the media viewer
  Then the expanded diagram is back to its fit and the media viewer is still open
  When I dismiss the media viewer with Escape
  Then the media viewer is dismissed

Scenario: the expanded diagram is named and closing it returns focus to Expand
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And I open a composer session
  When the transcript contains a finished assistant message with a flowchart diagram
  And I press Expand diagram on the diagram
  Then the media viewer is named Expanded diagram
  When I close the media viewer
  Then the Expand diagram button has focus

Scenario: a diagram that failed to draw has no Expand button
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And I open a composer session
  When the transcript contains a finished assistant message with a broken flowchart diagram
  Then the diagram error names line 2 and puts a caret under column 22
  And the diagram has no Expand button

Scenario: a diagram still loading has no Expand button
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And I open a composer session
  And the sequence diagram renderer never finishes downloading
  When the transcript contains a finished assistant message with a sequence diagram
  Then the diagram is still loading and has no Expand button
