Feature: Draft attachment labels in the sidebar
  A Draft without text is recognisable by its paperclip and attachment counts.

  Scenario Outline: Textless Draft label counts images and files
    Given the conduit app is served with the connected mockup
    And the sidebar has a textless Draft with <images> images and <files> files
    Then the Draft sidebar label is <label> with a paperclip
    And the session-list region visually matches <baseline> at <threshold> percent

    Examples:
      | images | files | label             | baseline                   | threshold |
      | 1      | 0     | 1 image           | draft-sidebar-one-image    | 99        |
      | 2      | 0     | 2 images          | draft-sidebar-images       | 99        |
      | 1      | 1     | 1 image, 1 file   | draft-sidebar-mixed        | 99        |
      | 0      | 1     | 1 file            | draft-sidebar-one-file     | 99        |
      | 0      | 2     | 2 files           | draft-sidebar-files        | 99        |
      | 2      | 2     | 2 images, 2 files | draft-sidebar-mixed-plural | 99        |
