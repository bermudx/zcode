# Question panel overlap: screenshot diagnosis

## Request and scope

Explain the operator's screenshot of `/workflow` followed by an overlapping
AskUserQuestion panel. Investigation only; no implementation or runtime changes.

## Evidence

- The screenshot shows `/workflow` without inline arguments. The assistant says
  its task slot is blank and asks the operator to choose a task. The complete
  model input was not inspected, so loss of earlier context is not established.
- The question text and the first choice occupy overlapping screen cells.
  Later choices are more readable. The sidebar reports zero subagents.
- `apps/zcode-cli/packages/tui/src/app-question-panel.tsx` fixes every question
  panel at `height: 10`, with a border and padding. Question and option text
  have no explicit row heights or width-aware height calculation.
- `apps/zcode-cli/packages/tui/src/app-approval-panel.tsx` accepts `contentWidth`
  and sizes ordinary approval rows from it, but its question branch passes only
  `state` to `QuestionPanel`. Question layout therefore bypasses that sizing.
- Existing comments in `app-components.tsx` and `app-sidebar.tsx` describe
  related rendering failures: wrapped text drawing over later rows and
  compressed text rows still drawing glyphs.

## Assessment

The fixed-height, unmeasured question layout is the likely cause of the visible
overlap. Long question/option text needs more rows than the panel reserves.
This is a source-based diagnosis, not a live reproduction or a verified fix.
The screenshot does not establish whether the installed binary matches HEAD.

The clarification itself is separate from the display failure. The visible
assistant response reports a missing task. The screenshot shows it waiting for
an answer, not running a multi-agent workflow.

## Verification and next step

Read the screenshot, question renderer, approval dispatch, and related layout
comments. No tests, builds, model calls, network requests, session inspection,
or terminal input were run.

A fix should pass available width into question layout and reserve the actual
wrapped height of each row. It needs an isolated rendering check with long
question text and descriptions, including narrow terminal widths.
