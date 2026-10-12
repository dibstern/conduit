Read-only audit. No files changed.

References below use:

- **R**: [reference.html](/Users/dstern/.local/share/design-visual-ui/conduit-settings/reference.html)
- **O**: `src/lib/frontend/components/overlays/`
- **U**: `src/lib/frontend/components/ui/`
- App paths are relative to `/Users/dstern/src/personal/conduit-settings-style`.

Dimensions are unscaled CSS values. The app sets `html` to **12px** at `style.css:481`; Tailwind spacing is `.25rem`, so `px-3 = 9px`, `py-2 = 6px`, and `min-h-10 = 30px`. Its font overrides are `text-xs = 10px` and `text-sm = 11px`, at `style.css:172-176`.

The requested dark-theme mappings match exactly: `--dim → text-dimmer #676e79`, `--muted → text-muted #838b98`, `--sec → text-secondary #a8afbb`, `--bsub → border-subtle #20242b`, `--border → border #2d323b`, `--surf → bg-surface #141619`, and `--alt → bg-alt/input-bg #1b1e24` (`R:8`; `style.css:44-63`).

**These are literal differences, not automatically defects.** The spec explicitly retains shell styling (`R:303,310`), General help text (`R:315`), Claude controls/content/provenance (`R:329-330`), and Usage’s existing layout/content (`R:334`). Those exceptions are identified below.

1. **High visibility. Desktop rail selection.**  
   Mockup: `.ri.on`, `R:73`, uses pink `#fe3781` on `rgba(254,55,129,.12)`. App: `U/segmented-styles.ts:136`, `bg-bg-alt text-text`, produces `#1b1e24` with `#eceef2` text. The selected section loses the mockup’s prominent pink treatment. **Confidence high;** `R:303` also instructs retaining the existing Tabs component.

2. **High visibility. Shared settings-row density, across General, Models, Claude, Server, and Usage limit switches.**  
   Mockup: `.row`, `R:85`, specifies padding `8px 12px`, gap `12px`, minimum height `40px`. App: `U/SettingsRow.svelte:48,65,79`, `px-3 py-2 min-h-10 gap-3`, resolves to padding `6px 9px`, gap `9px`, minimum height `30px`. One-line rows are substantially shorter and more tightly inset. **Confidence high;** description-bearing rows can grow beyond either minimum.

3. **High visibility. Composer’s Icons/Words and Context warning segments.**  
   Mockup: `.seg/.seg b`, `R:93-96`, uses one joined border, radius `7px`, internal border-left separators, padding `4px 9px`, weight `500`, secondary inactive text, and pink selected text/fill. App: `O/ComposerSettingsTab.svelte:29,41` uses the default `"field"` variant (`U/SegmentedControl.svelte:45`); `U/segmented-styles.ts:108-111` gives separate `flex-1` bordered buttons, `4.5px` gaps, `3px` radii, `10px` text, padding `4.5px 9px`, muted inactive text, and primary selected text on pink at `.10` opacity. Both controls have a visibly different shape and selection hierarchy. **Confidence high.**

4. **High visibility. Extra Sessions rows in General.**  
   Mockup: `GENERAL`, `R:450`, contains only “Settle idle sessions after.” App: `O/SessionsSettingsTab.svelte:42-88` adds “Default repository grouping” and “Default session mode” above it, with descriptions and selects. Sessions occupies substantially more space and has a different information order. **Confidence high;** whether these are newer intended features is outside the reference.

5. **High visibility. Model defaults move between sections.**  
   Mockup: Models starts with its filter (`R:453`), while Claude includes “Default model” (`R:455`). App: `O/VisibilitySettingsTab.svelte:200-256` inserts a “Default models” card containing model selects of `220px` and optional effort/context selects of `100px`; `O/ClaudeSettingsTab.svelte:407-419` contains only the approval default. Both sections begin differently, and Models requires more scrolling. **Confidence high;** design-age intent is uncertain.

6. **High visibility. Phone Usage panel becomes full screen.**  
   Mockup: `pm`, `R:596`, draws every phone panel at `351 × 608px` within a `375 × 760px` screen. App: `O/SettingsPanel.svelte:75,185-194` changes Usage to a sheet with `width:100vw`, `height:100dvh`, no border, no radius, and safe-area padding. Usage fills the phone instead of remaining a centred rounded dialog. **Confidence high;** Usage is explicitly retained by `R:334`.

7. **High visibility. Usage account cards do not fold.**  
   Mockup: `.ubody`, `R:239`, is hidden unless its card is open; `UCARD` supplies a chevron at `R:536`, with toggling at `R:619`. App: `U/SortableList.svelte:241` renders every details snippet unconditionally and supplies no card disclosure chevron. All account details remain visible, making the list much taller. **Confidence high; retained Usage layout.**

8. **High visibility. Phone Usage meters stack.**  
   Mockup: `.mgrid`, `R:217,238`, remains `1fr 1fr` on phones, with a `10px` gap. App: `O/UsageSettingsTab.svelte:221`, `grid … md:grid-cols-2`, has one column below the desktop breakpoint. Each phone account places Week below 5h rather than beside it. **Confidence high; retained Usage layout.**

9. **High visibility. Single-account Usage composition.**  
   Mockup: `USAGE('one')`, `R:552`, uses a bordered `.cardx` with label/reset text on the left and percentages on the right, without bars. App: `O/UsageSettingsTab.svelte:244-251` uses a borderless stack with `11px` gaps and full-width `6px` meter bars (`:182`). The entire single-account presentation changes. **Confidence high; retained Usage layout.**

