// 模型单价表（USD / 1M tokens）。契约无成本字段（core step-finish 落
// `cost: 0` 占位），footer `$` 段在客户端按 pi `calculateCost` 同公式计算：
// `(input·r_in + output·r_out + cacheRead·r_read + cacheWrite·r_write)/1e6`。
// 单价取 pi models-store 公开目录（models.dev 快照，2026-10）的 zai GLM 族；
// 目录价与实付账单可能漂移，读数仅作状态展示，不作计费依据。未知模型不
// 出段（见 status-line.formatCostSegment 的门）。

export interface ModelCostRates {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

const GLM_RATES: Readonly<Record<string, ModelCostRates>> = {
  "glm-4.7": { cacheRead: 0.11, cacheWrite: 0, input: 0.6, output: 2.2 },
  "glm-5-turbo": { cacheRead: 0.24, cacheWrite: 0, input: 1.2, output: 4 },
  "glm-5.2": { cacheRead: 0.26, cacheWrite: 0, input: 1.4, output: 4.4 },
  "glm-5.2-highspeed": { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
  "glm-5.3": { cacheRead: 0.26, cacheWrite: 0, input: 1.4, output: 4.4 },
  "glm-5.3-flash": { cacheRead: 0.03, cacheWrite: 0, input: 0.15, output: 0.5 },
  "glm-5.3-highspeed": { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
};

/** `provider/model` → 裸 model id（裸 id 原样），大小写不敏感查表。 */
export function bareModelId(model: string): string {
  const slash = model.lastIndexOf("/");
  const bare = slash > 0 && slash < model.length - 1 ? model.slice(slash + 1) : model;
  return bare.toLowerCase();
}

/** 目录价查表；未知模型返回 undefined（调用方不显示 `$` 段）。 */
export function lookupModelRates(model: string | undefined): ModelCostRates | undefined {
  if (!model) return undefined;
  return GLM_RATES[bareModelId(model)];
}

/**
 * 单请求成本（USD）。入参为 `ModelUsage` 折叠口径；input 基座取「非 cache
 * 输入」——AI SDK v6 路径的 inputTokens 已含 cache read/write（contracts
 * `getModelUsageInputWindowTokens` 注释），直接乘 input 价会重复计费，故先
 * 减去 cache 两项（下限 0）。无 1h cache write 分档（GLM 目录无此价）。
 */
export function cacheExclusiveInputTokens(input: {
  inputWindowTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}): number {
  return Math.max(0, input.inputWindowTokens - input.cacheReadTokens - input.cacheWriteTokens);
}

export function requestCostUsd(rates: ModelCostRates, usage: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}): number {
  return (
    (rates.input * usage.inputTokens +
      rates.output * usage.outputTokens +
      rates.cacheRead * usage.cacheReadTokens +
      rates.cacheWrite * usage.cacheWriteTokens) /
    1e6
  );
}
