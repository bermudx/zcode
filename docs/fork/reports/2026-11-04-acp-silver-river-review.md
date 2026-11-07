# ACP silver-river candidate review

Reviewed the uncommitted ACP implementation in
`/home/daniel/.herdr/worktrees/piz/worktree-silver-river-2147`, based on
`c2d393f7`, on 2026-11-04.

**Historical review, not the current merge recommendation.** After the operator
reported the merge, local history confirmed the ACP frontend and subsequent
review fixes are in `main`, including merge `0c54f6a8`. Source inspection
confirmed `createLane()` now awaits `runtime.connect()`, uses a fresh-client
connector, and session operations use `runtime.currentClient()`. Question
forms now validate with `AskUserQuestionInputSchema` and use option labels.
The three code findings below describe the earlier candidate, not those
current implementations. Tests and end-to-end acceptance were not rerun for
this follow-up; it does not establish the status of the remaining acceptance
items.

**Recommendation: retain and fix; do not merge as-is.** This is a different
implementation from the previously reviewed `origin/arena/26022f30-piz`
candidate. Reusing `AttachRuntime` and `AttachSessionHandle` is preferable to
duplicating their session routing and command/turn correlation. This review
did not modify, commit, merge, or discard the candidate's dirty work.

## Blocking findings

### P0 — No runtime connection is installed

`apps/zcode-cli/packages/cli/src/acp/acp-sessions.ts:173–184` obtains a client
and constructs an `AttachRuntime` but never calls `runtime.connect()`.
Constructing the runtime does not install that client. `bindSession`, at
lines 133–138, immediately subscribes through `runtime.currentClient()`,
which throws `attach client is not connected`.

Reproduced with the actual `AcpCoreSessions` and `AttachRuntime`, injected
connection dependencies, and the existing schema-valid attach test snapshot.
`open()` made only `session/create` before throwing. Neither notification
routing nor the reverse-request handler was installed. `closeAll()` did not
close the injected client either, because the runtime never owned it.
Resume uses the same failing bind path.

This reproduction used an in-memory client, not a real core/socket; it
establishes the local initialization failure, not end-to-end behavior.

### P1 — AskUserQuestion assumes nonexistent option values

`acp-project.ts:56–60` invents a required `value` property for question
options; lines 225–243 use it for descriptions and string enums.
The authoritative `AskUserQuestionOptionSchema` in
`apps/zcode-cli/packages/contracts/src/tools/ask-user-question.ts` is strict
and defines `label`, `description`, and optional `preview`, not `value`.
`userInputParamsToBrokerRequest` preserves the original input.

Reproduced by parsing a two-option question through
`AskUserQuestionInputSchema` and passing the result to `buildQuestionForm`.
The generated enum contains two `undefined` values, serialized as
`[null,null]`, instead of string choices. Multi-select descriptions also
lose the option names. Both new test files use invented `value` properties,
so the passing fixtures miss the real contract.

### P1 — Reconnect factory returns the original socket client

`acp-sessions.ts:174–177` captures one client and supplies
`connect: async () => client` to `AttachRuntime`. Even after fixing the
initial missing `runtime.connect()`, the runtime's reconnect path will
receive the same disconnected client rather than opening a new socket.
Session create/resume also use `lane.client` directly instead of the
runtime's current client.

This finding is from source inspection, not a disconnect/reconnect
experiment. The fix needs a replacement-client regression, not just
initial-connection coverage.

## Checks actually run

In the candidate worktree, with pinned Node 24.14.0 via mise:

- Both new ACP test files: **16 passed, 0 failed**.
- `pnpm architecture:check --changed`: **failed**, five new
  `unmanaged-new-file` violations, one for each source file under `src/acp/`.
- The two focused in-memory reproductions described above.

No builds, real-core requests, credential reads, live-core restarts, wrapper
changes, installations, pushes, or T3 interactions were performed.
The author's reported typecheck, lint, bundle size, handshake and broader
test results were not rerun here.

## Acceptance still required

The candidate document explicitly leaves real T3 interaction rendering,
cancel/rollback ordering, resume during a live turn, a full GLM turn,
incremental resource cost, no-plugin startup observation and signing
through attach unverified. A handshake without a session does not exercise
the failing initialization path. Fix the findings, add coverage using the
real session layer and authoritative question schema, register the new
source directory with architecture governance, then perform the outstanding
acceptance checks before calling the plan complete.