10. **High visibility. No-plan-limits Usage state.**  
    Mockup: `R:548-549` ends with a framed empty explanation: surface background, subtle border, radius `9px`, and `.empty` padding `10px 12px` (`R:84,177`). App: `O/UsageSettingsTab.svelte:198-202,254-268` adds a “Claude” subheader, uses an unframed paragraph in `12px/1.5` dimmer text, and still renders warning/limit controls. The empty state has different framing and additional controls. **Confidence high; retained Usage content.**

11. **High visibility. Usage alerts and limits grouping.**  
    Mockup: `LIMITS`, `R:544-546`, places “Alerts and limits,” Warn me at, an internal caption, and switches in one card. The caption is uppercase `10.5px`, tracking `.07em`, muted, with padding-top `9px` and bottom `2px`. App: `O/UsageSettingsTab.svelte:256` makes Warn me at a separate bordered row; `O/UsageLimitsSettings.svelte:15` adds another group whose external title is normal-case `12px/600`, primary text (`U/SettingsGroup.svelte:82`). The controls read as separate groups rather than one hierarchy. **Confidence high; retained Usage layout.**

12. **High visibility. Usage forecast disclosure and explanatory content.**  
    Mockup: `UCARD`, `R:539,618`, presents a pace row with “Forecast ›” or “Hide forecast” and a collapsible forecast. App: `O/UsageSettingsTab.svelte:229-235` directly displays the selected forecast account’s chart; other accounts get only a trailing `›`, which stays unchanged when expanded. `O/UsageForecast.svelte:54,80` adds a prose forecast sentence and optional other-window summary absent from `R:529-534`. Forecast visibility and information hierarchy differ substantially. **Confidence high; retained Usage content; initial account selection is data-dependent.**

13. **High visibility. Server instance-row chevrons move to the left.**  
    Mockup: `acctRow/ocRow`, `R:459-467`, puts the chevron after the name/config directory or port. App: `O/InstancesSettingsTab.svelte:344,387` uses `Disclosure`, whose chevron precedes all children (`U/Disclosure.svelte:157-168`). The dot and name shift inward, and expansion is signalled at the opposite end. **Confidence high;** placement intent is unspecified.

14. **High visibility. Add instance Type picker placement.**  
    Mockup: `ADDFORM`, `R:472`, puts the joined segment beside “New instance” in the heading, with a `10px` gap (`R:172`). App: `O/InstancesSettingsTab.svelte:282-288` places a separate “Type” row below the heading, using the separate-button field recipe described in item 3. The form gains another row and a different control shape. **Confidence high;** `R:359` requires a Type segment but does not settle its placement.

15. **High visibility. Expanded Server instance details.**  
    Mockup: `.ix`, `R:160,198`, pads `9px 12px 10px 40px` on desktop and uses `12px` left padding on phones, with a white `.015` wash. `.kv`, `R:162-164`, uses `11px`, column gap `14px`, row gap `3px`, and single-line ellipsis. App: `O/InstancesSettingsTab.svelte:355-365,396-404` uses padding `6px 9px` in both layouts, solid `#1b1e24`, `10px` text, column gap `9px`, and wrapping/break-all values. Expanded details lose their desktop indentation and become brighter, smaller-text blocks that can wrap. **Confidence high;** wrapping may be intentional.

16. **High visibility. Expanded Claude Attribution.**  
    Mockup: `R:457` contains three individual label/control/provenance rows, with dropdown-style attribution controls. App: `O/ClaudeSettingsTab.svelte:364-405,493-498` stacks Commit and Pull request labels above full-width text inputs, includes a Session link description, and uses one shared attribution provenance row. The expanded group has a different structure and substantially greater height. **Confidence high; expressly retained by `R:329-330`.**

17. **Medium visibility. Inherited line height across the panel.**  
    Mockup: `.ui`, `R:50`, sets `1.35`; headings and labels inherit it. App: `style.css:482` sets `1.5`, without a panel-level override (`O/SettingsPanel.svelte:79,150`). Thus the `14px` title has a `21px` line box instead of `18.9px`, plain `12px` headings have `18px` instead of `16.2px`, and `12.5px` row labels have `18.75px` instead of `16.875px`. Text has looser vertical rhythm despite the smaller row padding. **Confidence high;** explicit `leading-*` and text-scale recipes are exceptions.

18. **Medium visibility. Desktop and phone rail-item geometry.**  
    Mockup: `.ri`, `R:71`, uses flex alignment, gap `8px`, padding `7px 10px`, and `12.5px` text; phone rules at `R:189` use padding `12px` and `14px` text. App: `U/segmented-styles.ts:135` uses padding `6px 8px`, `11.5px/15px` desktop text, then `13px` text and minimum height `44px` on phones; flex alignment is phone-only. The desktop rail is tighter, and phone labels are smaller and less inset. **Confidence high.**

19. **Medium visibility. Rail hover fill.**  
    Mockup: `.ri:hover`, `R:72`, adds surface `#141619`. App: the unselected recipe at `U/segmented-styles.ts:137` changes only text colour, without a hover background. Hovered sections lack the mockup’s filled row. **Confidence high.**

20. **Medium visibility. Content padding and phone body size.**  
    Mockup: `.content`, `R:78`, pads `14px 18px 22px`; phone `R:192` uses `12px 14px 20px` and `12px` body text. App: `O/SettingsPanel.svelte:150` uses `14px 18px` and `11.5px` on ordinary phones as well as desktop. Usage alone changes to `12px 14px` with bottom `26px + safe-area` (`:194`). Ordinary phone content is narrower, and desktop content loses `8px` of bottom breathing room. **Confidence high.**

