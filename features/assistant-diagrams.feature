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
