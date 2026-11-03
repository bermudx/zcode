import { resolve } from "node:path";
import { createConfig } from "@zcode/adapters/config";
import { createNodeCustomCommandAdapter } from "@zcode/adapters/commands";
import type {
  CustomCommandContent,
  CustomCommandDiagnostic,
  CustomCommandLoadOutcome,
  Logger,
} from "@zcode/contracts";
import { resolveZCodePlugins } from "./plugins.js";
import { collectDisabledPaths } from "./skill-command-overrides.js";
import { NO_PLUGINS_CONFIG_OVERRIDES } from "./app/app-config-options.js";

export interface ListZCodeCustomCommandsOptions {
  /** 受信入口策略，不能从客户端 runtimeConfig 读取。 */
  noPlugins?: boolean;
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  logger?: Logger;
  projectConfigPath?: string;
  skipUserConfig?: boolean;
  userConfigPath?: string;
  workingDirectory?: string;
  additionalDirectories?: readonly string[];
}

export interface InspectZCodeCustomCommandOptions extends ListZCodeCustomCommandsOptions {
  name: string;
}

export interface ZCodeCustomCommandInspection {
  command: CustomCommandContent;
  diagnostics: CustomCommandDiagnostic[];
}

export async function listZCodeCustomCommands(
  options: ListZCodeCustomCommandsOptions = {},
): Promise<CustomCommandLoadOutcome> {
  const discovery = createCustomCommandDiscovery(options);
  return await discovery.adapter.discoverCommands({
    workingDirectory: discovery.workingDirectory,
  });
}

export async function inspectZCodeCustomCommand(
  options: InspectZCodeCustomCommandOptions,
): Promise<ZCodeCustomCommandInspection> {
  const discovery = createCustomCommandDiscovery(options);
  const workingDirectory = discovery.workingDirectory;
  const adapter = discovery.adapter;
  const outcome = await adapter.discoverCommands({ workingDirectory });
  const normalizedName = normalizeCommandName(options.name);
  if (!outcome.commands.some((command) => command.name === normalizedName)) {
    throw new Error(`Custom command not found: ${options.name}`);
  }

  return {
    command: await adapter.loadCommand({
      name: normalizedName,
      workingDirectory,
    }),
    diagnostics: outcome.diagnostics,
  };
}

export async function loadZCodeCustomCommand(
  options: InspectZCodeCustomCommandOptions,
): Promise<CustomCommandContent> {
  const discovery = createCustomCommandDiscovery(options);
  return await discovery.adapter.loadCommand({
    name: normalizeCommandName(options.name),
    workingDirectory: discovery.workingDirectory,
  });
}

function createCustomCommandDiscovery(options: ListZCodeCustomCommandsOptions) {
  const workingDirectory = resolve(options.workingDirectory ?? process.cwd());
  const configResult = createConfig({
    ...(options.noPlugins === true ? { cliOverrides: NO_PLUGINS_CONFIG_OVERRIDES } : {}),
    env: options.env,
    projectConfigPath: options.projectConfigPath,
    workingDirectory,
    skipUserConfig: options.skipUserConfig,
    userConfigPath: options.userConfigPath,
  });
  // 关闭时不要进入插件解析：空目录之前的 bundled seed/hash 也属于被禁止的 IO。
  const pluginOutcome = configResult.config.plugins.enabled
    ? resolveZCodePlugins({
        configResult,
        env: options.env,
        logger: options.logger,
        projectConfigPath: options.projectConfigPath,
        skipUserConfig: options.skipUserConfig,
        userConfigPath: options.userConfigPath,
        workingDirectory,
      })
    : undefined;
  return {
    adapter: createNodeCustomCommandAdapter({
      extraResolvedRoots: pluginOutcome?.commandRoots,
      disabledPaths: collectDisabledPaths(configResult.config.commandOverrides),
      homeDirectory: options.homeDirectory,
      additionalDirectories: options.additionalDirectories,
    }),
    workingDirectory,
  };
}

function normalizeCommandName(name: string): string {
  return name.trim().replace(/^\/+/, "").toLowerCase();
}
