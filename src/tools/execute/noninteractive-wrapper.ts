import { platform } from "node:os";

export interface WrapperResult {
  command: string;
  env: Record<string, string>;
  wrapped: boolean;
  tool: string | null;
  description: string | null;
}

interface ToolPattern {
  pattern: RegExp;
  name: string;
  env: Record<string, string>;
  prefixArgs?: string[];
  suffixArgs?: string[];
  description: string;
}

const TOOL_PATTERNS: ToolPattern[] = [
  {
    pattern: /^(sudo\s+)?(apt-get|apt)\s+/,
    name: "apt",
    env: { DEBIAN_FRONTEND: "noninteractive" },
    suffixArgs: ["-y"],
    description: "Debian/Ubuntu package manager (non-interactive mode)",
  },
  {
    pattern: /^(sudo\s+)?dpkg\s+/,
    name: "dpkg",
    env: { DEBIAN_FRONTEND: "noninteractive" },
    description: "Debian package manager (non-interactive mode)",
  },
  {
    pattern: /^git\s+(clone|fetch|pull|push|submodule)/,
    name: "git",
    env: {
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND:
        "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new",
    },
    description: "Git operations (no TTY prompts)",
  },
  {
    pattern: /^ssh\s+/,
    name: "ssh",
    env: {},
    prefixArgs: [
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
    ],
    description: "SSH connection (batch mode, no prompts)",
  },
  {
    pattern: /^scp\s+/,
    name: "scp",
    env: {},
    prefixArgs: [
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
    ],
    description: "SCP transfer (batch mode, no prompts)",
  },
  {
    pattern: /^(pip|pip3)\s+install/,
    name: "pip",
    env: { PIP_NO_INPUT: "1" },
    description: "Python pip (no input mode)",
  },
  {
    pattern: /^npm\s+(install|ci|update)/,
    name: "npm",
    env: { CI: "true", npm_config_yes: "true" },
    description: "npm package manager (CI mode)",
  },
  {
    pattern: /^yarn\s+(install|add)/,
    name: "yarn",
    env: { CI: "true" },
    suffixArgs: ["--non-interactive"],
    description: "Yarn package manager (non-interactive)",
  },
  {
    pattern: /^pnpm\s+(install|add)/,
    name: "pnpm",
    env: { CI: "true" },
    description: "pnpm package manager (CI mode)",
  },
  {
    pattern: /^bun\s+(install|add)/,
    name: "bun",
    env: { CI: "true" },
    description: "Bun package manager (CI mode)",
  },
  {
    pattern: /^(sudo\s+)?yum\s+/,
    name: "yum",
    env: {},
    suffixArgs: ["-y"],
    description: "YUM package manager (assume yes)",
  },
  {
    pattern: /^(sudo\s+)?dnf\s+/,
    name: "dnf",
    env: {},
    suffixArgs: ["-y"],
    description: "DNF package manager (assume yes)",
  },
  {
    pattern: /^(sudo\s+)?pacman\s+/,
    name: "pacman",
    env: {},
    suffixArgs: ["--noconfirm"],
    description: "Pacman package manager (no confirm)",
  },
  {
    pattern: /^(sudo\s+)?apk\s+/,
    name: "apk",
    env: {},
    description: "Alpine package manager (non-interactive by default)",
  },
  {
    pattern: /^brew\s+(install|upgrade|update)/,
    name: "brew",
    env: {
      HOMEBREW_NO_AUTO_UPDATE: "1",
      NONINTERACTIVE: "1",
    },
    description: "Homebrew (non-interactive mode)",
  },
  {
    pattern: /^composer\s+(install|update|require)/,
    name: "composer",
    env: { COMPOSER_NO_INTERACTION: "1" },
    description: "PHP Composer (no interaction)",
  },
  {
    pattern: /^cargo\s+(install|build)/,
    name: "cargo",
    env: {},
    description: "Rust Cargo (non-interactive by default)",
  },
  {
    pattern: /^go\s+(get|install|mod)/,
    name: "go",
    env: {},
    description: "Go modules (non-interactive by default)",
  },
  {
    pattern: /^gem\s+install/,
    name: "gem",
    env: {},
    suffixArgs: ["--no-document"],
    description: "Ruby Gem (skip documentation prompts)",
  },
  {
    pattern: /^docker\s+(build|pull|push)/,
    name: "docker",
    env: { DOCKER_CLI_HINTS: "false" },
    description: "Docker operations (no hints)",
  },
  {
    pattern: /^ansible(-playbook)?\s+/,
    name: "ansible",
    env: { ANSIBLE_HOST_KEY_CHECKING: "False" },
    description: "Ansible (skip host key checking)",
  },
  {
    pattern: /^terraform\s+(apply|destroy)/,
    name: "terraform",
    env: {},
    suffixArgs: ["-auto-approve"],
    description: "Terraform (auto-approve)",
  },
  {
    pattern: /^kubectl\s+(delete|apply)/,
    name: "kubectl",
    env: {},
    description: "Kubernetes kubectl (non-interactive by default)",
  },
  {
    pattern: /^mysql\s+/,
    name: "mysql",
    env: {},
    prefixArgs: ["--batch"],
    description: "MySQL client (batch mode)",
  },
  {
    pattern: /^psql\s+/,
    name: "psql",
    env: {},
    description: "PostgreSQL client (non-interactive by default with -c)",
  },
];

