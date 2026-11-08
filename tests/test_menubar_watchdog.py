"""The watchdog must recover a live-but-stuck process, not just a crash."""
import os
from pathlib import Path
import plistlib
import re
import signal
import subprocess
import sys
import time
import uuid

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from menubar_watchdog import HeartbeatDeadline, HangWatchdog  # noqa: E402


def test_deadline_allows_startup_then_requires_main_thread_progress():
    deadline = HeartbeatDeadline(0, 1000, timeout=60, startup_timeout=120)
    for now in range(5, 120, 5):
        assert not deadline.expired(now, 1000 + now, heartbeat=False)
    assert deadline.expired(120, 1120, heartbeat=False)

    deadline = HeartbeatDeadline(0, 1000, timeout=60, startup_timeout=120)
    assert not deadline.expired(5, 1005, heartbeat=True)
    for now in range(10, 65, 5):
        assert not deadline.expired(now, 1000 + now, heartbeat=False)
    assert deadline.expired(65, 1065, heartbeat=False)


@pytest.mark.parametrize("monotonic_jump,wall_jump", [(3600, 3600), (5, 3600), (5, -3600)])
def test_sleep_and_clock_changes_give_ui_a_fresh_grace_period(monotonic_jump, wall_jump):
    deadline = HeartbeatDeadline(0, 1000, timeout=60, startup_timeout=120)
    assert not deadline.expired(5, 1005, heartbeat=True)
    for now in range(10, 60, 5):
        assert not deadline.expired(now, 1000 + now, heartbeat=False)
    mono, wall = 55 + monotonic_jump, 1055 + wall_jump
    assert not deadline.expired(mono, wall, heartbeat=False)
    for offset in range(5, 60, 5):
        assert not deadline.expired(mono + offset, wall + offset, heartbeat=False)
    assert deadline.expired(mono + 60, wall + 60, heartbeat=False)


def test_healthy_heartbeats_do_not_accumulate_missed_time():
    deadline = HeartbeatDeadline(0, 1000, timeout=60, startup_timeout=120)
    for now in range(5, 86400, 5):
        assert not deadline.expired(now, 1000 + now, heartbeat=True)


CHILD = """
import sys, time
from pathlib import Path
from menubar_watchdog import HangWatchdog
watchdog = HangWatchdog(timeout=0.6, startup_timeout=10,
                       diagnostic_dir=Path(sys.argv[2]))
watchdog.pulse()
print(watchdog.process.pid, flush=True)
if sys.argv[1] == 'stuck':
    time.sleep(30)  # Alive, but no main-thread progress. The old app stayed stuck.
elif sys.argv[1] == 'healthy':
    for _ in range(20):
        watchdog.pulse()
        time.sleep(0.08)
    watchdog.close()
elif sys.argv[1] == 'exit':
    pass  # Deliberately skip cleanup: pipe EOF must still stop the watchdog.
"""


