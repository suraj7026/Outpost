"""Process configuration for the self-hosted browser executor."""
import os
from pathlib import Path


def configure() -> None:
    """Disable vendor telemetry and keep logs out of the JSON result stream."""
    os.environ["ANONYMIZED_TELEMETRY"] = "false"
    os.environ["BROWSER_USE_LOGGING_LEVEL"] = "warning"


def chromium_path() -> Path:
    """Resolve the Chromium installed in the workspace image."""
    override = os.environ.get("OUTPOST_CHROMIUM_PATH")
    if override:
        return Path(override)
    matches = sorted(Path("/opt/browsers").glob("chromium-*/chrome-linux64/chrome"))
    if not matches:
        raise RuntimeError("Workspace Chromium installation not found")
    return matches[-1]
