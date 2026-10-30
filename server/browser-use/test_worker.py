"""Contract checks without calling a model or starting a browser."""
from pathlib import Path

import pytest
from pydantic import ValidationError

from environment import chromium_path, configure
from worker import BrowserResult, BrowserTask


def test_exact_ollama_model_is_preserved(tmp_path: Path) -> None:
    """Do not silently substitute a local model or vendor inference provider."""
    request = BrowserTask(
        task="Read the fixture page",
        model="glm-5.3-flash:cloud",
        base_url="http://192.168.1.37:11434/v1",
        directory=tmp_path,
    )
    assert request.model == "glm-5.3-flash:cloud"
    assert request.max_steps == 20
    with pytest.raises(ValidationError):
        BrowserTask.model_validate({**request.model_dump(), "use_cloud": True})
    with pytest.raises(ValidationError):
        BrowserTask.model_validate({**request.model_dump(), "max_steps": 101})


def test_result_does_not_equate_completion_with_success() -> None:
    """A finished browser trajectory can still fail the requested task."""
    result = BrowserResult(
        done=True,
        agent_reported_success=False,
        result="Blocked by the fixture",
        urls=[], errors=["blocked"], screenshots=[], steps=1, duration_seconds=0.1,
    )
    assert result.done and result.agent_reported_success is False


def test_local_chromium_and_telemetry(monkeypatch: pytest.MonkeyPatch) -> None:
    """The configured browser is local, and vendor telemetry stays disabled."""
    monkeypatch.setenv("OUTPOST_CHROMIUM_PATH", "/fixture/chromium")
    assert chromium_path() == Path("/fixture/chromium")
    configure()
    import os
    assert os.environ["ANONYMIZED_TELEMETRY"] == "false"
