"""Run one self-hosted Browser-Use task and emit a validated JSON result."""
from __future__ import annotations

import asyncio
import contextlib
import shutil
import sys
from pathlib import Path
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, HttpUrl

from environment import chromium_path, configure

configure()


class BrowserTask(BaseModel):
    """A bounded browser task submitted by the Outpost coordinator."""

    model_config = ConfigDict(extra="forbid")
    task: str = Field(min_length=1, max_length=20000)
    model: str = Field(min_length=1)
    base_url: HttpUrl
    directory: Path
    max_steps: int = Field(default=20, ge=1, le=100)
    vision: bool = True


class BrowserResult(BaseModel):
    """Observed browser execution evidence; agent success is not independent proof."""

    done: bool
    agent_reported_success: bool | None
    result: str | None
    urls: list[str]
    errors: list[str]
    screenshots: list[str]
    steps: int
    duration_seconds: float


async def run_task(request: BrowserTask) -> BrowserResult:
    """Execute locally using Ollama; never provision a vendor cloud browser."""
    from browser_use import Agent, Browser, ChatOllama

    directory = request.directory.resolve()
    output = directory / "browser" / uuid4().hex
    output.mkdir(parents=True, mode=0o700)
    browser = Browser(
        executable_path=str(chromium_path()),
        headless=True,
        use_cloud=False,
        is_local=True,
        chromium_sandbox=False,
        enable_default_extensions=False,
        captcha_solver=False,
        user_data_dir=str(directory / "browser-profile"),
        downloads_path=str(output / "downloads"),
    )
    llm = ChatOllama(
        model=request.model,
        host=str(request.base_url).rstrip("/").removesuffix("/v1"),
        timeout=90,
    )
    agent = Agent(
        task=request.task,
        llm=llm,
        browser=browser,
        use_vision=request.vision,
        use_judge=False,
        enable_planning=False,
        max_failures=2,
        llm_timeout=90,
        file_system_path=str(output / "files"),
        save_conversation_path=str(output / "conversation"),
    )
    try:
        history = await agent.run(max_steps=request.max_steps)
        screenshots: list[str] = []
        for index, source in enumerate([p for p in history.screenshot_paths() if p][-3:]):
            path = Path(source)
            if path.is_file():
                destination = output / f"screenshot-{index + 1}.png"
                shutil.copyfile(path, destination)
                screenshots.append(str(destination))
        return BrowserResult(
            done=history.is_done(),
            agent_reported_success=history.is_successful(),
            result=history.final_result(),
            urls=[url for url in history.urls() if url],
            errors=[error for error in history.errors() if error],
            screenshots=screenshots,
            steps=history.number_of_steps(),
            duration_seconds=history.total_duration_seconds(),
        )
    finally:
        await browser.kill()


def main() -> None:
    """Read a single JSON request from stdin and write a single JSON response."""
    request = BrowserTask.model_validate_json(sys.stdin.read(65537))
    with contextlib.redirect_stdout(sys.stderr):
        result = asyncio.run(run_task(request))
    print(result.model_dump_json())


if __name__ == "__main__":
    main()