@pytest.mark.parametrize("mode", ["healthy", "stuck", "exit"])
def test_watchdog_process_lifecycle(mode, tmp_path):
    child = subprocess.Popen(
        [sys.executable, "-u", "-c", CHILD, mode, str(tmp_path)], cwd=ROOT,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        out, err = child.communicate(timeout=15)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
    if mode == "stuck":
        assert child.returncode == -signal.SIGKILL, (out, err)
        assert "main thread unresponsive" in err
    else:
        assert child.returncode == 0, (out, err)
        assert "main thread unresponsive" not in err
    # communicate() reaching EOF also verifies the watchdog closed its inherited
    # output descriptors and exited; an orphan would keep these pipes open.


def test_dead_watchdog_is_replaced_by_next_heartbeat(tmp_path):
    watchdog = HangWatchdog(diagnostic_dir=tmp_path)
    try:
        previous = watchdog.process
        previous.kill()
        previous.wait(timeout=3)
        watchdog.pulse()
        assert watchdog.process.pid != previous.pid
        assert watchdog.process.poll() is None
    finally:
        watchdog.close()


def test_heartbeat_never_blocks_when_watchdog_stops_reading(tmp_path):
    watchdog = HangWatchdog(diagnostic_dir=tmp_path)
    try:
        os.kill(watchdog.process.pid, signal.SIGSTOP)
        start = time.monotonic()
        # More bytes than the pipe can hold, to exercise backpressure.
        for _ in range(100_000):
            watchdog.pulse()
        assert time.monotonic() - start < 3
    finally:
        os.kill(watchdog.process.pid, signal.SIGCONT)
        watchdog.close()


@pytest.mark.skipif(sys.platform != "darwin" or os.environ.get("CLAUDE_USAGE_GUI_TESTS") != "1",
                    reason="Opt-in native test: needs access to the macOS GUI session")
@pytest.mark.parametrize("mode", ["baseline", "default", "tracking", "stall"])
def test_real_appkit_main_loop(mode, tmp_path):
    child = subprocess.Popen(
        [sys.executable, "-u", str(ROOT / "tests/fixtures/menubar_liveness_probe.py"),
         mode, str(tmp_path)], cwd=ROOT, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, text=True)
    try:
        if mode == "baseline":
            with pytest.raises(subprocess.TimeoutExpired):
                child.communicate(timeout=5)
            child.kill()
            out, err = child.communicate(timeout=5)
        else:
            out, err = child.communicate(timeout=15)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
    assert "AppKit probe ready" in out, (out, err)
    if mode == "stall":
        assert child.returncode == -signal.SIGKILL, (out, err)
        samples = list(tmp_path.glob("menubar-hang-*.sample.txt"))
        assert len(samples) == 1, err
        assert "com.apple.main-thread" in samples[0].read_text()
    elif mode != "baseline":
        assert child.returncode == 0, (out, err)
        assert "main thread unresponsive" not in err


@pytest.mark.skipif(sys.platform != "darwin" or os.environ.get("CLAUDE_USAGE_GUI_TESTS") != "1",
                    reason="Opt-in native test: creates and removes its own temporary LaunchAgent")
def test_launchd_restarts_the_hung_app(tmp_path):
    label = f"com.claude-usage.watchdog-probe.{uuid.uuid4().hex}"
    domain = f"gui/{os.getuid()}"
    plist = tmp_path / "probe.plist"
    output, errors = tmp_path / "probe.log", tmp_path / "probe.err.log"
    plist.write_bytes(plistlib.dumps({
        "Label": label,
        "ProgramArguments": [sys.executable, "-u",
                             str(ROOT / "tests/fixtures/menubar_liveness_probe.py"),
                             "launchd", str(tmp_path)],
        "WorkingDirectory": str(ROOT),
        "RunAtLoad": True, "KeepAlive": True, "ThrottleInterval": 1,
        "StandardOutPath": str(output), "StandardErrorPath": str(errors),
    }))
    loaded = False
    try:
        subprocess.run(["launchctl", "bootstrap", domain, str(plist)], check=True,
                       capture_output=True, timeout=10)
        loaded = True
        end = time.monotonic() + 20
        pids = []
        while time.monotonic() < end:
            if output.exists():
                pids = re.findall(r"AppKit probe ready: (\d+)", output.read_text())
            if len(pids) >= 2:
                break
            time.sleep(0.1)
        assert len(pids) == 2, errors.read_text() if errors.exists() else "No launch output"
        assert pids[0] != pids[1]
        assert "launchd will restart the menu bar" in errors.read_text()
        status = subprocess.run(["launchctl", "print", f"{domain}/{label}"], check=True,
                                capture_output=True, text=True, timeout=5).stdout
        assert f"pid = {pids[-1]}" in status
        assert "state = running" in status
    finally:
        if loaded:
            subprocess.run(["launchctl", "bootout", f"{domain}/{label}"],
                           check=True, capture_output=True, timeout=10)