21. **Medium visibility. Panel corners, shadow, and backdrop.**  
    Mockup: `.modal`, `R:64`, uses radius `12px` and shadow `0 24px 70px rgba(0,0,0,.7)`; `.scrim`, `R:61`, is black at `.55`, without blur. App: `O/SettingsPanel.svelte:79` uses `rounded-xl = 9px` and `shadow-2xl = 0 25px 50px -12px rgba(0,0,0,.25)`; subtle Dialog backdrop is `rgba(6,7,9,.15)` with `8px` blur (`U/Dialog.svelte:201-203`; `style.css:141`; Tailwind theme `:477`). The app has tighter corners and a much lighter, blurred surrounding scene. **Confidence high; deliberately retained shell styling under `R:303,310`.**

22. **Medium visibility. Header controls and header height.**  
    Mockup: `.ib`, `R:67`, has a `28 × 28px` box, radius `8px`, and `15px` glyph text. App: back uses `h-7 w-7 = 21 × 21px`, radius `6px`, SVG `16px` (`O/SettingsPanel.svelte:89,93`); close uses `p-1 = 3px` around SVG `16px` (`:104-112`; `U/Button.svelte:216`). The smaller controls make the header shorter. **Confidence high for boxes; medium for glyph comparison because font glyphs and SVGs are different measurements.** Close hover intentionally has no fill under `R:310`.

23. **Medium visibility. Collapsible group headers.**  
    Mockup: `.gh/.nm/.chev`, `R:108-111`, uses padding `8px 12px`, gap `8px`, inherited title size `11.5px` desktop/`12px` phone, and a `10px` muted chevron box. App: `U/SettingsGroup.svelte:66` fixes titles at `12.5px`; default Disclosure padding/gap is `6px 9px`/`7.5px`, and its chevron is `10.5px`, dimmer (`U/Disclosure.svelte:79,162`). Headers have larger titles but tighter horizontal spacing and darker arrows. **Confidence high.**

24. **Medium visibility. Collapsible-header hover background.**  
    Mockup: `.gh`, `R:108`, has no hover wash. App: `U/Disclosure.svelte:72,75` uses `overlay-soft`, defined as white at `.03` in `U/button-recipes.ts:95`. Group and instance headers acquire an additional hover highlight. **Confidence high.**

25. **Medium visibility. Consecutive Models provider-card spacing.**  
    Mockup: `.grp`, `R:107`, has bottom margin `6px`; `R:453` renders consecutive groups. App: `U/SettingsGroup.svelte:53` adds `9px` top margin, while `O/SettingsPanel.svelte:150` adds a `7px` flex gap. Provider cards are **16px apart**, making the collapsed list taller. **Confidence high.**

26. **Medium visibility. Models Show all / Hide all actions.**  
    Mockup: `.gl`, `R:113`, is pink, `11px`, nowrap, with `8px` left margin in an `8px`-gap header. App: `O/VisibilitySettingsTab.svelte:297,322` uses default `TextButton`, producing muted `#838b98`, inherited `11.5px`, and no explicit nowrap (`U/TextButton.svelte:55,83`). Its placement is outside the Disclosure, after that control’s right padding. The actions are quieter and differently separated from their summaries. **Confidence high.**

27. **Medium visibility. Models filter.**  
    Mockup: `.srch`, `R:117`, has padding `7px 10px`, radius `7px`, surface background `#141619`, and a `⌕` glyph in `R:453`. App: `O/VisibilitySettingsTab.svelte:259-266` uses `TextInput size="sm"` without an icon; `U/field-styles.ts:73,94` gives height `24px`, horizontal padding `7.5px`, radius `4.5px`, `10px` text, and background `#1b1e24`. The filter is shorter, smaller, lighter-filled, and lacks the search mark. **Confidence high.**

28. **Medium visibility. Models explanatory note and extra copy.**  
    Mockup: `.note`, `R:118,453`, is `11px`, secondary text, gap `8px`, margin `8px 0 10px`, with one help line. App: `O/VisibilitySettingsTab.svelte:268-274` inherits `11.5px`, uses gaps `9px/3px`, colours the count muted, and adds “New models and agents appear automatically.” The note and space before the groups differ. **Confidence high;** mockup `class="muted"` has no CSS definition, so its count actually inherits secondary colour.

29. **Medium visibility. Agents heading spacing and absent empty section.**  
    Mockup: `R:80,453` gives a `6px` heading-to-card gap; `R:324` requires retaining Agents loading/empty states. App: `O/VisibilitySettingsTab.svelte:313-314` plus group margin/parent gap produces `16px` heading-to-card separation; `:312-334` renders the entire section only when `agentScopeId && filteredAgents.length > 0`, with no fallback. The populated heading is farther from its card, while an empty/loading list has no Agents section. **Confidence high for the render rules;** the reference does not specify exact fallback appearance.

30. **Medium visibility. General and Server selects.**  
    Mockup: `.sel`, `R:97-98`, uses padding `4px 10px`, radius `7px`, inherited `11.5px` desktop/`12px` phone text, and an explicit muted `10px` arrow. App: default Select (`U/Select.svelte:30,51-57`; `U/field-styles.ts:73,95`) uses height `27px`, horizontal padding `9px`, radius `4.5px`, and `11px` text. Call sites include Appearance `:15`, Sessions `:95`, and Server Logs `:49`. The selects have smaller text and tighter corners. **Confidence high for CSS; native arrow geometry is browser-dependent.**

31. **Medium visibility. Server form inputs and retained Claude numeric/text inputs.**  
    Mockup: `.inp/.inp.ph`, `R:135-136`, uses background `#0d0e11`, radius `7px`, padding `6px 9px`, minimum height `29px`, `12px` text, and dimmer placeholders. App: default TextInput (`U/TextInput.svelte:53,82-87`; `U/field-styles.ts:73-75,95`) uses background `#1b1e24`, radius `4.5px`, height `27px`, `11px` text, and muted placeholders. Inputs appear lighter-filled, smaller, and less rounded. **Confidence high; Claude’s control types are explicitly retained by `R:330`.**

