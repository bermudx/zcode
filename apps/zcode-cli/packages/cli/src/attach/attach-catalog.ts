// 模型/思考档目录的只增不减合并。
//
// `session/subscribe` 的快照、mutation 回包（setModel 等）与 state.updated patch
// 里的 `available` 都是 `modelAvailability:"current"` 过滤后的投影（只剩当前项），
// 不是 provider catalog 事实。整包覆盖会把可选模型缩成 1 项——`/new` 之后
// Ctrl+P 先报 "Model is not available"（失败回包再把 1 项列表写进 TUI store），
// 随后报 "Only one model available"，就是这条路径（2026-10-22 piz 实测）。

/** 目录合并的稳定 key：协议形状是 {ref:{providerId,modelId}}（label 会随 provider
 *  文案变化，不能作身份）；顺带兼容旧回包里的扁平 {providerId,modelId} 形状。 */
export const modelOptionKey = (option: {
  id?: string;
  modelId?: string;
  providerId?: string;
  ref?: { modelId?: string; providerId?: string };
}): string => {
  if (option.ref) return `${option.ref.providerId ?? ""}/${option.ref.modelId ?? ""}`;
  const flat = `${option.providerId ?? ""}/${option.modelId ?? ""}`;
  return option.id ?? flat;
};

export const thoughtLevelKey = (option: { value?: string }): string => option.value ?? "";

/**
 * 已知项保留（顺序不变）、元数据用新投影刷新、真正的新项追加。
 * 新投影里缺失的项不会因此被删——catalog 缩水的权威来源是下次会话创建。
 */
export const mergeCatalog = <T>(
  previous: readonly T[] | undefined,
  incoming: readonly T[] | undefined,
  keyOf: (option: T) => string,
): T[] => {
  const previousList = previous ?? [];
  const incomingList = incoming ?? [];
  if (previousList.length === 0) return [...incomingList];
  if (incomingList.length === 0) return [...previousList];
  const incomingByKey = new Map(incomingList.map((option) => [keyOf(option), option]));
  const merged = previousList.map((option) => incomingByKey.get(keyOf(option)) ?? option);
  const known = new Set(merged.map(keyOf));
  for (const option of incomingList) {
    const key = keyOf(option);
    if (known.has(key)) continue;
    known.add(key);
    merged.push(option);
  }
  return merged;
};
