"""DeepEval checks for Pi Agent tool trajectories.

This first layer is intentionally deterministic: it compares the tools emitted
by the Agent with the expected tool for each scripted acceptance scenario. It
does not call an LLM judge and therefore consumes no model tokens.
"""

import json
import re
from collections import Counter
from pathlib import Path

from deepeval.metrics import ToolCorrectnessMetric
from deepeval.models import DeepEvalBaseLLM
from deepeval.test_case import LLMTestCase, ToolCall


ROOT = Path(__file__).resolve().parents[1]
TRACE = ROOT / "test-results" / "pi-agent-trace.json"


class OfflineJudge(DeepEvalBaseLLM):
    """Prevents DeepEval from creating a default OpenAI judge."""

    def load_model(self):
        return self

    def generate(self, *args, **kwargs):
        raise RuntimeError("offline tool correctness must not invoke an LLM")

    async def a_generate(self, *args, **kwargs):
        raise RuntimeError("offline tool correctness must not invoke an LLM")

    def get_model_name(self):
        return "offline-deterministic"


def text_of(message):
    content = (message or {}).get("content", "")
    if isinstance(content, str):
        return content
    return "\n".join(item.get("text", "") for item in content if item.get("type") == "text")


def runs_from(events):
    runs = []
    current = None
    for event in events:
        kind = event.get("type")
        if kind == "agent_start":
            current = {"input": "", "tools": []}
        elif current is not None and kind == "message_start" and event.get("message", {}).get("role") == "user":
            current["input"] = text_of(event["message"])
        elif current is not None and kind == "tool_execution_start":
            current["tools"].append(event.get("toolName", ""))
        elif current is not None and kind == "agent_settled":
            runs.append(current)
            current = None
    return runs


def expected_tool(prompt):
    # The desktop app appends a state snapshot containing prior prompts. Only
    # the first line is the current acceptance instruction.
    current_prompt = prompt.splitlines()[0] if prompt else ""
    markers = re.findall(r"PW_(?:FILE|WRITE|DESIGN|SOLVE|APPROVAL|INTERACTION|MEMORY)", current_prompt)
    marker = markers[-1] if markers else ""
    if marker == "PW_FILE":
        return "read"
    if marker == "PW_WRITE":
        return "write"
    if marker == "PW_MEMORY":
        return "memory_proposal"
    if marker == "PW_INTERACTION":
        return "interaction_request"
    if marker in {"PW_SOLVE", "PW_APPROVAL", "PW_DESIGN"}:
        return "workbench_action"
    return None


def main():
    if not TRACE.exists():
        raise SystemExit(f"trace not found: {TRACE}; run npm run test:e2e first")
    trace = json.loads(TRACE.read_text(encoding="utf-8"))
    runs = runs_from(trace["events"])
    results = []
    for run in runs:
        expected = expected_tool(run["input"])
        if not expected:
            continue
        metric = ToolCorrectnessMetric(model=OfflineJudge(), threshold=1.0, strict_mode=True, include_reason=True, async_mode=False)
        case = LLMTestCase(
            input=run["input"],
            actual_output="Agent completed the requested integration scenario.",
            tools_called=[ToolCall(name=name) for name in run["tools"]],
            expected_tools=[ToolCall(name=expected)],
        )
        metric.measure(case)
        score = float(metric.score or 0)
        results.append({"scenario": re.split(r"[：:]", run["input"], maxsplit=1)[0], "expected": expected, "actual": run["tools"], "score": score, "reason": metric.reason})
        if score < 1:
            raise AssertionError(json.dumps(results[-1], ensure_ascii=False))
    # The integration trace includes a second solve after force-stopping Pi.
    # Check all expected scenarios instead of a stale four-run total.
    expected_counts = {"PW_DESIGN": 1, "PW_FILE": 1, "PW_WRITE": 1, "PW_APPROVAL": 1, "PW_INTERACTION": 1, "PW_SOLVE": 2, "PW_MEMORY": 1}
    counts = Counter(item["scenario"] for item in results)
    if counts != expected_counts:
        raise AssertionError(f"unexpected acceptance coverage: {dict(counts)}, expected {expected_counts}")
    print(json.dumps({"ok": True, "deterministic": True, "results": results}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