32. **Medium visibility. Additional General help copy.**  
    Mockup: Browser alerts and Sound have no description (`R:447`); Controls has none, Context warning says only “Warn when context is this full” (`R:449`); Advanced ends at the shortcut (`R:451`). App adds:
    - Browser: “Show desktop notifications when tasks complete” (`O/NotificationsSettingsTab.svelte:95`).
    - Sound: “Play a sound when notifications are triggered” (`:101`).
    - Controls: “Icons puts model, effort and approvals in the composer as icon buttons. Words lists them as text under the field.” (`O/ComposerSettingsTab.svelte:26`).
    - Context: “Shows the Compact bar and turns the context % amber. Never hides both.” after the matching sentence (`:38`).
    - Advanced: “Shows WebSocket state transitions, timing, and lifecycle events.” after the matching shortcut (`O/DebugSettingsTab.svelte:15`).
    
    These descriptions create additional lines, particularly on phones. **Confidence high; expressly retained help text under `R:315`.**

33. **Medium visibility. Claude default approval control.**  
    Mockup: `R:455` shows visible segments “Ask / Edits / Auto / Full.” App: `O/ClaudeSettingsTab.svelte:312-323` uses a native select of `220px`, with “Full access” instead of “Full” (`permission-modes.ts:28-31`). The options disappear into a dropdown and the last label changes. **Confidence high; expressly retained by `R:330`.**

34. **Medium visibility. Additional Claude captions, descriptions, and explanatory paragraphs.**  
    Mockup: `R:455-457` contains no corresponding help blocks. App adds these exact strings:
    - “Conduit applies these when it starts a session.” (`O/ClaudeSettingsTab.svelte:409`).
    - “How Conduit handles tool approvals in a session you haven't set a mode for.” (`:414`).
    - “New sessions start in this mode; the approvals pill still overrides it for the session you're in. Claude Code ignores a default mode set in a project's settings files, so Conduit applies this one itself.” (`:328`).
    - “Permission rules aren't editable here. Conduit runs its own approval prompts, and a settings rule that auto-allows a tool would silently bypass them.” (`:421-424`).
    - “Claude reads these when a session starts. A session that's already running keeps the settings it started with until you reload it.” (`:428`).
    - “Compacts the conversation automatically when the context window fills up.” (`:433`).
    - “How much of the context window to leave before compacting.” (`:444`).
    - “Claude thinks before answering on models that support it. Turning this off disables thinking entirely.” (`:453`).
    - “Run your configured hooks and status line. Turning this off disables every hook, including any you rely on to block unsafe commands.” (`:467`).
    - “How long Claude keeps chat transcripts on disk before deleting them.” (`:478`).
    
    Claude is substantially more text-heavy and scrolls farther. **Confidence high; expressly retained content under `R:329-330`.**

35. **Medium visibility. Claude numeric controls.**  
    Mockup: `R:456` draws dropdown-style threshold and transcript controls. App: `O/ClaudeSettingsTab.svelte:337-361` uses `type="number"` inputs of `120px`; threshold has no displayed `%` suffix, while transcripts has a separate “days” span. The controls have different widths, affordances, and unit presentation. **Confidence high; retained by `R:330`; numeric fixture values excluded.**

36. **Medium visibility. Claude Attribution help and reload footer.**  
    Mockup: `R:457` has neither guidance nor a footer. App adds “What Claude adds to commits and pull requests it creates.” (`O/ClaudeSettingsTab.svelte:365`), “Leave a box empty to add no attribution at all. Reset restores the default.” (`:390-392`), and “Append the claude.ai session link to commits and pull requests created from web sessions.” (`:395`). After Attribution, `:501-513` adds “Restarts Claude on the current settings. Your conversation is kept.” and “Reload this session,” with `10px` gap and `8px` vertical padding. These additions enlarge the expanded group and add another action at the end. **Confidence high; retained Claude content.**

37. **Medium visibility. Server Claude list resting surface.**  
    Mockup: `.ilist`, `R:141`, uses surface `#141619` and radius `9px`. App: `O/InstancesSettingsTab.svelte:334` uses radius `7px` and no background, so transparent account rows show panel `#0d0e11`. The Claude list is darker and more tightly rounded than the OpenCode list. **Confidence high.**

38. **Medium visibility. Server instance-list headers.**  
    Mockup: `.ilh`, `R:142-143`, uses uppercase `10.5px/600`, tracking `.07em`, muted text, padding `7px 12px`, gap `8px`, and white `.015` fill. App: `O/InstancesSettingsTab.svelte:335-339,381-383` uses title-case `12px/600`, no tracking, primary text, padding `6px 9px`, gap `6px`, and solid `#1b1e24`; count/link text is `10px` instead of `11px`. The headers become larger, brighter titles. **Confidence high.**

39. **Medium visibility. Closed Server instance-row typography and padding.**  
    Mockup: `.ir/.inm/.port`, `R:144,152,159`, uses padding `8px 12px`, gap `9px`, names `12.5px/400`, and secondary values `11px/#838b98`. App: Disclosure defaults (`U/Disclosure.svelte:75,79`) produce padding `6px 9px`, gap `7.5px`; names are `11px/500`, while config directories/ports are `10px/#a8afbb` (`O/InstancesSettingsTab.svelte:348-351,390-393`). Rows are denser, with smaller names and brighter secondary values. **Confidence high; both declare minimum height `44px`.**

