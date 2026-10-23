import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyBashSourceScript,
  applyBashSourceScripts,
  applyBashSourcesToExecutionRequest,
  materializeBashInternalSourceScript,
} from "../src/exec/bash-startup-script.js";

const TEST_ZSH_PATH = ["/usr/bin/zsh", "/bin/zsh", "/usr/local/bin/zsh", "/opt/homebrew/bin/zsh"].find(
  (path) => existsSync(path),
);
const TEST_BASH_PATH = ["/usr/bin/bash", "/bin/bash", "/usr/local/bin/bash"].find((path) =>
  existsSync(path),
);

describe("bash source script materializer", () => {
  it("writes a hash-scoped script and sources it before the command", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "zcode-bash-startup-"));
    try {
      const materialized = materializeBashInternalSourceScript(
        {
          id: "session/with spaces:bash-startup",
          content: "zcode_startup_marker() { echo startup-ok; }\n",
        },
        {
          rootDir,
          sessionId: "session/with spaces",
          shellDialect: "posix",
        },
      );

      expect(materialized).toBeDefined();
      expect(materialized?.path).toContain("session-with-spaces");
      expect(readFileSync(materialized!.path, "utf8")).toBe(
        "zcode_startup_marker() { echo startup-ok; }\n",
      );
      expect(statSync(materialized!.path).isFile()).toBe(true);

      const command = applyBashSourceScript("zcode_startup_marker", materialized!);
      expect(command).toBe(`. '${materialized!.path}'\neval 'zcode_startup_marker'`);
    } finally {
      rmSync(rootDir, { force: true, recursive: true });
    }
  });

  it("skips CMD and legacy shell dialects", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "zcode-bash-startup-"));
    try {
      for (const shellDialect of ["cmd", "legacy-shell"] as const) {
        expect(
          materializeBashInternalSourceScript(
            {
              id: "startup",
              content: "echo no\n",
            },
            {
              rootDir,
              sessionId: "session",
              shellDialect,
            },
          ),
        ).toBeUndefined();
      }
    } finally {
      rmSync(rootDir, { force: true, recursive: true });
    }
  });

  it("converts materialized Windows paths for Git Bash source commands", () => {
    const materialized = {
      path: "C:\\Users\\me\\AppData\\Local\\ZCode\\startup.sh",
      shellPath: "/c/Users/me/AppData/Local/ZCode/startup.sh",
    };

    expect(applyBashSourceScript("echo ok", materialized)).toBe(
      ". /c/Users/me/AppData/Local/ZCode/startup.sh\neval 'echo ok'",
    );
  });

  it("sources shell init snapshots before embedded search prelude scripts", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "zcode-bash-startup-"));
    try {
      const request = {
        command: {
          mode: "shell" as const,
          command: "find . -name '*.ts'",
          shellProfile: "posix-bash" as const,
        },
        bashPrelude: {
          kind: "embedded-search" as const,
          backend: {
            kind: "internal-cli" as const,
            command: "zcode",
            args: ["__internal-search"],
          },
        },
      };

      const rewritten = applyBashSourcesToExecutionRequest(request, {
        leadingSources: [
          {
            path: "/tmp/init snapshot.sh",
            shellPath: "/tmp/init snapshot.sh",
            optional: true,
          },
        ],
        rootDir,
        sessionId: "session",
        shellDialect: "posix",
      });

      expect(rewritten.command.command).toMatch(
        /^\. '\/tmp\/init snapshot\.sh' 2>\/dev\/null \|\| true\n\. '.+embedded-search-startup-.+\.sh'\neval '/u,
      );
      expect(rewritten.command.command).toContain(
        "eval 'find . -name '\\''*.ts'\\'''",
      );
    } finally {
      rmSync(rootDir, { force: true, recursive: true });
    }
  });

  it("keeps Git Bash shell snapshot sources ahead of converted embedded search prelude scripts", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "zcode-bash-startup-"));
    try {
      const request = {
        command: {
          mode: "shell" as const,
          command: "grep needle file.txt",
          shellProfile: "posix-bash" as const,
        },
        bashPrelude: {
          kind: "embedded-search" as const,
          backend: {
            kind: "internal-cli" as const,
            command: "C:\\Program Files\\ZCode\\zcode.exe",
            args: ["C:\\Users\\me\\z-code\\apps\\zcode-cli\\src\\run.ts", "__internal-search"],
          },
        },
      };

      const rewritten = applyBashSourcesToExecutionRequest(request, {
        leadingSources: [
          {
            path: "C:\\Users\\me\\AppData\\Local\\ZCode\\shell-snapshots\\snapshot-bash-1.sh",
            shellPath: "/c/Users/me/AppData/Local/ZCode/shell-snapshots/snapshot-bash-1.sh",
            optional: true,
          },
        ],
        rootDir,
        sessionId: "session",
        shellDialect: "git-bash",
      });

      expect(rewritten.command.command).toMatch(
        /^\. \/c\/Users\/me\/AppData\/Local\/ZCode\/shell-snapshots\/snapshot-bash-1\.sh 2>\/dev\/null \|\| true\n\. '.+embedded-search-startup-.+\.sh'\neval 'grep needle file\.txt'$/u,
      );

      const startupDir = join(rootDir, "bash-startup", "session");
      const startupFile = readdirSync(startupDir).find((file) =>
        file.startsWith("embedded-search-startup-"),
      );
      expect(startupFile).toBeDefined();
      const startupContent = readFileSync(join(startupDir, startupFile!), "utf8");
      expect(startupContent).toContain(
        "command '/c/Program Files/ZCode/zcode.exe' /c/Users/me/z-code/apps/zcode-cli/src/run.ts __internal-search grep \"$@\"",
      );
    } finally {
      rmSync(rootDir, { force: true, recursive: true });
    }
  });

  it("returns the command unchanged when there are no sources", () => {
    expect(applyBashSourceScripts("echo ok", [])).toBe("echo ok");
  });

  it("eval-quotes commands containing single quotes", () => {
    const materialized = { path: "/tmp/start up.sh", shellPath: "/tmp/start up.sh" };
    expect(applyBashSourceScript("echo 'a b'", materialized)).toBe(
      ". '/tmp/start up.sh'\neval 'echo '\\''a b'\\'''",
    );
  });

  it.runIf(TEST_ZSH_PATH)("zsh expands snapshot aliases through eval", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "zcode-bash-startup-zsh-"));
    try {
      const snapshot = join(rootDir, "snapshot.sh");
      writeFileSync(snapshot, "alias -- zcode_snap_alias='echo zsh-alias-ok'\n");
      const command = applyBashSourceScripts("zcode_snap_alias", [
        { path: snapshot, shellPath: snapshot },
      ]);
      // 不带 eval 边界时 zsh -c 对整串先解析，source 的 alias 对后续命令不生效。
      const stdout = execFileSync(TEST_ZSH_PATH!, ["-c", command], { encoding: "utf8" });
      expect(stdout.trim()).toBe("zsh-alias-ok");
    } finally {
      rmSync(rootDir, { force: true, recursive: true });
    }
  });

  it.runIf(TEST_BASH_PATH)("bash keeps expanding snapshot aliases through eval", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "zcode-bash-startup-bash-"));
    try {
      const snapshot = join(rootDir, "snapshot.sh");
      writeFileSync(snapshot, "shopt -s expand_aliases\nalias -- zcode_snap_alias='echo bash-alias-ok'\n");
      const command = applyBashSourceScripts("zcode_snap_alias", [
        { path: snapshot, shellPath: snapshot },
      ]);
      const stdout = execFileSync(TEST_BASH_PATH!, ["-c", command], { encoding: "utf8" });
      expect(stdout.trim()).toBe("bash-alias-ok");
    } finally {
      rmSync(rootDir, { force: true, recursive: true });
    }
  });
});
