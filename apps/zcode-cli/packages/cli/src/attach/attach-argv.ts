// `zcode attach` 是 `zcode tui --tui-frontend=pi --shared-core` 的别名。
// 不改用 `--attach` 布尔位：它已占用（多值 string，prompt 文件附件），
// yargs strict 下裸 --attach 会被当缺失值报错，故 attach 走 argv 重写。
const ATTACH_COMMAND = "attach";
const TUI_FRONTEND_PI_ARGS = ["tui", "--tui-frontend", "pi", "--shared-core"] as const;

export const SHARED_CORE_FLAG = "shared-core";

/**
 * argv（不含 node/script）重写：`attach` 作为首个位置参数时整体替换为 pi-tui
 * shared-core 模式，其后的 flag 原样透传。其他任何形态不动。
 */
export function rewriteAttachArgv(argv: readonly string[]): string[] {
  if (argv[0] !== ATTACH_COMMAND) return [...argv];
  return [...TUI_FRONTEND_PI_ARGS, ...argv.slice(1)];
}