40. **Medium visibility. Server/rail health-dot palette and dot sizes.**  
    Mockup: `.dot`, `R:76-77`, uses healthy `#3fd69a`, starting `#f4b740`, unhealthy `#f4607a`, stopped `#6b7280`, at `7px`; account dots are `9px` (`R:150`). App: `stores/instance.svelte.ts:169-181` uses Tailwind green/yellow/red/zinc-500, whose exact values are `oklch(72.3% .219 149.579)`, `oklch(79.5% .184 86.047)`, `oklch(63.7% .237 25.331)`, and `oklch(55.2% .016 285.938)` in installed Tailwind theme `:75,51,15,243`. Rail/status dots are `6px` (`O/SettingsPanel.svelte:136-138`; `O/ServerStatusSettings.svelte:37`), OpenCode dots `6px`, and account dots `7px` (`O/InstancesSettingsTab.svelte:345,388`). Indicators are smaller, and instance-status hues do not equal the mockup tokens. **Confidence high;** the spec does request using the existing status helper.

41. **Medium visibility. Server status-card local spacing.**  
    Mockup: `.status`, `R:126-128,490`, uses padding `10px 12px`, gap `10px`, normal-weight `12.5px` status text, dot gap `7px`, and directly adjacent metadata. App: `O/ServerStatusSettings.svelte:34-40` uses padding/gap `9px`, status weight `600`, dot gap `4.5px`, and metadata top margin `3px`; metadata punctuation is separated into flex items with `6px` gaps. The status line is heavier, and its metadata has a different rhythm. **Confidence high.**

42. **Medium visibility. Phone Server status buttons stretch.**  
    Mockup: `.status .acts`, `R:202`, makes the action line full-width but leaves buttons intrinsic-width (`R:100`). App: `O/ServerStatusSettings.svelte:51-55` also applies `flex-1` to each phone button. Restart and Shut down fill the line instead of remaining compact. **Confidence high;** `R:346` requires a full-width action line but does not explicitly require stretched buttons.

43. **Medium visibility. Status-to-Instances separation.**  
    Mockup: Instances heading has top margin `16px` through `.h` (`R:80,492`). App: `O/ServerSettingsTab.svelte:34` supplies `7px` gap, with no additional top margin on `O/InstancesSettingsTab.svelte:247-249`. Instances begins `9px` closer to the status card. **Confidence high.**

44. **Medium visibility. Three nested Server-group gaps.**  
    Mockup: Claude-to-OpenCode gap is `8px` (`R:498`), setup-guide gap `6px` (`R:179`), and managed-form stack gap `9px` (`R:174`). App combines parent gaps with `SettingsGroup`’s `9px` top margin (`U/SettingsGroup.svelte:53`): `15px` between account/server lists when both exist (`O/InstancesSettingsTab.svelte:332,380`), `15px` before Setup guides (`:420,423`), and `18px` before Environment variables (`:281,318`). These nested cards are farther apart than drawn. **Confidence high.**

45. **Medium visibility. Add/Edit frame and field grid.**  
    Mockup: `.form/.fld/.fgrid`, `R:170,132-134`, uses border `#2d323b`, padding `12px`, field gap `8px`, label/input gap `4px`, secondary labels, and optional suffix opacity `.6`; Claude fields are `1fr 1.4fr` (`R:474`). App: `O/InstancesSettingsTab.svelte:281,293-306` uses border `#20242b`, padding `9px`, grid gap `6px`, label gap `3px`, muted labels, full-opacity “(optional),” and equal desktop columns. The form is more compressed and its field proportions differ. **Confidence high.**

46. **Medium visibility. Phone Add/Edit grid cascade.**  
    Mockup: phone `.fgrid` requests one column (`R:199`), but inline `grid-template-columns:1fr 1.4fr` and `1fr 1fr` in `R:474,479` override it. App: `O/InstancesSettingsTab.svelte:293` actually uses one column below `md`. The effective mockup keeps fields side by side while the app stacks them. **Confidence high for effective CSS; mockup intent is ambiguous because its declarations conflict.**

47. **Medium visibility. “Conduit starts it” switch placement.**  
    Mockup: `ADDFORM`, `R:478`, places the switch first, then the label, with the description pushed to the right by `.tg-row .sub` (`R:175-176`). App: `O/InstancesSettingsTab.svelte:291` uses SettingsRow, placing label/description on the left and switch on the right (`U/SettingsRow.svelte:69-75`). Both switch position and description alignment are reversed. **Confidence high.**

48. **Medium visibility. PIN/shutdown inline-panel tint and spacing.**  
    Mockup: `.inl`, `R:129-131`, uses padding `10px 12px`, white `.015` fill, or red `.06` warning fill. App: `O/ServerSecuritySettings.svelte:87` uses padding `9px`, no Change/Set wash, and red `.05` for Remove; shutdown has padding `9px` and no warning fill (`O/ServerStatusSettings.svelte:59`). The shutdown prompt also changes from normal weight with `3px` below it (`R:487`) to weight `600` with `9px` separation (`:60`). Inline confirmations blend differently into their cards. **Confidence high.**

49. **Medium visibility. Remove PIN field width and PIN footer wrapping.**  
    Mockup: `PINREMOVE`, `R:486`, puts its one field in a desktop three-column grid (`R:132`); `.fact`, `R:138`, does not wrap and uses gap `6px`. App: `O/ServerSecuritySettings.svelte:97` leaves Remove single-column; `:118` uses a wrapping footer with gap `4.5px`. Remove’s field fills the panel, and long errors can push buttons onto another line. **Confidence high for CSS; actual footer wrapping depends on width and message length.**

50. **Medium visibility. Scan-result presentation.**  
    Mockup: `.scan`, `R:168,504`, is a padded `7px 10px` note with radius `7px`, background `#1b1e24`, secondary `11px` text, and top margin `8px`; scanning appears there (`R:615`). App: `O/InstancesSettingsTab.svelte:480-491` uses an unboxed, unpadded muted `11px` paragraph and hides it while scanning, changing only Scan controls (`:262,421`). Scan feedback moves from a distinct note to plain text/buttons. **Confidence high; result placement is specified, in-progress presentation less firmly so.**

