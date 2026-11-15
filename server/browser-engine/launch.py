"""Emit local launch settings for the coordinator-owned Camoufox process."""
from __future__ import annotations

import contextlib
import json
import os
import sys
from pathlib import Path

from camoufox.addons import DefaultAddons
from camoufox.pkgman import selected_launch_path
from camoufox.utils import launch_options

BROWSER_VERSION = "official/158.0.1-beta.41"


def main() -> None:
    """Resolve launch settings for the pinned installed browser.

    Camoufox's launch_options may provision its pinned fpgen model and start a
    host GPU probe before returning these settings.
    """
    # Firefox's profile service needs HOME even with an explicit GPU probe profile.
    probe_env = {
        key: os.environ[key]
        for key in ("PATH", "HOME", "LANG", "TMPDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME")
        if os.environ.get(key)
    }
    if not probe_env.get("HOME"):
        raise RuntimeError(
            "Camoufox requires a non-empty HOME; set it to the coordinator user's "
            "home directory before starting browser work"
        )
    with contextlib.redirect_stdout(sys.stderr):
        executable = selected_launch_path(BROWSER_VERSION)
        if not Path(executable).is_file():
            raise RuntimeError("The pinned Camoufox browser is not installed")
        options = launch_options(
            executable_path=executable,
            headless=True,
            os={"darwin": "macos", "linux": "linux", "win32": "windows"}[sys.platform],
            enable_cache=True,
            exclude_addons=list(DefaultAddons),
            humanize=False,
            env=probe_env,
        )
    # Never pass the coordinator's credentials into a browser process.
    options["env"] = {
        key: str(value) for key, value in options["env"].items()
        if key.startswith("CAMOU_") or key.startswith("FONTCONFIG_")
    }
    print(json.dumps(options))


if __name__ == "__main__":
    main()
