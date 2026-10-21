/**
 * app-server-attach 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const appServerAttachModule = {
  id: "app-server-attach",
  requires: ["shared", "zcode-cli"],
  provides: ["app-server-attach"],
  publicEntrypoints: [
    "packages/shared/src/app-server-attach/contract.ts",
    "packages/shared/src/app-server-attach/index.ts",
    "apps/zcode-cli/packages/bootstrap/src/zcode-protocol/socket-listener.ts",
    "apps/zcode-cli/packages/cli/src/app-server-spawn.ts",
    "apps/zcode-cli/packages/cli/src/protocol-lifecycle.ts",
  ],
} as const;
