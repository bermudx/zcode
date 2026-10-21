import type { ConfigResult } from "@zcode/adapters/config";
import { detectLocale, resolveLocale } from "@zcode/i18n";
import type { RuntimeConfigPatch, SupportedLocale, UiLocale } from "@zcode/contracts";
import type { ZCodeAppOptions } from "./types.js";

export function isMessageEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.ZCODE_MESSAGE_ENABLED === "1" || env.ZCODE_MESSAGE_ENABLED === "true";
}

/**
 * `--no-plugins`（attach 共享 core）的固定 config 覆盖：插件发现与 MCP 功能位一起关。
 * plugins.enabled=false 让 NodePluginAdapter 返回空 outcome（无 plugin MCP、无内置
 * node_repl/browser-use 宿主）；features.mcp=false 关掉连接池、遥测 tracker 与 broker。
 */
export const NO_PLUGINS_CONFIG_OVERRIDES: RuntimeConfigPatch = {
  features: { mcp: false },
  plugins: { enabled: false },
};

export function createConfigCliOverrides(options: ZCodeAppOptions): RuntimeConfigPatch | undefined {
  const overrides: RuntimeConfigPatch = {};
  const permission: NonNullable<RuntimeConfigPatch["permission"]> = {};

  if (options.runtimeConfig?.mode) {
    permission.mode = options.runtimeConfig.mode;
  }
  if (options.runtimeConfig?.toolAllowlist) {
    permission.allowedTools = [...options.runtimeConfig.toolAllowlist];
  }
  if (options.runtimeConfig?.toolDisallowlist) {
    // headless CLI 的 denylist 同时投影到 permission config，让执行期权限
    // 路径与 provider-visible 工具面共享同一份禁用清单。
    permission.disallowedTools = [...options.runtimeConfig.toolDisallowlist];
  }
  if (Object.keys(permission).length > 0) {
    overrides.permission = permission;
  }
  if (options.uiLocale) {
    overrides.ui = {
      locale: options.uiLocale,
    };
  }
  if (options.noPlugins === true) {
    overrides.features = { ...overrides.features, ...NO_PLUGINS_CONFIG_OVERRIDES.features };
    overrides.plugins = { ...overrides.plugins, ...NO_PLUGINS_CONFIG_OVERRIDES.plugins };
  }

  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

export function resolveEffectiveConfigResult(
  configResult: ConfigResult,
  options: ZCodeAppOptions,
): ConfigResult {
  const requestedLocale = configResult.config.ui.locale;
  const effectiveLocale = resolveEffectiveLocale(requestedLocale, options);

  if (effectiveLocale === requestedLocale) {
    return configResult;
  }

  return {
    ...configResult,
    config: {
      ...configResult.config,
      ui: {
        ...configResult.config.ui,
        locale: effectiveLocale,
      },
    },
  };
}

export function resolveEffectiveLocale(
  requestedLocale: UiLocale,
  options: ZCodeAppOptions,
): SupportedLocale {
  const detectedLocale = requestedLocale === "auto" ? detectAppLocale(options) : undefined;
  return resolveLocale(requestedLocale, detectedLocale);
}

function detectAppLocale(options: ZCodeAppOptions): SupportedLocale | undefined {
  if (options.uiDetectedLocale !== undefined) {
    return detectLocale({
      intlLocale: options.uiDetectedLocale,
    });
  }

  return detectLocale({
    env: options.env ?? process.env,
    intlLocale: resolveIntlLocale(),
  });
}

function resolveIntlLocale(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return undefined;
  }
}
