from __future__ import annotations

# pyright: reportMissingImports=false

import json
import os
import shlex
from pathlib import Path
from typing import Any

from harbor.agents.installed.base import BaseInstalledAgent, ExecInput
from harbor.models.agent.context import AgentContext
from harbor.models.trajectories import (
    Agent,
    Step,
    ToolCall,
    Observation,
    ObservationResult,
    Metrics,
    FinalMetrics,
    Trajectory,
)


class CodeEditingAgent(BaseInstalledAgent):
    SUPPORTS_ATIF: bool = True

    @staticmethod
    def name() -> str:
        return "code-editing-agent"

    @staticmethod
    def version() -> str:
        return "1.0.0"

    @property
    def _install_agent_template_path(self) -> Path:
        return Path(__file__).parent / "install-agent.sh.j2"

    def _get_log_file(self) -> Path | None:
        log_file = self.logs_dir / "agent" / "output.jsonl"
        if log_file.exists():
            return log_file
        # Fallback: check if file exists directly in logs_dir
        alt_log_file = self.logs_dir / "output.jsonl"
        if alt_log_file.exists():
            return alt_log_file
        return None

    def _convert_events_to_trajectory(self, log_file: Path) -> Trajectory | None:
        events: list[dict[str, Any]] = []
        with open(log_file) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    events.append(json.loads(line))
                except json.JSONDecodeError:
                    continue

        if not events:
            return None

        session_id = events[0].get("sessionId", "unknown")
        steps: list[Step] = []
        step_id = 0

        for event in events:
            event_type = event.get("type")
            timestamp = event.get("timestamp")

            if event_type == "user":
                step_id += 1
                steps.append(
                    Step(
                        step_id=step_id,
                        timestamp=timestamp,
                        source="user",
                        message=event.get("content", ""),
                    )
                )

            elif event_type == "tool_call":
                step_id += 1
                steps.append(
                    Step(
                        step_id=step_id,
                        timestamp=timestamp,
                        source="agent",
                        message="Tool execution",
                        model_name=event.get("model") or self.model_name,
                        reasoning_content=event.get("reasoning_content"),
                        tool_calls=[
                            ToolCall(
                                tool_call_id=event.get("tool_call_id", ""),
                                function_name=event.get("tool_name", ""),
                                arguments=event.get("tool_input", {}),
                            )
                        ],
                        observation=None,
                    )
                )

            elif event_type == "tool_result":
                tool_call_id = event.get("tool_call_id")
                output = event.get("output", "")
                error = event.get("error")
                if error:
                    output = (
                        f"{output}\nSTDERR: {error}" if output else f"STDERR: {error}"
                    )

                if tool_call_id and steps:
                    for step in reversed(steps):
                        if step.source == "agent" and step.tool_calls:
                            matching = any(
                                tc.tool_call_id == tool_call_id
                                for tc in step.tool_calls
                            )
                            if matching:
                                result = ObservationResult(
                                    source_call_id=tool_call_id,
                                    content=output,
                                )
                                if step.observation:
                                    step.observation.results.append(result)
                                else:
                                    step.observation = Observation(results=[result])
                                break

            elif event_type == "assistant":
                step_id += 1
                steps.append(
                    Step(
                        step_id=step_id,
                        timestamp=timestamp,
                        source="agent",
                        message=event.get("content", ""),
                        model_name=event.get("model") or self.model_name,
                        reasoning_content=event.get("reasoning_content"),
                    )
                )

        if not steps:
            return None

        total_prompt = sum(
            s.metrics.prompt_tokens
            for s in steps
            if s.metrics and s.metrics.prompt_tokens
        )
        total_completion = sum(
            s.metrics.completion_tokens
            for s in steps
            if s.metrics and s.metrics.completion_tokens
        )
        total_cached = sum(
            s.metrics.cached_tokens
            for s in steps
            if s.metrics and s.metrics.cached_tokens
        )

        return Trajectory(
            schema_version="ATIF-v1.4",
            session_id=session_id,
            agent=Agent(
                name=self.name(),
                version=self.version(),
                model_name=self.model_name,
            ),
            steps=steps,
            final_metrics=FinalMetrics(
                total_prompt_tokens=total_prompt or None,
                total_completion_tokens=total_completion or None,
                total_cached_tokens=total_cached or None,
                total_steps=len(steps),
            ),
        )

    def populate_context_post_run(self, context: AgentContext) -> None:
        log_file = self._get_log_file()
        if not log_file:
            # Debug: print actual paths being checked
            expected_path = self.logs_dir / "agent" / "output.jsonl"
            print(f"No output log file found at: {expected_path}")
            print(
                f"logs_dir contents: {list(self.logs_dir.glob('**/*')) if self.logs_dir.exists() else 'dir not found'}"
            )
            return

        try:
            trajectory = self._convert_events_to_trajectory(log_file)
        except Exception as e:
            print(f"Failed to convert events to trajectory: {e}")
            return

        if not trajectory:
            print("Failed to convert events to trajectory")
            return

        trajectory_path = self.logs_dir / "trajectory.json"
        try:
            with open(trajectory_path, "w") as f:
                json.dump(trajectory.to_json_dict(), f, indent=2)
            print(f"Wrote trajectory to {trajectory_path}")
        except OSError as e:
            print(f"Failed to write trajectory: {e}")

        if trajectory.final_metrics:
            context.n_input_tokens = trajectory.final_metrics.total_prompt_tokens or 0
            context.n_output_tokens = (
                trajectory.final_metrics.total_completion_tokens or 0
            )
            context.n_cache_tokens = trajectory.final_metrics.total_cached_tokens or 0

    def create_run_agent_commands(self, instruction: str) -> list[ExecInput]:
        escaped_instruction = shlex.quote(instruction)

        env = {
            "FRIENDLI_TOKEN": os.environ.get("FRIENDLI_TOKEN", ""),
            "BUN_INSTALL": "/root/.bun",
            "PATH": "/root/.bun/bin:/usr/local/bin:/usr/bin:/bin",
        }
        env = {k: v for k, v in env.items() if v}

        # Build command with optional model parameter
        model_arg = f"-m {shlex.quote(self.model_name)}" if self.model_name else ""

        # Optional flags controlled by environment variables
        flags = []
        if os.environ.get("AGENT_ENABLE_THINKING", "").lower() in ("1", "true", "yes"):
            flags.append("--think")
        if os.environ.get("AGENT_ENABLE_TOOL_FALLBACK", "").lower() in (
            "1",
            "true",
            "yes",
        ):
            flags.append("--tool-fallback")

        flags_str = " ".join(flags)

        return [
            ExecInput(
                command="mkdir -p /logs/agent",
            ),
            ExecInput(
                command=(
                    f"/root/.bun/bin/bun /agent/packages/cea/src/entrypoints/headless.ts -p {escaped_instruction} {model_arg} {flags_str} "
                    f"2>&1 | tee /logs/agent/output.jsonl"
                ),
                env=env,
            ),
        ]
