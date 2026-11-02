// piz 默认的 auto-compact 窗口上限策略（常量与 GLM 谓词的唯一来源）。
// 协议与 core 语义见 docs/design/v2/compact/plan.md M2.1。

/** 与 Devin SWE-2 sidekick 同一上限：GLM-5.3 系列上报 1M 窗口，但更精简的上下文效果更好。 */
export const GLM_COMPACT_CONTEXT_WINDOW = 262_000;

/** GLM 家族（`GLM-5.3`、`GLM-5.3-Flash`、内置小写 `glm-5.3`），大小写不敏感。 */
export function isGlmModelId(modelId: string | undefined): boolean {
  return modelId !== undefined && /^glm-/i.test(modelId);
}

/** 当前模型应使用的上限；非 GLM 不设（undefined）。 */
export function resolveCompactContextWindowForModel(
  modelId: string | undefined,
): number | undefined {
  return isGlmModelId(modelId) ? GLM_COMPACT_CONTEXT_WINDOW : undefined;
}
