from __future__ import annotations

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

    @property
    def _install_agent_template_path(self) -> Path:
        return Path(__file__).parent / "install-agent.sh.j2"

    def _get_log_file(self) -> Path | None:
        log_file = self.logs_dir / "agent" / "output.jsonl"
        if log_file.exists():
            return log_file
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
            message = event.get("message", {})

            if event_type == "user":
                step_id += 1
                content = message.get("content", "")
                text_content = (
                    str(content) if isinstance(content, list) else str(content)
                )
                steps.append(
                    Step(
                        step_id=step_id,
                        timestamp=timestamp,
                        source="user",
                        message=text_content,
                    )
                )

            elif event_type == "assistant":
                step_id += 1
                content = message.get("content", "")
                model_name = message.get("model")
                usage = message.get("usage", {})

                tool_calls: list[ToolCall] = []
                text_content = ""

                if isinstance(content, list):
                    for block in content:
                        if isinstance(block, dict) and block.get("type") == "tool_use":
                            tool_calls.append(
                                ToolCall(
                                    tool_call_id=block.get("id", ""),
                                    function_name=block.get("name", ""),
                                    arguments=block.get("input", {}),
                                )
                            )
                        else:
                            text_content += str(block)
                else:
                    text_content = str(content)

                metrics = None
                if usage:
                    metrics = Metrics(
                        prompt_tokens=usage.get("input_tokens"),
                        completion_tokens=usage.get("output_tokens"),
                        cached_tokens=usage.get("cache_read_input_tokens"),
                    )

                observation = None
                tool_result = event.get("toolUseResult")
                if tool_result and tool_calls:
                    observation = Observation(
                        results=[
                            ObservationResult(
                                source_call_id=tool_calls[0].tool_call_id,
                                content=tool_result.get("stdout", ""),
                            )
                        ]
                    )

                steps.append(
                    Step(
                        step_id=step_id,
                        timestamp=timestamp,
                        source="agent",
                        message=text_content or "Tool execution",
                        model_name=model_name or self.model_name,
                        tool_calls=tool_calls if tool_calls else None,
                        observation=observation,
                        metrics=metrics,
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
            print("No output log file found")
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
        }
        env = {k: v for k, v in env.items() if v}

        return [
            ExecInput(
                command="mkdir -p /logs/agent",
            ),
            ExecInput(
                command=(
                    f"export BUN_INSTALL=$HOME/.bun && export PATH=$BUN_INSTALL/bin:$PATH && "
                    f"cd /app && bun run headless -p {escaped_instruction} "
                    f"2>&1 | tee /logs/agent/output.jsonl"
                ),
                env=env,
            ),
        ]
