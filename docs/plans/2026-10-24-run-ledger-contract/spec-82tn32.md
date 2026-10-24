○ conduit-test-82tn.32 [EPIC] · Run Ledger: single owner of run state for the run/control lifecycle   [P1 · OPEN]
Created by: dibstern · Type: epic
Created: 2026-10-22 · Updated: 2026-10-22

DESCRIPTION

  ## Problem Statement                                                        
                                                                              
  Conduit's run and control lifecycle (sending, steering, Stop, interrupts,   
  permission and question answers, runner crashes, daemon restarts, shutdown  
  drain) keeps producing small correctness bugs. Lane 82tn.27.3 took seven    
  review rounds and fourteen findings, 27.2 took five rounds and eleven       
  findings, and 10.4 and 82tn.18 show the same pattern. Users see the result  
  as sessions stuck busy, answers that never reach the agent, duplicated or   
  lost turns after a restart, and Stop that does not really stop.             
                                                                              
  The root cause is architectural: nothing owns the answer to "where is this  
  run?". At least five stores keep a copy of it: the runner's in-process      
  Claude session context (about forty optional flags), the provider command   
  outbox (its status is written from six modules), command receipts, the turns
  projection (whose run id is reassigned on retry), and the runner's send     
  journal and receipts, plus in-memory ownership sets, fences and deadline    
  fibers in the daemon that are rebuilt after restart. Each fix adds a special
  case that keeps these copies in step; each review round finds the next      
  interleaving where two copies disagree. The contract lives in prose (the    
  run-ownership plan's interleaving rules), two different functions classify  
  terminal events, and hand-written fakes drifted from the SDK.               
                                                                              
  ## Solution                                                                 
                                                                              
  One deep module, the **Run Ledger**, becomes the only owner of run state for
  every provider (Claude, Cursor, OpenCode). Every other view (outbox         
  delivery, receipts, turns, inbox busy, the frontend's run status) is derived
  from it. A pure decider defines every legal transition as a tagged-union    
  state machine, so illegal combinations cannot be represented and every      
  interleaving can be generated and checked by tests before review. A session 
  has at most one active run (the t3code model): a message sent during a run  
  steers that run, and a finished run's id is tombstoned so late events cannot
  reopen it. Runners become stateless executors. Deadlines are data on the    
  run, so a restart rebuilds nothing and no run can wait forever.             
                                                                              
  From the user's perspective: sessions never stay busy after their run is    
  over, answers to permissions and questions are delivered exactly once even  
  across restarts, Stop always ends the run (killing and respawning a runner  
  that will not let go), and restarts never duplicate or lose a message.      
                                                                              
  ## User Stories                                                             
                                                                              
  1. As a conduit user, I want a session to show busy only while a run is     
  really active, so that I am never stuck waiting on a session that has       
  finished.                                                                   
  2. As a conduit user, I want my message sent while the agent is working to  
  steer the current run, so that I can redirect the agent without starting a  
  parallel run.                                                               
  3. As a conduit user, I want a steer the provider declines to return to my  
  queue, so that my message is never silently dropped.                        
  4. As a conduit user, I want Stop to end the current run even when the      
  provider ignores the interrupt, so that Stop always means stop.             
  5. As a conduit user, I want a runner that will not release a stopped query 
  to be killed and respawned automatically, so that my next message starts    
  cleanly.                                                                    
  6. As a conduit user, I want "Run now" to stop the current run and start my 
  message immediately, so that urgent input bypasses the paused queue.        
  7. As a conduit user, I want ordinary Stop to pause my queued messages until
  I resume, so that Stop does not immediately start the next queued item.     
  8. As a conduit user, I want my answer to a permission request delivered    
  exactly once, even if the daemon restarts before it is delivered, so that   
  the agent receives my decision.                                             
  9. As a conduit user, I want my answer to a question delivered exactly once,
  even if the runner restarts, so that I never have to answer twice.          
  10. As a conduit user, I want a permission request that times out to be     
  delivered to the agent as a rejection even across a restart, so that the    
  agent does not wait forever.                                                
  11. As a conduit user, I want an answer whose delivery fails transiently to 
  be retried with backoff, so that a short outage does not lose my decision.  
  12. As a conduit user, I want a run to stay open while my answer is still   
  waiting to be delivered, so that the run does not end with my decision      
  undelivered.                                                                
  13. As a conduit user, I want a runner crash to end the affected run with a 
  clear "process lost" error, so that I know what happened and can send again.
  14. As a conduit user, I want my next message after a runner crash to start 
  a fresh runner automatically, so that recovery needs no manual step.        
  15. As a conduit user, I want a daemon restart to continue a run that       
  survived in its runner, so that long agent work is not thrown away.         
  16. As a conduit user, I want events produced while the daemon was down to  
  appear after it restarts, so that the transcript has no gaps.               
  17. As a conduit user, I want a message whose delivery was interrupted by a 
  crash never to be sent twice, so that the agent never repeats work.         
  18. As a conduit user, I want a run that ended to stay ended even if late   
  provider events arrive, so that a finished turn never reopens.              
  19. As a conduit user, I want every failed run to show a specific reason, so
  that I can tell a provider error from a lost process or a timeout.          
  20. As a conduit user, I want my queue to always drain once the active run  
  ends, so that queued messages never get stuck.                              
  21. As a conduit user, I want the same behaviour for Claude, Cursor and     
  OpenCode sessions, so that switching providers does not change how Stop,    
  steering or restarts work.                                                  
  22. As a conduit user, I want removing a project to cancel its pending      
  deliveries cleanly, so that other projects' work is not blocked.            
  23. As a conduit user, I want a project that comes back to reconcile its    
  OpenCode work from what OpenCode reports, so that no run stays pending      
  forever.                                                                    
  24. As a conduit user, I want a usage-limit failover or a vanished provider 
  session to end every open run on that session with its reason, so that the  
  session is usable again.                                                    
  25. As a conduit user, I want an old runner left over from before an upgrade
  to be refused new work and its turn ended cleanly, so that upgrades never   
  strand a session.                                                           
  26. As a conduit user upgrading conduit with work in flight, I want existing
  runs, receipts and outbox entries carried into the new model, so that the   
  upgrade does not lose or duplicate anything.                                
  27. As a conduit user, I want a failed upgrade of the store to stop startup 
  with a clear error, so that the daemon never runs on a half-converted store.
  28. As a conduit user, I want the processing timeout to fire exactly once   
  per run, so that long runs are bounded and not double-failed.               
  29. As a conduit user, I want a run whose runner is quarantined to stay     
  owned and answerable while the runner is alive, so that unrelated prompts   
  are not retired.                                                            
  30. As a conduit user, I want cost and token accounting attributed to the   
  right prompt even when results arrive late, so that usage numbers are       
  correct.                                                                    
  31. As a conduit maintainer, I want one module to own every write of run    
  state, so that a fix lands in one place and stays fixed.                    
  32. As a conduit maintainer, I want the run state to be a tagged union, so  
  that the compiler rejects combinations that mean nothing.                   
  33. As a conduit maintainer, I want the decider to be a pure function, so   
  that every transition is a table-driven test case.                          
  34. As a conduit maintainer, I want an illegal transition to be rejected and
  recorded as a diagnostic, so that it is visible without killing a healthy   
  run.                                                                        
  35. As a conduit maintainer, I want every unfinished run to have a deadline,
  so that "stuck busy" is impossible by construction.                         
  36. As a conduit maintainer, I want two concurrent writers to retry cleanly 
  on a version conflict, so that races are visible and never overwrite newer  
  state.                                                                      
  37. As a conduit maintainer, I want a typed conflict error after bounded    
  retries, so that a contended command fails visibly rather than being lost.  
  38. As a conduit maintainer, I want a single terminal classifier, so that a 
  new terminal kind is taught to one place.                                   
  39. As a conduit maintainer, I want the outbox to become the ledger's effect
  queue, so that delivery state cannot drift from run state.                  
  40. As a conduit maintainer, I want the effect interpreter to make no       
  decisions, so that all lifecycle logic lives in the decider.                
  41. As a conduit maintainer, I want runners to keep only an output buffer   
  and the highest attempt seen per run, so that the runner holds no copy of   
  run state.                                                                  
  42. As a conduit maintainer, I want the runner protocol to tag every message
  and event with run id and attempt, so that stale events are dropped by      
  construction.                                                               
  43. As a conduit maintainer, I want a guard test that fails on any write to 
  ledger-owned tables outside the ledger, so that the single-writer rule      
  cannot erode.                                                               
  44. As a conduit maintainer, I want generated interleavings of sends, steers,
  Stops, answers, timeouts, crashes and terminals checked against invariants, 
  so that the next race is found in seconds rather than in review.            
  45. As a conduit maintainer, I want those generated interleavings run       
  against the real ledger and SQLite too, so that persistence bugs are caught 
  as well as logic bugs.                                                      
  46. As a conduit maintainer, I want every past review finding from 27.2, 27.
  3, 10.4, 82tn.18 and 82tn.24 encoded as a named regression case, so that the
  redesign provably fixes the known class.                                    
  47. As a conduit maintainer, I want end-to-end crash-matrix tests through   
  the built daemon with recorded-trace fakes, so that the whole stack is      
  proven against real provider behaviour.                                     
  48. As a conduit maintainer, I want a two-build upgrade test, so that in-   
  flight work across the upgrade is proven safe.                              
  49. As a conduit maintainer, I want the fences, ownership sets, send journal,
  runner receipts and flag-bag context deleted, so that the code that produced
  the bug class is gone rather than layered over.                             
  50. As a conduit maintainer, I want Run, Run Input, Run Effect, Steer and   
  Tombstone defined in the domain glossary, so that future work uses one      
  vocabulary.                                                                 
                                                                              
  ## Implementation Decisions                                                 
                                                                              
  • **Run Ledger module.** One daemon-wide module with a four-verb interface: 
  admit (a new user input), observe (a provider event), control (interrupt,   
  Stop, End, Run now, or answer a permission or question), settle (process    
  lost, deadline passed, provider session ended). Each verb loads the         
  session's active run, calls the decider, and in one SQLite transaction      
  appends the resulting canonical run events (per ADR 0004), updates the      
  ledger's tables and derived views, and enqueues effects. It is the only     
  writer of run state.                                                        
  • **Decider.** Pure functions decide(state, input) returning events and     
  effects, and evolve(state, event) returning the next state. Run state is a  
  tagged union of Queued, Starting, Running, Interrupting, Settling and Ended 
  (with an outcome and a typed reason). Run Input state is Queued, Delivered, 
  Accepted or Declined. Pending interactions (permission requests and         
  questions) and their answers are part of run state. One terminal classifier 
  lives here and replaces both existing terminal classifiers.                 
  • **One active run per session.** Enforced by the decider and by a database 
  uniqueness constraint on active runs per session. A message sent during an  
  active run becomes a Run Input on that run with a steer effect. A declined  
  steer returns its input to the inbox. This removes run joining, steer-      
  declined reservations and Stop cohort snapshots.                            
  • **Tombstones.** Once a run is Ended, any later lifecycle event carrying   
  its run id is ignored by the decider. Accounting observations (usage, cost, 
  token totals) tagged with an ended run's id are still recorded against that 
  run's inputs; they never change run state.                                  
  • **Steers when a run ends early.** When Stop, Run now or a forced close    
  ends a run, a steer the provider already Accepted stays with the ended run. 
  A steer still Queued or Delivered but not Accepted returns to the front of  
  the inbox, marked as possibly seen; it is never re-sent automatically, and  
  with ordinary Stop it waits behind the pause.                               
  • **Native-session fence.** A successor run's start effect is held while any
  effect of the previous run on the same native session is still in flight    
  (for example an OpenCode prompt or a session-wide abort). It is released    
  when those effects resolve or a probe confirms the native session is idle.  
  The fence has its own deadline; if idle cannot be confirmed, the successor  
  fails with a typed reason rather than starting blindly. This sits on the    
  native session, not on the run, so Stop still ends the run on schedule.     
  • **Schema.** The provider runs table evolves into the runs table (run id,  
  session, attempt, state, owning process, deadline and deadline kind, outcome
  and reason, version). New Run Inputs table (one row per user message,       
  including the provider's native message id). The provider command outbox is 
  replaced by a Run Effects table written only by the ledger. Receipts, turns 
  and inbox busy are derived from ledger state in the same transaction. One   
  migration backfills from the existing outbox, receipts, turns and provider  
  runs; it is all-or-nothing and a failure stops startup with a typed error.  
  • **Concurrency.** A version column on the run row gives compare-and-set    
  writes. On conflict the ledger reloads and decides again, up to three times,
  then returns a typed LedgerConflict.                                        
  • **Deadlines as data.** Every non-ended run carries a deadline whose       
  meaning depends on state: give-up for Starting and Interrupting, a liveness 
  check for Running, a close-confirmation for Settling. One scheduler reads   
  the earliest deadline and calls settle. Retryable effect failures back off  
  through the same deadline. No in-memory retry or deadline fibers remain.    
  • **Stop that always stops.** Stop moves the run to Interrupting with a 30- 
  second deadline. A native interrupted result ends the run. If the deadline  
  passes, the run is ended as interrupted, tombstoned, and the runner is told 
  to close the native query; if it does not confirm before a second deadline, 
  the runner is killed and respawned. For OpenCode, which has no runner to    
  kill, the equivalent is cancelling the in-flight request, issuing the native
  abort, and holding the native-session fence until a probe confirms idle. A  
  kill that fails quarantines the runner without taking the project offline.  
  Ordinary Stop pauses the inbox; Run now bypasses the pause, as today.       
  • **Effect interpreter.** Replaces the decision-making half of the side-    
  effect reactor. It claims a Run Effect, calls the provider adapter, and     
  reports the outcome through observe. It contains no lifecycle decisions.    
  Effect outcomes are classified as retryable (backoff), permanent (typed     
  reason on the input or run) or delivery-unknown (never resent blindly; the  
  decider issues a probe).                                                    
  • **Runner protocol (next version).** Runners execute start, steer,         
  interrupt, close and end, each tagged with run id and attempt, and tag every
  event the same way. A runner keeps only its output buffer (unacknowledged   
  events, replayed after a daemon restart) and the highest attempt seen per   
  run, which makes a repeated start harmless. The runner send journal, runner 
  receipts and the run fields of the Claude session context are deleted.      
  Runners from older builds are refused new work and their turns are settled, 
  using the 82tn.31 compatibility pattern; the protocol version is bumped.    
  • **OpenCode adapter.** Maps prompt message ids onto Run Inputs and the     
  server's busy/idle status and message events onto observe. Project return   
  reconciles pending runs from provider truth.                                
  • **Process watcher.** Converts runner exit, quarantine and failed liveness 
  checks into settle(process lost). A quarantined but live runner keeps its   
  runs owned.                                                                 
  • **Illegal transitions.** In production an illegal transition rejects that 
  input, records a diagnostic event, and leaves the run unchanged; the        
  deadline still guarantees the run ends. Tests treat any illegal transition  
  on valid input as a failure.                                                
  • **Session-scoped provider failures** (usage-limit failover, vanished      
  native session) settle every open run on the session with its reason,       
  replacing the existing session-wide settlement path.                        
  • **Removed project.** Its pending effects are cancelled with a project-    
  inactive reason; active projects keep their ordering.                       
  • **Deleted outright:** reactor ownership sets, turn-session fences, the    
  runner send journal and receipts, run joining, Stop cohorts, and every run- 
  state write outside the ledger (prompt retirement, turn preparation,        
  projectors, import and migrations other than the backfill).                 
  • **Glossary.** Add Run, Run Input, Run Effect, Steer, Tombstone and Run    
  Ledger to the domain glossary.                                              
  • **Placement.** Built on the 82tn integration branch after the final 27.3, 
  10.3 and main merges, before 82tn.10.6 onward resumes.                      
                                                                              
  ## Testing Decisions                                                        
                                                                              
  • A good test exercises external behaviour through the module's interface:  
  the decider through decide/evolve, the ledger through its four verbs, the   
  system through the built daemon and browser protocol. No test reaches past  
  an interface into internal state.                                           
  • **Failure catalogue first.** Before ledger code is written, every finding 
  from the 27.2, 27.3, 10.4, 82tn.18 and 82tn.24 reviews is written down as a 
  named failing case (about fifty). They form the regression set the redesign 
  must pass.                                                                  
  • **Generated interleavings (property tests)** generate sequences of send,  
  steer, Stop, Run now, answer, permission timeout, daemon crash, runner crash,
  provider terminal and deadline inputs. They run against both the pure       
  decider and the real ledger on SQLite. Invariants: every run ends exactly   
  once; every unfinished run has a deadline; at most one active run per       
  session; no delivery-unknown input is delivered twice; no answer is lost;   
  the inbox always drains; tombstoned runs accept no events; no illegal       
  transitions on valid input; ledger tables and derived views always agree    
  after any rollback. Failing sequences shrink to minimal repros that become  
  fixed cases. Prior art: the existing fast-check property tests (about 25    
  files).                                                                     
  • **Ledger tests** through the four verbs against real SQLite cover compare-
  and-set conflicts, single-transaction atomicity and backfill from the old   
  schema.                                                                     
  • **End-to-end** through the existing process harness on the built dist,    
  with real daemon and runner processes and fakes that replay the recorded    
  Claude, Cursor and OpenCode traces already in the test fixtures (ADR 0002): 
  a crash matrix killing the daemon or the runner at each step of send, steer,
  Stop and answer, then asserting the outcome; and a two-build upgrade test   
  (old-build runner meeting the new daemon mid-turn). Each writes a JSON      
  artifact under test-results covering every matrix cell and invariant. Prior 
  art: the claude-process-runner lifecycle, runner upgrade and restart suites 
  and the 82tn.31 two-build test.                                             
  • **Guard test** fails on any write to ledger-owned tables outside the      
  ledger. Prior art: the daemon config read guard and the runtime-boundary    
  guard.                                                                      
  • **Existing integration suites** remain the safety net. Expectations change
  only where one-run-per-session deliberately changes behaviour (for example  
  run joining disappears), each with a written reason.                        
                                                                              
  ## Out of Scope                                                             
                                                                              
  • New user-facing features beyond the lifecycle guarantees above (no new UI 
  for runs, no new queue UI).                                                 
  • t3code-style automatic continuation after a runner really dies (tracked as
  its own bead).                                                              
  • Changing Claude settings layering, account scopes, or provider adapter    
  construction beyond what the runner protocol change needs.                  
  • Event-log compaction and retention (ADRs 0005 and 0013) beyond keeping run
  events compatible with them.                                                
  • Multi-machine deployment; only this machine runs conduit from main.       
                                                                              
  ## Further Notes                                                            
                                                                              
  • Rationale and the alternatives considered (flag-bag typing alone, compare-
  and-set writes alone, a per-session actor, crash-only recovery) are in the  
  architecture review produced during brainstorming. Typed state alone fixes  
  roughly a third of the observed bugs; the rest came from copies disagreeing,
  which only a single owner removes.                                          
  • The existing run-ownership plan's interleaving rules become decider cases 
  and property invariants; the prose document should be retired or reduced to 
  a pointer once the ledger lands.                                            
  • Lanes paused for this redesign: 82tn.10.6, 10.7, 10.9, 11, 12, 13, 14, 15 
  and 16. They build on the ledger.                                           
  • Compatibility for in-flight work across the protocol bump follows the     
  82tn.31 pattern (refuse new dispatch to old runners, settle their turns,    
  remove the compatibility path once every runner registration shows the new  
  build).                                                                     



NOTES

  2026-10-22 spec amended from the 32.1 failure catalogue gaps: (1) Tombstones
  cover lifecycle events only; late accounting is recorded against the ended  
  run without state change (RL-097/099/101/104). (2) Unaccepted steers return 
  to the inbox front when Stop/Run now/forced close ends a run, never auto-   
  resent (RL-041). (3) Native-session fence: successor start effect held until
  the prior run's in-flight effects resolve or a probe confirms idle;         
  OpenCode's Stop fallback is cancel request + native abort + fence (RL-      
  032/087).                                                                   



LABELS: project-model, ready-for-agent, run-ledger

PARENT
  ↑ ○ conduit-test-82tn: (EPIC) Retire per-project relays: one daemon orchestrator, sessions resolve their working directory P1

CHILDREN
  ↳ ○ conduit-test-82tn.32.11: Run Ledger: OpenCode on the ledger P1
  ↳ ○ conduit-test-82tn.32.7: Run Ledger: steering as a Run Input P1
  ↳ ○ conduit-test-82tn.32.13: Run Ledger: delete the old run-state copies P1
  ↳ ○ conduit-test-82tn.32.6: Run Ledger: Claude send and run end through the ledger P1
  ↳ ○ conduit-test-82tn.32.12: Run Ledger: session-wide failures and removed projects P1
  ↳ ○ conduit-test-82tn.32.14: Run Ledger: full crash matrix and two-build upgrade P1
  ↳ ○ conduit-test-82tn.32.5: Run Ledger: stateless runner protocol P1
  ↳ ✓ conduit-test-82tn.32.1: Run Ledger: failure catalogue + glossary P1
  ↳ ○ conduit-test-82tn.32.9: Run Ledger: answers through control(answer) P1
  ↳ ○ conduit-test-82tn.32.4: Run Ledger: deadlines as data and process watcher P1
  ↳ ○ conduit-test-82tn.32.10: Run Ledger: Cursor on the ledger P1
  ↳ ○ conduit-test-82tn.32.8: Run Ledger: Stop, interrupt and Run now P1
  ↳ ○ conduit-test-82tn.32.3: Run Ledger: ledger on SQLite with four verbs and backfill P1
  ↳ ◐ conduit-test-82tn.32.2: Run Ledger: pure decider and tagged-union run state P1
  ◐ 1/14 complete (7%)

BLOCKS
  ← ○ conduit-test-82tn.11: Approvals and questions across projects P2
  ← ○ conduit-test-82tn.10.9: Remove relay-built session owners; E2E proof P2
  ← ○ conduit-test-82tn.10.7: Daemon turn ownership P2
  ← ○ conduit-test-82tn.14: Removing a project tears down exactly its work P2
  ← ○ conduit-test-82tn.15: Running sessions resume after restart P2
  ← ○ conduit-test-82tn.12: Notifications and pollers keyed by demand P2
  ← ○ conduit-test-82tn.13: Browser audiences without attaching a project P2
  ← ○ conduit-test-82tn.16: Delete the per-project relay and close the epic P2
  ← ○ conduit-test-82tn.10.6: Daemon SessionManagerService P2

