"""Launcher contracts with fake Camoufox modules; no downloads or browsers."""
from __future__ import annotations

import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import ModuleType
from unittest.mock import Mock, patch


class LaunchTests(unittest.TestCase):
    """Keep the probe environment minimal and the coordinator output unchanged."""

    def setUp(self) -> None:
        """Load the launcher without importing any real Camoufox dependencies."""
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.executable = self.root / "camoufox"
        self.executable.touch()
        self.selected_launch_path = Mock(return_value=str(self.executable))
        self.launch_options = Mock(return_value={
            "executable_path": str(self.executable),
            "args": [],
            "env": {"CAMOU_CONFIG_1": "fixture-config", "FONTCONFIG_PATH": "fixture-fonts"},
            "firefox_user_prefs": {},
            "headless": True,
        })
        addons = ModuleType("camoufox.addons")
        addons.DefaultAddons = ("fixture-addon",)
        pkgman = ModuleType("camoufox.pkgman")
        pkgman.selected_launch_path = self.selected_launch_path
        utils = ModuleType("camoufox.utils")
        utils.launch_options = self.launch_options
        modules = {
            "camoufox": ModuleType("camoufox"),
            "camoufox.addons": addons,
            "camoufox.pkgman": pkgman,
            "camoufox.utils": utils,
        }
        spec = importlib.util.spec_from_file_location("outpost_launch", Path(__file__).with_name("launch.py"))
        assert spec and spec.loader
        self.launch = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, modules):
            spec.loader.exec_module(self.launch)

        self.safe_env = {
            "PATH": "/usr/bin:/bin",
            "HOME": str(self.root),
            "LANG": "en_US.UTF-8",
            "TMPDIR": str(self.root / "tmp"),
            "XDG_CACHE_HOME": str(self.root / "cache"),
            "XDG_CONFIG_HOME": str(self.root / "config"),
        }
        environment = patch.dict(os.environ, self.safe_env, clear=True)
        environment.start()
        self.addCleanup(environment.stop)

    def run_launch(self) -> dict:
        """Capture only the coordinator's JSON response."""
        output = io.StringIO()
        with redirect_stdout(output):
            self.launch.main()
        return json.loads(output.getvalue())

    def test_probe_environment_is_allowlisted(self) -> None:
        """Forward HOME and safe host settings, not credentials or runtime flags."""
        unsafe_env = {
            "OUTPOST_BOOTSTRAP_TOKEN": "synthetic-token",
            "OPENAI_API_KEY": "synthetic-api-key",
            "AWS_SECRET_ACCESS_KEY": "synthetic-secret",
            "HTTP_PROXY": "http://proxy.invalid",
            "HTTPS_PROXY": "http://proxy.invalid",
            "ALL_PROXY": "socks5://proxy.invalid",
            "NO_PROXY": "*",
            "http_proxy": "http://proxy.invalid",
            "https_proxy": "http://proxy.invalid",
            "all_proxy": "socks5://proxy.invalid",
            "no_proxy": "*",
            "MOZ_DISABLE_CONTENT_SANDBOX": "1",
            "MOZ_DISABLE_GPU_SANDBOX": "1",
            "MOZ_DISABLE_RDD_SANDBOX": "1",
            "CAMOU_CONFIG_1": "ambient-config",
            "FONTCONFIG_PATH": "ambient-fonts",
            "UNLISTED_SETTING": "not-allowed",
        }
        for platform, browser_os in (("linux", "linux"), ("darwin", "macos")):
            with self.subTest(platform=platform), patch.object(sys, "platform", platform), patch.dict(os.environ, unsafe_env):
                self.selected_launch_path.reset_mock()
                self.launch_options.reset_mock()
                self.run_launch()
                self.selected_launch_path.assert_called_once_with("official/158.0.1-beta.41")
                self.launch_options.assert_called_once_with(
                    executable_path=str(self.executable),
                    headless=True,
                    os=browser_os,
                    enable_cache=True,
                    exclude_addons=["fixture-addon"],
                    humanize=False,
                    env=self.safe_env,
                )

    def test_optional_environment_values_can_be_empty_or_missing(self) -> None:
        """HOME is required; unused optional variables need no synthesized defaults."""
        with patch.dict(os.environ, {"HOME": str(self.root), "PATH": "", "LANG": "", "TMPDIR": ""}, clear=True):
            self.run_launch()
        self.assertEqual(self.launch_options.call_args.kwargs["env"], {"HOME": str(self.root)})

    def test_final_environment_keeps_only_generated_prefixes(self) -> None:
        """Never emit the host allowlist or unexpected package values to Node."""
        self.launch_options.return_value["env"].update({
            **self.safe_env,
            "OUTPOST_BOOTSTRAP_TOKEN": "synthetic-token",
            "HTTPS_PROXY": "http://proxy.invalid",
            "MOZ_DISABLE_CONTENT_SANDBOX": "1",
            "CAMOU": "wrong-prefix",
            "FONTCONFIG": "wrong-prefix",
            "CAMOU_TEST_NUMBER": 42,
            "FONTCONFIG_FILE": "fixture-fonts.conf",
        })
        result = self.run_launch()
        self.assertEqual(result, {
            "executable_path": str(self.executable),
            "args": [],
            "env": {
                "CAMOU_CONFIG_1": "fixture-config",
                "CAMOU_TEST_NUMBER": "42",
                "FONTCONFIG_PATH": "fixture-fonts",
                "FONTCONFIG_FILE": "fixture-fonts.conf",
            },
            "firefox_user_prefs": {},
            "headless": True,
        })

    def test_missing_or_empty_home_fails_before_camoufox_calls(self) -> None:
        """Explain how to fix HOME before any provisioning or GPU probe can run."""
        for platform in ("linux", "darwin"):
            for home in (None, ""):
                environment = {} if home is None else {"HOME": home}
                with self.subTest(platform=platform, home=home), patch.object(sys, "platform", platform), patch.dict(os.environ, environment, clear=True):
                    with self.assertRaisesRegex(RuntimeError, "HOME.*[Ss]et.*home directory"):
                        self.run_launch()
                    self.selected_launch_path.assert_not_called()
                    self.launch_options.assert_not_called()

    def test_missing_executable_fails_before_launch_options(self) -> None:
        """Keep the pinned-installation error without provisioning or probing."""
        self.executable.unlink()
        with self.assertRaisesRegex(RuntimeError, "The pinned Camoufox browser is not installed"):
            self.run_launch()
        self.selected_launch_path.assert_called_once_with("official/158.0.1-beta.41")
        self.launch_options.assert_not_called()


if __name__ == "__main__":
    unittest.main()