51. **Medium visibility. Empty OpenCode explanation and Setup guides shell.**  
    Mockup: `.empty`, `R:177-178`, has padding `10px 12px`, secondary body text, and paragraph bottom margin `8px`; `.guide .grp/.gh`, `R:180-181`, uses background `#0d0e11`, minimum header height `32px`, padding `6px 10px`. App: `O/InstancesSettingsTab.svelte:420-423` uses padding `6px 9px`, muted `10px` text, gap `6px`, and default SettingsGroup surface `#141619` with a `38px` header. The explanation is smaller while the guide shell is taller and lighter. **Confidence high; richer guide contents/copy buttons are explicitly retained by `R:361`.**

52. **Medium visibility. Empty/setup command-block styling.**  
    Mockup: `.cmd`, `R:182`, uses radius `6px`, padding `6px 9px`, white `.05` fill, and `10.5px/1.35` text. App: `O/InstancesSettingsTab.svelte:238` uses radius `3px`, padding `4.5px 7.5px`, solid `#1b1e24`, and `10px/1.625` text. Blocks have tighter framing but looser multiline text. **Confidence high; monospace-family differences excluded.**

53. **Medium visibility. Shared ordinary and filled buttons.**  
    Mockup: `.btn`, `R:100`, uses background `#1b1e24`, secondary `11.5px/400` text, radius `7px`, padding `4px 10px`, gap `5px`; ordinary hover changes border/text (`R:101`). App’s standard `size="sm"` secondary Button (`U/button-recipes.ts:213-216,378,483`) has no resting fill, primary `10px/500` text, height `24px`, radius `6px`, horizontal padding `9px`, gap `4.5px`, and a text-colour `.05` hover wash. Filled primary/danger buttons use `text-bg #0d0e11` rather than mockup white (`:197-200,228-231`; `R:103,105`). Server buttons are smaller, brighter at rest, and have different hover/fill contrast. **Confidence high; exact call-site variants are distinguished in item 65.**

54. **Medium visibility. Usage compact segments, desktop and phone.**  
    Mockup: `.seg`, `R:93-96`, has joined separators, radius `7px`, padding `4px 9px`, weight `500`, secondary inactive text, and pink selection. Warn me at inherits `11.5px` desktop/`12px` phone; forecast segments inherit `.fch`’s `10px` (`R:230,529`). App: `U/segmented-styles.ts:48-51` uses radius `8px`, no internal separators, padding `2px 7px`, `10.5px` text without a weight utility, muted inactive text, and primary text on `#3a414c` selection. Phone options gain minimum `44px` height/`36px` width; Usage’s warning row does not wrap (`O/UsageSettingsTab.svelte:256`). Selection changes colour and phone controls become much taller. **Confidence high; retained Usage controls.**

55. **Medium visibility. Usage account-card chrome.**  
    Mockup: `.ucard/.ulist`, `R:209-210`, uses surface `#141619`, subtle border `#20242b`, radius `9px`, padding `8px 12px 9px`, and list gap `6px`. App: `U/SortableList.svelte:211,223` uses background `#0d0e11`, border `#2d323b`, radius `12px`, padding `9px 11px`, and gap `8px`. Cards are darker, more strongly outlined, rounder, and farther apart. **Confidence high; retained Usage layout.**

56. **Medium visibility. Usage meter colour and single-account typography.**  
    Mockup: `.mbar`, `R:220-222`, uses track `#2d323b` and healthy fill `#3fd69a`; single rows use primary `12.5px` labels and muted `11px` resets (`R:88-89,552`). App: `O/UsageSettingsTab.svelte:178-192` uses track `#3a414c`, healthy fill `#a8afbb` (`utils/continuation.ts:224-229`), secondary `11px` labels, and dimmer `10.5px` resets. Healthy bars lose green, and single-account labels become smaller and quieter. **Confidence high; amber/red fills match; retained Usage styling.**

57. **Medium visibility. Forecast framing.**  
    Mockup: `.fc`, `R:229`, always has radius `9px`, padding `8px 10px`, top margin `8px`, amber border `.35`, and amber fill `.05`. App: `O/UsageForecast.svelte:49` gives framed forecasts radius `12px`, padding `10px 12px`, bottom margin `12px`, and no top margin; embedded forecasts have only `mt-[9px]`, with no frame/fill/padding. Forecasts are larger-framed in the single view and unframed inside account cards. **Confidence high; amber colours match; red/neutral reference frames are unspecified.**

58. **Medium visibility. Forecast header and chart rendering.**  
    Mockup: `.fch/FC`, `R:230,529-534`, has `ACCOUNT · FORECAST`, `10px`, tracking `.06em`, centred alignment, bottom margin `4px`, a `92px` chart with fixed `300 × 92` viewBox and `preserveAspectRatio="none"`, and `9px` chart text. App: `O/UsageForecast.svelte:51-69` uses start alignment, bottom margin `6px`, an additional `12px/1.45` sentence, a framed-only “Forecast” label with tracking `.05em`, a `76px` chart with measured-width viewBox, and `8px` chart text. The chart is shorter and its header is more explanatory. **Confidence high; trajectory coordinates excluded.**

59. **Medium visibility. Usage heading, subheader, and Refresh.**  
    Mockup: `.h/.usub/.lnk`, `R:80,206,242,549-554`, shows a `12px/600` heading on both layouts, muted `11px` subheader with margin `-2px 0 8px`, and pink Refresh. App: `O/UsageSettingsTab.svelte:197-201` uses a `14px` desktop-only heading, dimmer subheader with desktop top margin `2px` and bottom `12px`, and dimmer, always-underlined Refresh. Usage has a different phone introduction and quieter refresh action. **Confidence high; retained Usage presentation.**

