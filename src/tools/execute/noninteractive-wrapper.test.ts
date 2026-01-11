import { describe, expect, it } from "bun:test";
import {
  buildEnvPrefix,
  getFullWrappedCommand,
  wrapCommandNonInteractive,
} from "./noninteractive-wrapper";

const DUPLICATE_Y_FLAG = /-y.*-y/;

describe("wrapCommandNonInteractive", () => {
  describe("apt/apt-get commands", () => {
    it("wraps apt-get install with DEBIAN_FRONTEND and -y", () => {
      const result = wrapCommandNonInteractive("apt-get install nginx");

      expect(result.wrapped).toBe(true);
      expect(result.tool).toBe("apt");
      expect(result.env.DEBIAN_FRONTEND).toBe("noninteractive");
      expect(result.command).toContain("-y");
    });

    it("wraps sudo apt-get install", () => {
      const result = wrapCommandNonInteractive("sudo apt-get install nginx");

      expect(result.wrapped).toBe(true);
      expect(result.tool).toBe("apt");
      expect(result.env.DEBIAN_FRONTEND).toBe("noninteractive");
    });

    it("wraps apt install", () => {
      const result = wrapCommandNonInteractive("apt install curl");

      expect(result.wrapped).toBe(true);
      expect(result.tool).toBe("apt");
    });

    it("does not duplicate -y flag if already present", () => {
      const result = wrapCommandNonInteractive("apt-get install -y nginx");

      expect(result.command).not.toMatch(DUPLICATE_Y_FLAG);
    });
  });

  describe("git commands", () => {
    it("wraps git clone with GIT_TERMINAL_PROMPT=0", () => {
      const result = wrapCommandNonInteractive(
        "git clone https://github.com/user/repo"
      );

      expect(result.wrapped).toBe(true);
      expect(result.tool).toBe("git");
      expect(result.env.GIT_TERMINAL_PROMPT).toBe("0");
      expect(result.env.GIT_SSH_COMMAND).toContain("BatchMode=yes");
    });

    it("wraps git fetch", () => {
      const result = wrapCommandNonInteractive("git fetch origin");

      expect(result.wrapped).toBe(true);
      expect(result.tool).toBe("git");
    });

    it("wraps git pull", () => {
      const result = wrapCommandNonInteractive("git pull");

      expect(result.wrapped).toBe(true);
      expect(result.tool).toBe("git");
    });

    it("wraps git push", () => {
      const result = wrapCommandNonInteractive("git push origin main");

      expect(result.wrapped).toBe(true);
      expect(result.tool).toBe("git");
    });

    it("does not wrap git status", () => {
      const result = wrapCommandNonInteractive("git status");

      expect(result.wrapped).toBe(false);
    });

    it("does not wrap git log", () => {
      const result = wrapCommandNonInteractive("git log --oneline");

      expect(result.wrapped).toBe(false);
    });
  });

  describe("ssh/scp commands", () => {
    it("wraps ssh with BatchMode", () => {
      const result = wrapCommandNonInteractive("ssh user@host");

      expect(result.wrapped).toBe(true);
      expect(result.tool).toBe("ssh");
      expect(result.command).toContain("BatchMode=yes");
    });

    it("wraps scp with BatchMode", () => {
      const result = wrapCommandNonInteractive("scp file.txt user@host:/path");

      expect(result.wrapped).toBe(true);
      expect(result.tool).toBe("scp");
      expect(result.command).toContain("BatchMode=yes");
    });
  });

  describe("npm/yarn/pnpm/bun commands", () => {
    it("wraps npm install with CI=true", () => {
      const result = wrapCommandNonInteractive("npm install");

      expect(result.wrapped).toBe(true);
      expect(result.tool).toBe("npm");
      expect(result.env.CI).toBe("true");
    });

    it("wraps yarn install with --non-interactive", () => {
      const result = wrapCommandNonInteractive("yarn install");

      expect(result.wrapped).toBe(true);
      expect(result.tool).toBe("yarn");
      expect(result.command).toContain("--non-interactive");
    });

    it("wraps pnpm install with CI=true", () => {
      const result = wrapCommandNonInteractive("pnpm install");

      expect(result.wrapped).toBe(true);
      expect(result.tool).toBe("pnpm");
      expect(result.env.CI).toBe("true");
    });

    it("wraps bun install with CI=true", () => {
      const result = wrapCommandNonInteractive("bun install");

      expect(result.wrapped).toBe(true);
      expect(result.tool).toBe("bun");
      expect(result.env.CI).toBe("true");
    });
  });

  describe("pip commands", () => {
    it("wraps pip install with PIP_NO_INPUT=1", () => {
      const result = wrapCommandNonInteractive("pip install requests");

      expect(result.wrapped).toBe(true);
      expect(result.tool).toBe("pip");
      expect(result.env.PIP_NO_INPUT).toBe("1");
    });

    it("wraps pip3 install", () => {
      const result = wrapCommandNonInteractive("pip3 install flask");

      expect(result.wrapped).toBe(true);
      expect(result.tool).toBe("pip");
    });
  });

  describe("package managers with -y flag", () => {
    it("wraps yum with -y", () => {
      const result = wrapCommandNonInteractive("yum install httpd");

      expect(result.wrapped).toBe(true);
      expect(result.tool).toBe("yum");
      expect(result.command).toContain("-y");
    });

    it("wraps dnf with -y", () => {
      const result = wrapCommandNonInteractive("dnf install nginx");

      expect(result.wrapped).toBe(true);
      expect(result.tool).toBe("dnf");
      expect(result.command).toContain("-y");
    });

    it("wraps pacman with --noconfirm", () => {
      const result = wrapCommandNonInteractive("pacman -S nginx");

      expect(result.wrapped).toBe(true);
      expect(result.tool).toBe("pacman");
      expect(result.command).toContain("--noconfirm");
    });
  });

  describe("brew commands", () => {
    it("wraps brew install with NONINTERACTIVE=1", () => {
      const result = wrapCommandNonInteractive("brew install wget");

      expect(result.wrapped).toBe(true);
      expect(result.tool).toBe("brew");
      expect(result.env.NONINTERACTIVE).toBe("1");
      expect(result.env.HOMEBREW_NO_AUTO_UPDATE).toBe("1");
    });
  });

  describe("terraform commands", () => {
    it("wraps terraform apply with -auto-approve", () => {
      const result = wrapCommandNonInteractive("terraform apply");

      expect(result.wrapped).toBe(true);
      expect(result.tool).toBe("terraform");
      expect(result.command).toContain("-auto-approve");
    });

    it("wraps terraform destroy with -auto-approve", () => {
      const result = wrapCommandNonInteractive("terraform destroy");

      expect(result.wrapped).toBe(true);
      expect(result.tool).toBe("terraform");
      expect(result.command).toContain("-auto-approve");
    });

    it("does not wrap terraform plan", () => {
      const result = wrapCommandNonInteractive("terraform plan");

      expect(result.wrapped).toBe(false);
    });
  });

  describe("unrecognized commands", () => {
    it("does not wrap unknown commands", () => {
      const result = wrapCommandNonInteractive("echo hello");

      expect(result.wrapped).toBe(false);
      expect(result.tool).toBeNull();
      expect(result.command).toBe("echo hello");
    });

    it("does not wrap ls command", () => {
      const result = wrapCommandNonInteractive("ls -la");

      expect(result.wrapped).toBe(false);
    });
  });
});

describe("buildEnvPrefix", () => {
  it("returns empty string for empty env", () => {
    const result = buildEnvPrefix({});

    expect(result).toBe("");
  });

  it("builds single env var prefix", () => {
    const result = buildEnvPrefix({ CI: "true" });

    expect(result).toBe("CI='true' ");
  });

  it("builds multiple env var prefix", () => {
    const result = buildEnvPrefix({
      DEBIAN_FRONTEND: "noninteractive",
      CI: "true",
    });

    expect(result).toContain("DEBIAN_FRONTEND='noninteractive'");
    expect(result).toContain("CI='true'");
    expect(result).toEndWith(" ");
  });
});

describe("getFullWrappedCommand", () => {
  it("returns full command with env prefix for apt", () => {
    const result = getFullWrappedCommand("apt-get install nginx");

    expect(result).toContain("DEBIAN_FRONTEND='noninteractive'");
    expect(result).toContain("apt-get install nginx");
    expect(result).toContain("-y");
  });

  it("returns original command for unrecognized commands", () => {
    const result = getFullWrappedCommand("echo hello");

    expect(result).toBe("echo hello");
  });
});
