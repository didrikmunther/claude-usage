"""Isolated native run-loop probe. Never touches the real app or its settings."""
from pathlib import Path
import os
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from AppKit import NSApplication, NSEventTrackingRunLoopMode  # noqa: E402
from Foundation import NSDate, NSObject, NSRunLoop, NSTimer  # noqa: E402
import menubar  # noqa: E402
from menubar_watchdog import HangWatchdog, start_main_thread_heartbeat  # noqa: E402

MODE, DIAGNOSTICS = sys.argv[1:]
if MODE == "launchd":
    marker = Path(DIAGNOSTICS) / "launched-once"
    MODE = "keepalive" if marker.exists() else "stall"
    marker.touch()


class ProbeDelegate(NSObject):
    def applicationDidFinishLaunching_(self, _notification):
        # No windows, network, dashboard, or saved user preferences in this probe.
        print(f"AppKit probe ready: {os.getpid()}", flush=True)
        self.timer = NSTimer.scheduledTimerWithTimeInterval_target_selector_userInfo_repeats_(
            0.2, self, "exercise:", None, False)

    def exercise_(self, _timer):
        if MODE == "keepalive":
            return
        elif MODE in ("stall", "baseline"):
            time.sleep(30)  # Block the actual main thread, leaving the app alive.
        elif MODE == "tracking":
            until = time.monotonic() + 2
            while time.monotonic() < until:
                NSRunLoop.mainRunLoop().runMode_beforeDate_(
                    NSEventTrackingRunLoopMode,
                    NSDate.dateWithTimeIntervalSinceNow_(0.05))
        else:
            NSRunLoop.mainRunLoop().runUntilDate_(
                NSDate.dateWithTimeIntervalSinceNow_(2))
        NSApplication.sharedApplication().terminate_(None)


class NoWatchdog:
    """Reproduce the previous lifecycle: a live-but-hung app never exits."""
    def pulse(self):
        pass

    def close(self):
        pass


menubar.AppDelegate = ProbeDelegate
menubar.HangWatchdog = (NoWatchdog if MODE == "baseline" else
                       lambda: HangWatchdog(timeout=0.8, startup_timeout=15,
                                            diagnostic_dir=Path(DIAGNOSTICS)))
menubar.start_main_thread_heartbeat = lambda watchdog: start_main_thread_heartbeat(
    watchdog, interval=0.05)
menubar.main()
