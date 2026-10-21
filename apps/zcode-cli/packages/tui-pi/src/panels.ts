// Interactive panels rendered inline between transcript and composer:
// permission approvals, AskUserQuestion wizard, TuiSelection list, queued
// inputs. Key dispatch reuses the shared handlers via synthesized ParsedKey.

import type { Component, Focusable } from "@earendil-works/pi-tui";
import type {
  ApprovalPrompt,
  QueuedInput,
  SelectionState,
  SubmitValueOptions,
} from "@zcode/tui/internals";
import {
  approvalDecisionLabel,
  approvalPermissionScopes,
  approvalRequestDescription,
  decisionsForApproval,
  filterSelectionItems,
  handleApprovalKey,
  handleSelectionKey,
  previewPermissionInput,
  truncateDisplay,
} from "@zcode/tui/internals";
import { keyEventFromInput } from "./keys.js";
import type { AppStore } from "./store.js";
import type { PiTheme } from "./theme.js";

const PANEL_INDENT = "  ";
const CURSOR = "▌";
const MAX_SELECTION_VISIBLE = 10;
const MAX_PREVIEW_LINES = 6;

const truncate = (text: string, width: number): string =>
  truncateDisplay(text, Math.max(16, width - 8));

export class ApprovalPanel implements Component, Focusable {
  focused = false;

  constructor(
    private readonly approval: ApprovalPrompt,
    private readonly store: AppStore,
    private readonly theme: PiTheme,
  ) {}

  invalidate(): void {}

  handleInput(data: string): void {
    const key = keyEventFromInput(data);
    if (!key) return;
    handleApprovalKey(
      key,
      this.approval,
      this.store.setter("approvalQueue"),
      this.setStatus,
    );
  }

  private setStatus = (status: string): void => {
    this.store.set("status", status);
  };

  render(width: number): string[] {
    const approval = this.approval;
    const question = approval.questionState;
    if (question) return renderQuestionPanel(question, this.theme, width);

    const theme = this.theme;
    const request = approval.request;
    const lines = [
      `${theme.warning("●")} ${theme.text(`Approval required: ${request.toolName}`)}`,
    ];
    const description = approvalRequestDescription(request).trim();
    if (description && description !== request.toolName) {
      lines.push(`${PANEL_INDENT}${theme.muted(truncate(description, width))}`);
    }
    const preview = previewPermissionInput(request.input).trim();
    if (preview && preview !== description) {
      for (const line of preview.split("\n").slice(0, MAX_PREVIEW_LINES)) {
        lines.push(`${PANEL_INDENT}${theme.dim(truncate(line, width))}`);
      }
    }
    for (const scope of approvalPermissionScopes(request)) {
      const label = scope.kind === "prefix" ? `${scope.text}` : scope.text;
      lines.push(`${PANEL_INDENT}${theme.muted(`↳ ${truncate(label, width)}`)}`);
    }
    for (const decision of decisionsForApproval(request)) {
      const selected = approval.selectedDecision === decision;
      const radio = selected ? theme.accent("◉") : theme.muted("○");
      const label = approvalDecisionLabel(decision, request);
      lines.push(`${PANEL_INDENT}${radio} ${selected ? theme.text(label) : theme.muted(label)}`);
    }
    lines.push(theme.muted(`${PANEL_INDENT}↑↓ select · Enter confirm · Esc deny`));
    return lines;
  }
}

const renderQuestionPanel = (
  state: NonNullable<ApprovalPrompt["questionState"]>,
  theme: PiTheme,
  width: number,
): string[] => {
  const questions = state.input.questions;
  const lines: string[] = [];
  if (state.reviewing) {
    lines.push(`${theme.accent("●")} ${theme.text("Review your answers")}`);
    for (const question of questions) {
      const answer = state.answers[question.question];
      lines.push(`${PANEL_INDENT}${theme.muted(truncate(question.question, width))}`);
      lines.push(
        `${PANEL_INDENT}${PANEL_INDENT}${answer ? theme.text(truncate(answer, width)) : theme.dim("(skipped)")}`,
      );
    }
    lines.push(theme.muted(`${PANEL_INDENT}Enter submit · Tab edit · Esc cancel`));
    return lines;
  }

  const question = questions[state.currentQuestionIndex];
  if (!question) return lines;
  lines.push(
    `${theme.accent("●")} ${theme.text(truncate(question.question, width))} ${theme.muted(`(${state.currentQuestionIndex + 1}/${questions.length})`)}`,
  );
  if (question.header) lines.push(`${PANEL_INDENT}${theme.muted(question.header)}`);

  const multiSelections = new Set(state.multiSelections[question.question] ?? []);
  question.options.forEach((option, index) => {
    const selected = state.selectedOptionIndex === index;
    const radio = question.multiSelect
      ? multiSelections.has(option.label)
        ? theme.accent("◼")
        : theme.muted("□")
      : selected
        ? theme.accent("◉")
        : theme.muted("○");
    const label = selected ? theme.text(option.label) : theme.muted(option.label);
    lines.push(`${PANEL_INDENT}${radio} ${label}`);
    if (selected && option.description) {
      lines.push(`${PANEL_INDENT}${PANEL_INDENT}${theme.dim(truncate(option.description, width))}`);
    }
  });

  const otherSelected = state.selectedOptionIndex === question.options.length;
  const otherValue = state.otherText[question.question];
  const otherRadio = otherSelected ? theme.accent("◉") : theme.muted("○");
  lines.push(
    `${PANEL_INDENT}${otherRadio} ${otherSelected ? theme.text("Other") : theme.muted("Other")}${otherValue ? theme.muted(`: ${truncate(otherValue, width - 12)}`) : ""}`,
  );
  if (state.editingOther) {
    lines.push(`${PANEL_INDENT}${theme.text(`Other: ${state.otherBuffer}`)}${theme.accent(CURSOR)}`);
    lines.push(theme.muted(`${PANEL_INDENT}Enter accept · Esc cancel`));
  } else {
    lines.push(
      theme.muted(
        `${PANEL_INDENT}↑↓ select · ${question.multiSelect ? "Space toggle · " : ""}O other · S skip · Enter next · Esc cancel`,
      ),
    );
  }
  return lines;
};

