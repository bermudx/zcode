// piz 默认的 auto-compact 窗口上限策略：常量与 GLM 谓词的唯一来源在
// `@zcode/shared`（compact-context-window.ts）——attach 下发与 tui-pi 页脚
// 分母收紧必须同源。协议与 core 语义见 docs/design/v2/compact/plan.md M2.1。
export {
  GLM_COMPACT_CONTEXT_WINDOW,
  isGlmModelId,
  resolveCompactContextWindowForModel,
} from "@zcode/shared";