60. **Medium visibility. Usage limit order and copy.**  
    Mockup: `R:542-546` puts “Auto-switch account” before “Auto-resume at reset,” beneath “When an account hits its limit,” with full descriptions on phones. App: `O/UsageLimitsSettings.svelte:15-35` puts “Auto-resume limited sessions” first, then “Auto-switch account when limited” on desktop or “Auto-switch account” on phone; heading says “reaches its limit.” Phone descriptions become “Same account, at reset.” and “First account above with quota.” The order, labels, and amount of help text change. **Confidence high; retained Usage copy.**

61. **Low visibility. “This computer” rail label, including the known issue.**  
    Mockup: `.rl`, `R:75`, has uppercase, weight `600`, tracking `.09em`, and margin `12px 10px 4px`, inheriting line height `13.5px`. Current app: `U/Tabs.svelte:103` already matches uppercase/weight/tracking, but uses `px-[8px]` and `leading-[15px]`, with matching top/bottom margins. The remaining difference is a `2px` smaller horizontal inset and `1.5px` taller line box. **Confidence high; the previously missing case/weight/tracking are already corrected in the current dirty file.**

62. **Low visibility. Advanced, Attribution, and startup top spacing.**  
    Mockup: wrappers use `14px` for Advanced (`R:451`), `10px` for Attribution (`R:457`), and `14px` for startup (`R:518`). App: group margin `9px` plus parent gap `7px` yields `16px` in each case (`U/SettingsGroup.svelte:53`; `O/SettingsPanel.svelte:150`; `O/ServerSettingsTab.svelte:34`). These groups begin `2px`, `6px`, and `2px` farther down respectively. **Confidence high.**

63. **Low visibility. Claude provenance spacing and Reset styling.**  
    Mockup: `.prov/.rst`, `R:122,125`, uses provenance top margin `3px`, internal gap `8px`, and secondary, underlined Reset. App: `O/ClaudeSettingRow.svelte:39,46,53-59` uses `6px` vertical gap and `9px` internal gap, with default muted, non-underlined TextButton (`U/TextButton.svelte:55,83-84`). Provenance sits farther below the setting, and Reset is less distinct. **Confidence high; today’s provenance is retained by `R:330`.**

64. **Low visibility. Claude provenance structure and equivalent-state copy.**  
    Mockup: `CR`, `R:440,455`, always gives the approval row a provenance line; app passes no provenance there (`O/ClaudeSettingsTab.svelte:411-418`; `O/ClaudeSettingRow.svelte:44`). For equivalent sources, mockup says “Claude defaults” and “🔒 From managed policy” (`R:456-457`); app says “From Claude defaults” and “Locked by managed policy,” without a lock glyph (`stores/claude-settings.svelte.ts:235-242,327-333`). Scalar overrides also use “Set here · … had …” instead of the mockup’s “overrides …” grammar (`:294-303`; `R:456`). Provenance has different row presence, wording, and icon treatment. **Confidence high for equivalent states; fake source assignments excluded; retained by `R:330`.**

65. **Low visibility. Server-specific button emphasis and sizing.**  
    Mockup: Shut down opener and account Edit are neutral `.btn` (`R:490,463`); PIN Change has pink border (`R:102,507`); Remove has error `.5` border (`R:104`). App: Shut down is red `danger-outline` (`O/ServerStatusSettings.svelte:55`), account Edit is pink `ghost-accent` (`O/InstancesSettingsTab.svelte:367`), PIN Change retains a neutral border despite accent text (`O/ServerSecuritySettings.svelte:77`; `U/button-recipes.ts:213`), and Remove also uses a neutral border (`:241-244`). Claude expanded actions additionally use radius `3px`, padding `3px 9px`, `10px` text, while OpenCode actions use standard `24px`-high sm buttons (`O/InstancesSettingsTab.svelte:367-371,408-414`). Actions have different emphasis and inconsistent sizes between the two lists. **Confidence high; primitive-choice intent is unspecified.**

66. **Low visibility. Default/discovered badges.**  
    Mockup: `.badge`, `R:106`, uses background `#1b1e24`, muted text, `1px #2d323b` border, and padding `1px 6px`. App: `O/InstancesSettingsTab.svelte:349,391` chooses `Badge variant="tag"`; `U/Badge.svelte:33,42` gives white `.05` fill, dimmer text, no border, and padding `1.5px 4.5px`. Badges are narrower, dimmer, and less outlined. **Confidence high; pill shape, `10px` size, and weight `500` match.**

67. **Low visibility. Startup values and preface.**  
    Mockup: `R:518` values inherit secondary `11.5px` desktop/`12px` phone because its `class="muted"` has no CSS rule; preface uses padding `8px 12px`. App: `O/ServerStartupSettings.svelte:25,29` uses padding `6px 9px` and explicitly muted `11px` values. Values and explanatory text are smaller and more tightly inset. **Confidence high.**

68. **Low visibility. Multiple expanded instance rows and cancelling Edit.**  
    Mockup: `R:621` toggles rows independently, permitting several expanded detail panes; Cancel at `R:614` closes only the form. App: `O/InstancesSettingsTab.svelte:68-69` keeps one expanded ID; Cancel invokes `closeInstanceForm`, which clears it for Edit (`:98,326`). The app closes previously visible details in these states. **Confidence high for source behaviour; intent is ambiguous because `R:344` restricts forms, not expanded rows.**

69. **Low visibility. Long keep-awake command wrapping.**  
    Mockup: command span in `R:510` uses ordinary word breaking. App: `O/ServerPowerSettings.svelte:83` adds `min-w-0 break-all`. Long command tokens can break internally instead of retaining whole words. **Confidence high for CSS; visible impact depends on content and width.**

