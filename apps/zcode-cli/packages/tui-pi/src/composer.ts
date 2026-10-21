// Composer: pi-tui Editor + autocomplete for slash commands, /model /effort
// /mode argument completion, and @-mention file paths.

import {
  CombinedAutocompleteProvider,
  Editor,
  type AutocompleteItem,
  type AutocompleteProvider,
  type SlashCommand,
  type TUI,
} from "@earendil-works/pi-tui";
import type {
  TuiEffortOption,
  TuiModelOption,
  TuiOptions,
  TuiSlashCommandSuggestion,
} from "@zcode/tui/internals";
import { TUI_SWITCHABLE_MODES, modelOptionValue } from "@zcode/tui/internals";
import type { PiTheme } from "./theme.js";

type SlashCommandSource = readonly TuiSlashCommandSuggestion[] | undefined;

const toPiSlashCommands = (
  commands: SlashCommandSource,
  models: () => readonly TuiModelOption[],
  efforts: () => readonly TuiEffortOption[],
): SlashCommand[] | undefined => {
  if (!commands || commands.length === 0) return undefined;
  return commands.map((command) => ({
    argumentHint: command.usage.replace(/^\/\S+\s*/, "").trim() || undefined,
    description: command.summary,
    name: command.name,
    getArgumentCompletions: argumentCompletions(command.name, models, efforts),
  }));
};

const argumentCompletions = (
  name: string,
  models: () => readonly TuiModelOption[],
  efforts: () => readonly TuiEffortOption[],
): SlashCommand["getArgumentCompletions"] => {
  if (name === "model") {
    return (prefix: string): AutocompleteItem[] =>
      models()
        .filter((model) =>
          modelOptionValue(model).toLowerCase().includes(prefix.toLowerCase()),
        )
        .map((model) => ({
          description: model.label,
          label: model.label,
          value: modelOptionValue(model),
        }));
  }
  if (name === "effort") {
    return (prefix: string): AutocompleteItem[] =>
      efforts()
        .filter((effort) => effort.id.toLowerCase().includes(prefix.toLowerCase()))
        .map((effort) => ({
          description: effort.label ?? effort.id,
          label: effort.id,
          value: effort.id,
        }));
  }
  if (name === "mode") {
    return (prefix: string): AutocompleteItem[] =>
      TUI_SWITCHABLE_MODES.filter((mode) => mode.startsWith(prefix.toLowerCase())).map(
        (mode) => ({ label: mode, value: mode }),
      );
  }
  return undefined;
};

export class Composer extends Editor {
  constructor(
    tui: TUI,
    theme: PiTheme,
    private readonly deps: {
      options: TuiOptions;
      models: () => readonly TuiModelOption[];
      efforts: () => readonly TuiEffortOption[];
    },
  ) {
    super(tui, { borderColor: theme.border, selectList: theme.selectList }, { paddingX: 1 });
    this.borderColor = theme.border;
  }

  refreshAutocomplete(): void {
    const provider = this.buildAutocompleteProvider();
    if (provider) this.setAutocompleteProvider(provider);
  }

  private buildAutocompleteProvider(): AutocompleteProvider | undefined {
    const commands = toPiSlashCommands(
      this.deps.options.slashCommands,
      this.deps.models,
      this.deps.efforts,
    );
    const basePath = this.deps.options.workspaceDirectory ?? process.cwd();
    return new CombinedAutocompleteProvider(commands ?? [], basePath);
  }
}
