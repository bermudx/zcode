import { decodePasteBytes, stripAnsiSequences, type PasteEvent } from "@mbears/opentui-core";
import { usePaste } from "@mbears/opentui-react";
import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { ApprovalPrompt, SelectionState } from "./app-model.js";

// 终端 bracketed paste 走独立的 paste 事件通道，不经过 useKeyboard。
// 选择面板打开时 composer（含 textarea，自带 handlePaste）已被 SelectionPanel
// 替换，没有订阅者时粘贴内容被静默丢弃——表现为“在登录面板的 API key 输入行
// 粘贴无反应”，长文本无法录入。这里按逐字录入相同的清洗与路由规则补订阅。
export function pastedInputText(bytes: Uint8Array): string | undefined {
  const printable = [...stripAnsiSequences(decodePasteBytes(bytes))].filter(
    (char) => char >= " " && char !== "\x7f",
  );
  return printable.length > 0 ? printable.join("") : undefined;
}

// 文本去向与 handleSelectionKey 保持一致：pending 无输入框；input 追加到
// value；其余可过滤选择追加到 filter。返回是否消费本次粘贴内容。
export function applySelectionPaste(
  selection: SelectionState,
  text: string,
  setSelection: Dispatch<SetStateAction<SelectionState | undefined>>,
): boolean {
  if (selection.pending) return false;
  if (selection.input) {
    setSelection((current) =>
      current?.input
        ? { ...current, input: { ...current.input, value: `${current.input.value}${text}` } }
        : current,
    );
    return true;
  }
  if (selection.filterable !== false) {
    setSelection((current) =>
      current ? { ...current, filter: `${current.filter}${text}`, selectedIndex: 0 } : current,
    );
    return true;
  }
  return false;
}

export function useSelectionPaste(options: {
  approvalQueue: readonly ApprovalPrompt[];
  readOnlyView?: { back(): void };
  selection: SelectionState | undefined;
  setSelection: Dispatch<SetStateAction<SelectionState | undefined>>;
}): void {
  const { approvalQueue, readOnlyView, selection, setSelection } = options;

  usePaste(
    useCallback(
      (event: PasteEvent) => {
        // 门禁顺序与 useKeyboard 一致：只读视图与审批弹窗优先。
        if (readOnlyView || approvalQueue[0] || !selection) return;
        // 选择面板接管输入时消费粘贴：键盘输入被逐键消费（consumeKey），粘贴
        // 也必须在全局层 preventDefault，避免聚焦 renderable（composer 建议
        // 模式下 textarea 仍在）收到同一份文本造成重复插入。
        event.preventDefault();
        const text = pastedInputText(event.bytes);
        if (!text) return;
        applySelectionPaste(selection, text, setSelection);
      },
      [approvalQueue, readOnlyView, selection, setSelection],
    ),
  );
}