70. **Low visibility. Usage account-header details.**  
    Mockup: `.uct/.adot/.ord`, `R:212,150,149`, uses gap `8px`, minimum header height `24px`, dot `9px`, and muted position numbers with fixed `10px` width/right alignment. App: `U/SortableList.svelte:226` uses gap `7px` with no header minimum; `O/UsageSettingsTab.svelte:210-212` uses dot `7px`, dimmer numbers without the width/alignment constraints, and truncates long account names. Phone names remain `11.5px` instead of inheriting `12px`. Header spacing, alignment, and overflow differ. **Confidence high; truncation visibility is content-dependent; retained Usage presentation.**

71. **Low visibility. Usage drag handle and lifted appearance.**  
    Mockup: `.hdl`, `R:148,536`, is `⋮⋮`, `13px`, tracking `-2px`; dragged cards use opacity `.4` (`R:211`). App: `U/SortableList.svelte:223,235-238` uses `⠿` at inherited `11.5px`, horizontal padding `2px`, margin `-2px` vertically, `leading-none`, and a shadow/raised layer instead of opacity reduction. Dragging has a different visible affordance and feedback. **Confidence high; retained SortableList interaction.**

72. **Low visibility. Usage meter, model-summary, explanation, hint, and pace offsets.**  
    Mockup: meter top gap `7px` (`R:217`), model-summary gap `6px` (`R:245`), no-data explanation `11px/#838b98/1.35` (`R:89,537`), order hint margin `6px 2px 0` (`R:244`), and pace top gap `7px` with muted trailing text (`R:224`). App: `O/UsageSettingsTab.svelte:221,225-226,232-234,241` uses gaps `8px/7px`, no-data text `10.5px/#676e79` with inherited line height, hint margin `6px 0 4px`, pace gap `6px`, and a dimmer trailing arrow. Several small offsets and secondary-text treatments differ. **Confidence high; retained Usage styling.**

73. **Low visibility. Usage Warn me at row and option copy.**  
    Mockup: `R:85,88,544` uses row padding `8px 12px`, gap `12px`, minimum height `40px`, label `12.5px`, and options `70% / 80% / 90% / Off`. App: `O/UsageSettingsTab.svelte:256-261` uses top margin `6px`, top padding `10px`, gap `8px`, minimum height `30px`, label `12px`, a `#2d323b` top border, lowercase `off`, and removes `%` on phones. The row has different spacing and slightly different labels. **Confidence high; retained Usage controls.**

74. **Low visibility. Usage banner and single-account subheader copy.**  
    Mockup: limited banner has radius `9px`, bottom margin `8px`, and says “first in the switch order” (`R:207,555`); single subheader includes account name and plan (`R:551`). App: `O/UsageSettingsTab.svelte:205` uses radius `12px` and bottom margin `12px`; `:141` says “next in the switch order”; `:200` substitutes the plan label for the account name when present. The banner is rounder/farther separated, and stable wording/name composition differs. **Confidence high; dynamic names, times, and quotas excluded; retained Usage copy.**

75. **Low visibility. Forecast strokes, marker, and annotations.**  
    Mockup: `R:232-236,533-534` uses past stroke `1.6`, projection `1.4` with dash `3 3`, limit opacity `.55`, red crossing dot radius `3`, and crossing-time/reset-clock annotations. App: `O/UsageForecast.svelte:67-76` uses past `2`, projection `1.5` with dash `4 3`, limit opacity `.6`, crossing radius `3.5` in `currentColor`—amber for runs-out forecasts—and only `limit / now / reset` labels. The chart is heavier and marks crossings differently. **Confidence high; fixture trajectories and clock values excluded; retained Usage chart.**

76. **Low visibility. Content scrollbar styling.**  
    Mockup: `.content`, `R:78`, requests thin scrollbars with thumb colour `#2d323b`. App: `style.css:453-469` uses white at `.15`, increasing to `.25` on hover, with explicit `6px` WebKit dimensions. Scrollbar colour and hover treatment differ where the browser exposes them. **Confidence high for declarations; medium for visibility because scrollbar rendering is platform-dependent.**

77. **Low visibility. Desktop height cap on short windows.**  
    Mockup: `modal`, `R:561,564`, declares `720 × 600px`; its desktop drawing stage is `960 × 680px` (`R:274`). App: `O/SettingsPanel.svelte:79,177-183` uses height `min(600px, round(down,80vh,1px))`, which is `544px` in a `680px`-high viewport. The app dialog shrinks on short desktop windows. **Confidence high for sizing rules; medium for comparison because the mockup stage is a simulated screen, not the document viewport; retained shell sizing under `R:303`.**

Files inspected included the reference’s complete mockup CSS, render templates, interaction handlers, and spec notes; all SettingsPanel section components; every `Server*Settings.svelte` component and `InstancesSettingsTab.svelte`; shared Tabs, SettingsGroup, SettingsRow, SegmentedControl/recipes, Button/recipes, TextInput, Textarea, field styles, Select, Disclosure, Dialog, TextButton, Badge, AccountDot, Icon, and SortableList; `style.css`; and focused permission-mode, account-colour, continuation, instance, Claude-settings, usage, and server-status sources.

I could not compare browser-dependent native arrows, exact text wrapping/glyph bounds, scroll extent, or runtime interaction timing without rendering. The mockup has no equivalent designs for most loading/disconnection/RPC-error states, Set PIN, or the keep-awake editor. Its environment textarea is an inline sketch span, so its declared minimum height is not a reliable rendered-height reference. Light-theme fidelity cannot be assessed against this dark-only mockup.

Font families, fake data/provenance assignments, mockup chrome, annotations, and chart trajectories were excluded. No application builds, test suites, Beads writes, or commits ran. Final checks preserved the original `Tabs.svelte` modification and confirmed the sampled source hashes were unchanged.