"""Recover a stuck AppKit main thread through the existing launchd KeepAlive.

The watchdog is a separate, non-GUI process: a Python thread in the app could
freeze along with it. Only the main run loop writes heartbeats. Pipe EOF and the
parent relationship bind the watchdog to this exact app instance, without PID
files or a second LaunchAgent.
"""
from __future__ import annotations

import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import time

HEARTBEAT_INTERVAL = 5.0
HANG_TIMEOUT = 60.0
STARTUP_TIMEOUT = 120.0
SLEEP_GAP = 15.0


class HeartbeatDeadline:
    def __init__(self, monotonic, wall, *, timeout=HANG_TIMEOUT,
                 startup_timeout=STARTUP_TIMEOUT):
        self.timeout = timeout
        self.deadline = monotonic + startup_timeout
        self.last_monotonic, self.last_wall = monotonic, wall

    def expired(self, monotonic, wall, *, heartbeat):
        elapsed = monotonic - self.last_monotonic
        wall_elapsed = wall - self.last_wall
        # macOS clocks may exclude sleep; also handle a suspended watchdog or a
        # changed wall clock. Give AppKit a full timeout after either resumes.
        resumed = elapsed > SLEEP_GAP or abs(wall_elapsed - elapsed) > SLEEP_GAP
        if heartbeat or resumed:
            self.deadline = monotonic + self.timeout
        self.last_monotonic, self.last_wall = monotonic, wall
        return monotonic >= self.deadline


def _log(message):
    print(f"[menubar-watchdog] {time.strftime('%Y-%m-%d %H:%M:%S')} {message}",
          file=sys.stderr, flush=True)


def _capture_sample(pid, directory):
    """Keep the last three local native stack samples; never delay recovery >8s."""
    try:
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        slots = [directory / f"menubar-hang-{n}.sample.txt" for n in range(3)]
        dest = min(slots, key=lambda p: p.stat().st_mtime if p.exists() else 0)
        result = subprocess.run(
            ["/usr/bin/sample", str(pid), "2", "10", "-file", str(dest)],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, timeout=8)
        if result.returncode == 0:
            _log(f"saved stack sample to {dest}")
        else:
            _log(f"stack sample unavailable (exit {result.returncode}); recovering anyway")
    except (OSError, subprocess.TimeoutExpired) as exc:
        _log(f"stack sample unavailable ({type(exc).__name__}); recovering anyway")


def _watch(parent_pid, timeout, startup_timeout, diagnostic_dir):
    os.umask(0o077)
    fd = sys.stdin.fileno()
    deadline = HeartbeatDeadline(time.monotonic(), time.time(),
                                 timeout=timeout, startup_timeout=startup_timeout)
    while os.getppid() == parent_pid:
        ready, _, _ = select.select([fd], [], [], min(5.0, timeout / 4))
        heartbeat = bool(ready)
        if ready and not os.read(fd, 65536):
            return  # App exited or explicitly stopped its watchdog.
        if not deadline.expired(time.monotonic(), time.time(), heartbeat=heartbeat):
            continue

        _log(f"main thread unresponsive; sampling PID {parent_pid} before recovery")
        _capture_sample(parent_pid, diagnostic_dir)
        # A slow callback might have completed during the sample. Check again
        # before terminating, and never act on a PID after our parent exits.
        if os.getppid() != parent_pid:
            return
        ready, _, _ = select.select([fd], [], [], 0)
        if ready:
            if not os.read(fd, 65536):
                return
            deadline.expired(time.monotonic(), time.time(), heartbeat=True)
            _log("main thread resumed during sampling; no restart needed")
            continue
        # The watchdog itself could have slept while sampling, too.
        if not deadline.expired(time.monotonic(), time.time(), heartbeat=False):
            continue
        _log(f"terminating unresponsive PID {parent_pid}; launchd will restart the menu bar")
        try:
            os.kill(parent_pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        return


class HangWatchdog:
    """Owned by the UI process; pulse() must run on the main thread only."""
    def __init__(self, *, timeout=HANG_TIMEOUT, startup_timeout=STARTUP_TIMEOUT,
                 diagnostic_dir=None):
        self.timeout, self.startup_timeout = timeout, startup_timeout
        self.diagnostic_dir = Path(diagnostic_dir or
                                   Path.home() / ".claude-usage" / "diagnostics")
        self.process = None
        self._start()

    def _start(self):
        self.process = subprocess.Popen(
            [sys.executable, str(Path(__file__).resolve()), str(os.getpid()),
             str(self.timeout), str(self.startup_timeout), str(self.diagnostic_dir)],
            stdin=subprocess.PIPE)
        # A stopped watchdog must never block the AppKit thread on a full pipe.
        os.set_blocking(self.process.stdin.fileno(), False)

    def pulse(self):
        if self.process.poll() is not None:
            _log("watchdog exited; replacing it")
            self.close()
            self._start()
        try:
            os.write(self.process.stdin.fileno(), b".")
        except BlockingIOError:
            pass  # Already has pending heartbeats; keep the UI responsive.
        except BrokenPipeError:
            self.close()
            self._start()

    def close(self):
        if self.process is None:
            return
        self.process.stdin.close()
        try:
            self.process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=2)


def start_main_thread_heartbeat(watchdog, interval=HEARTBEAT_INTERVAL):
    # Lazy import keeps the watchdog process independent of AppKit/Foundation.
    from Foundation import NSRunLoop, NSRunLoopCommonModes, NSThread, NSTimer

    if not NSThread.isMainThread():
        raise RuntimeError("The watchdog heartbeat must be installed on the main thread")
    timer = NSTimer.timerWithTimeInterval_repeats_block_(
        interval, True, lambda _timer: watchdog.pulse())
    timer.setTolerance_(interval / 5)
    # Default-mode timers pause during dragging/menu tracking. Those interactions
    # are normal UI activity, so they must not look like a hung main thread.
    NSRunLoop.mainRunLoop().addTimer_forMode_(timer, NSRunLoopCommonModes)
    watchdog.pulse()
    return timer


if __name__ == "__main__":
    _watch(int(sys.argv[1]), float(sys.argv[2]), float(sys.argv[3]), Path(sys.argv[4]))