export class SelectionPanel implements Component, Focusable {
  focused = false;

  constructor(
    private readonly selection: SelectionState,
    private readonly store: AppStore,
    private readonly theme: PiTheme,
    private readonly submitValue: (value: string, options?: SubmitValueOptions) => Promise<unknown>,
    private readonly cancelPendingSelection: () => void,
  ) {}

  invalidate(): void {}

  handleInput(data: string): void {
    const key = keyEventFromInput(data);
    if (!key) return;
    handleSelectionKey(
      key,
      this.selection,
      this.store.setter("selection"),
      this.setStatus,
      this.submitValue,
      this.cancelPendingSelection,
    );
  }

  private setStatus = (status: string): void => {
    this.store.set("status", status);
  };

  render(width: number): string[] {
    const theme = this.theme;
    const selection = this.selection;
    const lines = [
      `${theme.accent("●")} ${theme.text(truncate(selection.title || selection.prompt, width))}`,
    ];

    if (selection.pending) {
      const pending = selection.pending;
      lines.push(`${PANEL_INDENT}${theme.muted(truncate(pending.primary, width))}`);
      if (pending.secondary)
        lines.push(`${PANEL_INDENT}${theme.dim(truncate(pending.secondary, width))}`);
      if (pending.help) lines.push(`${PANEL_INDENT}${theme.muted(pending.help)}`);
      lines.push(theme.muted(`${PANEL_INDENT}Esc cancel`));
      return lines;
    }

    if (selection.input) {
      const input = selection.input;
      const display = input.mask
        ? "•".repeat(Math.min(input.value.length, 16)) + (input.value.length > 16 ? "…" : "")
        : input.value;
      lines.push(`${PANEL_INDENT}${theme.muted(truncate(input.primary, width))}`);
      if (input.secondary)
        lines.push(`${PANEL_INDENT}${theme.dim(truncate(input.secondary, width))}`);
      lines.push(
        `${PANEL_INDENT}${theme.text(`${input.placeholder && !display ? input.placeholder : display}`)}${theme.accent(CURSOR)}`,
      );
      if (input.help) lines.push(`${PANEL_INDENT}${theme.muted(input.help)}`);
      lines.push(theme.muted(`${PANEL_INDENT}Enter submit · Esc back`));
      return lines;
    }

    const visible = filterSelectionItems(selection);
    if (selection.filterable) {
      lines.push(
        `${PANEL_INDENT}${theme.text(`Filter: ${selection.filter}`)}${theme.accent(CURSOR)}`,
      );
    }
    if (visible.length === 0) {
      lines.push(`${PANEL_INDENT}${theme.muted(selection.emptyMessage)}`);
    }
    const start = Math.max(
      0,
      Math.min(
        selection.selectedIndex - MAX_SELECTION_VISIBLE + 1,
        visible.length - MAX_SELECTION_VISIBLE,
      ),
    );
    const windowItems = visible.slice(start, start + MAX_SELECTION_VISIBLE);
    windowItems.forEach((item, index) => {
      const absolute = start + index;
      const selected = absolute === selection.selectedIndex;
      const marker = selected ? theme.accent("▸") : " ";
      const primary = item.disabledReason
        ? theme.dim(truncate(item.primary, width - 24))
        : selected
          ? theme.text(truncate(item.primary, width - 24))
          : theme.muted(truncate(item.primary, width - 24));
      lines.push(`${PANEL_INDENT}${marker} ${primary}`);
      const secondary = item.secondary ?? item.disabledReason ?? item.meta;
      if (secondary && selected) {
        lines.push(`${PANEL_INDENT}  ${theme.dim(truncate(secondary, width - 6))}`);
      }
    });
    if (visible.length > MAX_SELECTION_VISIBLE) {
      lines.push(
        theme.muted(
          `${PANEL_INDENT}… ${start + 1}-${start + windowItems.length} of ${visible.length}`,
        ),
      );
    }
    if (selection.help) lines.push(`${PANEL_INDENT}${theme.muted(selection.help)}`);
    lines.push(theme.muted(`${PANEL_INDENT}↑↓ select · Enter confirm · Esc dismiss`));
    return lines;
  }
}

export class QueuedInputsRow implements Component {
  constructor(
    private readonly inputs: readonly QueuedInput[],
    private readonly theme: PiTheme,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const visible = this.inputs.slice(0, 3);
    const hidden = this.inputs.length - visible.length;
    const lines = visible.map(
      (input) => `  ${this.theme.muted("⧉")} ${this.theme.dim(truncate(input.text, width - 6))}`,
    );
    if (hidden > 0) lines.push(`  ${this.theme.muted(`… ${hidden} more queued`)}`);
    return lines;
  }
}

export const keyEventForTest = keyEventFromInput;
