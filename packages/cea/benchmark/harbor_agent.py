from __future__ import annotations

# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUntypedBaseClass=false, reportUnknownParameterType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnusedFunction=false
from collections.abc import Mapping
import json, os, shlex
from pathlib import Path
from typing import cast, final

from harbor.agents.installed.base import BaseInstalledAgent, ExecInput
from harbor.models.agent.context import AgentContext


@final
class CodeEditingAgent(BaseInstalledAgent):
    SUPPORTS_ATIF: bool = True
    name = staticmethod(lambda: "code-editing-agent")
    version = staticmethod(lambda: "1.0.0")

    @property
    def _install_agent_template_path(self) -> Path:
        return Path(__file__).parent / "install-agent.sh.j2"

    def populate_context_post_run(self, context: AgentContext) -> None:
        d = self.logs_dir
        path = Path(os.getenv("ATIF_OUTPUT_PATH", str(d / "trajectory.json")))
        if not path.is_absolute():
            path = d / path
        if not path.exists():
            items = "dir not found" if not d.exists() else list(d.glob("**/*"))
            print(f"No trajectory file found at: {path}")
            print(f"logs_dir contents: {items}")
            return
        try:
            t = cast(Mapping[str, object], json.loads(path.read_text()))
        except Exception as e:
            print(f"Failed to read trajectory: {e}")
            return
        m = cast(Mapping[str, int | None], t.get("final_metrics") or {})
        context.n_input_tokens = m.get("total_prompt_tokens") or 0
        context.n_output_tokens = m.get("total_completion_tokens") or 0
        context.n_cache_tokens = m.get("total_cached_tokens") or 0

    def create_run_agent_commands(self, instruction: str) -> list[ExecInput]:
        prompt = shlex.quote(instruction)
        env = {
            "FRIENDLI_TOKEN": os.getenv("FRIENDLI_TOKEN", ""),
            "PATH": "/usr/local/bin:/usr/bin:/bin",
            "ATIF_OUTPUT_PATH": "/logs/agent/trajectory.json",
        }
        env = {k: v for k, v in env.items() if v}
        model_arg = f"-m {shlex.quote(self.model_name)}" if self.model_name else ""
        flags = ["--atif"]
        if os.getenv("AGENT_ENABLE_THINKING", "").lower() in ("1", "true", "yes"):
            flags.append("--think")
        if os.getenv("AGENT_ENABLE_TOOL_FALLBACK", "").lower() in ("1", "true", "yes"):
            flags.append("--tool-fallback")
        cmd = f"cd /agent && node --conditions=@ai-sdk-tool/source --import tsx /agent/packages/cea/src/entrypoints/main.ts -p {prompt} {model_arg} {' '.join(flags)} 2>&1 | tee /logs/agent/output.jsonl"
        return [
            ExecInput(command="mkdir -p /logs/agent"),
            ExecInput(command=cmd, env=env),
        ]