function hasFlag(command: string, flag: string): boolean {
  const flagPattern = new RegExp(`(^|\\s)${flag}(\\s|$)`);
  return flagPattern.test(command);
}

function insertArgsAfterCommand(
  command: string,
  toolPattern: RegExp,
  args: string[]
): string {
  const match = command.match(toolPattern);
  if (!match) {
    return command;
  }

  const matchEnd = (match.index ?? 0) + match[0].length;
  const before = command.slice(0, matchEnd);
  const after = command.slice(matchEnd);

  return `${before}${args.join(" ")} ${after}`.replace(/\s+/g, " ").trim();
}

function appendArgs(command: string, args: string[]): string {
  const argsToAdd = args.filter((arg) => !hasFlag(command, arg));
  if (argsToAdd.length === 0) {
    return command;
  }
  return `${command} ${argsToAdd.join(" ")}`;
}

export function wrapCommandNonInteractive(command: string): WrapperResult {
  const trimmedCommand = command.trim();

  for (const tool of TOOL_PATTERNS) {
    if (tool.pattern.test(trimmedCommand)) {
      let wrappedCommand = trimmedCommand;
      const env: Record<string, string> = { ...tool.env };

      if (tool.prefixArgs && tool.prefixArgs.length > 0) {
        wrappedCommand = insertArgsAfterCommand(
          wrappedCommand,
          tool.pattern,
          tool.prefixArgs
        );
      }

      if (tool.suffixArgs && tool.suffixArgs.length > 0) {
        wrappedCommand = appendArgs(wrappedCommand, tool.suffixArgs);
      }

      const wasModified =
        wrappedCommand !== trimmedCommand || Object.keys(env).length > 0;

      return {
        command: wrappedCommand,
        env,
        wrapped: wasModified,
        tool: tool.name,
        description: wasModified ? tool.description : null,
      };
    }
  }

  return {
    command: trimmedCommand,
    env: {},
    wrapped: false,
    tool: null,
    description: null,
  };
}

export function buildEnvPrefix(env: Record<string, string>): string {
  if (Object.keys(env).length === 0) {
    return "";
  }

  return `${Object.entries(env)
    .map(([key, value]) => `${key}='${value.replace(/'/g, "'\\''")}'`)
    .join(" ")} `;
}

export function getFullWrappedCommand(command: string): string {
  const result = wrapCommandNonInteractive(command);
  if (!result.wrapped) {
    return command;
  }

  const envPrefix = buildEnvPrefix(result.env);
  return `${envPrefix}${result.command}`;
}

export function isLinux(): boolean {
  return platform() === "linux";
}

export function isDarwin(): boolean {
  return platform() === "darwin";
}
