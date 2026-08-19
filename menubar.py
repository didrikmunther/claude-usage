"""macOS menu-bar app for Claude/Codex usage.

Shows `x%Xh` (5-hour % + hours to reset) on the status bar. Clicking it drops
the full live dashboard as a popover — a WKWebView pointed at the local server
(http://127.0.0.1:PORT), so charts/forecasts/WebSocket updates all work as-is.
A slim header row inside the popover has Reload / Open in browser / Quit.

Raw PyObjC (not rumps) because we need a custom view (webview) in the popover.
"""
import json
import os
import threading
import urllib.request

from AppKit import (
    NSApplication, NSApplicationActivationPolicyAccessory, NSStatusBar,
    NSVariableStatusItemLength, NSPopover, NSPopoverBehaviorTransient,
    NSViewController, NSView, NSButton, NSBezelStyleRounded, NSFont,
    NSMakeRect, NSApp, NSWorkspace, NSTimer, NSMinYEdge,
)
from Foundation import NSObject, NSURL, NSURLRequest
from WebKit import WKWebView, WKWebViewConfiguration

from menubar_fmt import title_for

PORT = int(os.environ.get("CLAUDE_USAGE_PORT", "8787"))
BASE = f"http://127.0.0.1:{PORT}"
REFRESH_SEC = 30
POPW, POPH, HEADER_H = 960, 680, 36


class AppDelegate(NSObject):
    def applicationDidFinishLaunching_(self, _notification):
        # --- status item + title ---
        self.statusItem = NSStatusBar.systemStatusBar().statusItemWithLength_(
            NSVariableStatusItemLength)
        btn = self.statusItem.button()
        btn.setTitle_("…")
        btn.setTarget_(self)
        btn.setAction_("togglePopover:")

        # --- popover content: header row above a webview ---
        container = NSView.alloc().initWithFrame_(NSMakeRect(0, 0, POPW, POPH))

        conf = WKWebViewConfiguration.alloc().init()
        self.web = WKWebView.alloc().initWithFrame_configuration_(
            NSMakeRect(0, 0, POPW, POPH - HEADER_H), conf)
        container.addSubview_(self.web)

        header = NSView.alloc().initWithFrame_(
            NSMakeRect(0, POPH - HEADER_H, POPW, HEADER_H))

        def mkbtn(title, x, w, action):
            b = NSButton.alloc().initWithFrame_(NSMakeRect(x, 4, w, HEADER_H - 8))
            b.setTitle_(title)
            b.setBezelStyle_(NSBezelStyleRounded)
            b.setFont_(NSFont.systemFontOfSize_(12))
            b.setTarget_(self)
            b.setAction_(action)
            header.addSubview_(b)
            return b

        mkbtn("↻ Reload", 8, 92, "reload:")
        mkbtn("Open in browser", 104, 150, "openBrowser:")
        mkbtn("Quit", POPW - 70, 62, "quit:")
        container.addSubview_(header)

        vc = NSViewController.alloc().init()
        vc.setView_(container)

        self.popover = NSPopover.alloc().init()
        self.popover.setContentSize_((POPW, POPH))
        self.popover.setBehavior_(NSPopoverBehaviorTransient)
        self.popover.setContentViewController_(vc)
        self.web.loadRequest_(
            NSURLRequest.requestWithURL_(NSURL.URLWithString_(f"{BASE}/?widget=1")))

        # --- title refresh loop ---
        self.refresh_(None)
        self.timer = NSTimer.scheduledTimerWithTimeInterval_target_selector_userInfo_repeats_(
            REFRESH_SEC, self, "refresh:", None, True)

    # --- actions ---
    def togglePopover_(self, _sender):
        if self.popover.isShown():
            self.popover.performClose_(None)
        else:
            btn = self.statusItem.button()
            self.popover.showRelativeToRect_ofView_preferredEdge_(
                btn.bounds(), btn, NSMinYEdge)
            NSApp.activateIgnoringOtherApps_(True)

    def reload_(self, _sender):
        self.web.reloadFromOrigin_(None)

    def openBrowser_(self, _sender):
        NSWorkspace.sharedWorkspace().openURL_(NSURL.URLWithString_(BASE))

    def quit_(self, _sender):
        NSApp.terminate_(None)

    # --- title updating (fetch off the main thread, set on it) ---
    def refresh_(self, _timer):
        def work():
            try:
                with urllib.request.urlopen(f"{BASE}/api/latest", timeout=5) as r:
                    title = title_for(json.load(r).get("latest"))
            except Exception:
                title = "…"
            self.performSelectorOnMainThread_withObject_waitUntilDone_(
                "setTitle:", title, False)
        threading.Thread(target=work, daemon=True).start()

    def setTitle_(self, title):
        self.statusItem.button().setTitle_(title)


def main():
    app = NSApplication.sharedApplication()
    app.setActivationPolicy_(NSApplicationActivationPolicyAccessory)  # no Dock icon
    delegate = AppDelegate.alloc().init()
    app.setDelegate_(delegate)
    app.run()


if __name__ == "__main__":
    main()
