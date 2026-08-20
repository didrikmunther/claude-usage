"""macOS menu-bar app for Claude/Codex usage.

Shows `x%Xh` (5-hour % + hours to reset) on the status bar. Clicking it drops
the full live dashboard as a popover — a WKWebView pointed at the local server
(http://127.0.0.1:PORT), so charts/forecasts/WebSocket updates all work as-is.
A slim header row inside the popover has Reload / Open in browser / Quit.

Raw PyObjC (not rumps) because we need a custom view (webview) in the popover.
"""
import json
import math
import os
import threading
import urllib.request

from AppKit import (
    NSApplication, NSApplicationActivationPolicyAccessory, NSStatusBar,
    NSVariableStatusItemLength, NSPopover, NSPopoverBehaviorTransient,
    NSViewController, NSView, NSButton, NSBezelStyleRounded, NSFont,
    NSMakeRect, NSMakePoint, NSMakeSize, NSApp, NSWorkspace, NSTimer,
    NSMinYEdge, NSImage, NSImageOnly, NSColor, NSBezierPath,
    NSFontAttributeName, NSForegroundColorAttributeName,
)
from Foundation import NSObject, NSURL, NSURLRequest, NSAttributedString
from WebKit import WKWebView, WKWebViewConfiguration

from menubar_fmt import lines_for

PORT = int(os.environ.get("CLAUDE_USAGE_PORT", "8787"))
BASE = f"http://127.0.0.1:{PORT}"
REFRESH_SEC = 30
POPW, POPH, HEADER_H = 960, 680, 36

# Brand-ish accents, matching the dashboard (Claude indigo, Codex amber).
CLAUDE_COLOR = NSColor.colorWithSRGBRed_green_blue_alpha_(0.388, 0.400, 0.945, 1.0)
CODEX_COLOR = NSColor.colorWithSRGBRed_green_blue_alpha_(0.961, 0.620, 0.043, 1.0)


def _draw_sunburst(cx, cy, r, color):
    """Claude: a small radiating sunburst (Anthropic-ish asterisk)."""
    color.set()
    p = NSBezierPath.bezierPath()
    n = 10
    for i in range(n):
        a = 2 * math.pi * i / n
        p.moveToPoint_(NSMakePoint(cx, cy))
        p.lineToPoint_(NSMakePoint(cx + math.cos(a) * r, cy + math.sin(a) * r))
    p.setLineWidth_(max(1.0, r * 0.24))
    p.setLineCapStyle_(1)          # round
    p.stroke()


def _draw_hexagon(cx, cy, r, color):
    """Codex: a hexagon outline — a distinct silhouette from the sunburst."""
    color.set()
    p = NSBezierPath.bezierPath()
    for i in range(6):
        a = math.pi / 2 + 2 * math.pi * i / 6      # flat-ish, point up
        pt = NSMakePoint(cx + math.cos(a) * r, cy + math.sin(a) * r)
        p.moveToPoint_(pt) if i == 0 else p.lineToPoint_(pt)
    p.closePath()
    p.setLineWidth_(max(1.0, r * 0.30))
    p.setLineJoinStyle_(1)         # round
    p.stroke()


def render_menubar_image(lines):
    """Build the status-item image: one row per source (icon + text). One line
    when a single source has data, two stacked smaller lines when both do.
    Returns None when there's nothing to show."""
    if not lines:
        return None
    two = len(lines) >= 2
    font = NSFont.monospacedDigitSystemFontOfSize_weight_(9.5 if two else 12.5, 0.0)
    text_color = NSColor.labelColor()
    ICON = 9.0 if two else 12.0
    GAP, LPAD, RPAD, HEIGHT = 3.0, 2.0, 2.0, 22.0
    row_h = HEIGHT / 2 if two else HEIGHT

    attrs = {NSFontAttributeName: font, NSForegroundColorAttributeName: text_color}
    strs = [NSAttributedString.alloc().initWithString_attributes_(t, attrs) for _, t in lines]
    text_w = max((s.size().width for s in strs), default=0.0)
    width = math.ceil(LPAD + ICON + GAP + text_w + RPAD)

    img = NSImage.alloc().initWithSize_(NSMakeSize(width, HEIGHT))
    img.lockFocus()
    for i, ((kind, _text), s) in enumerate(zip(lines, strs)):
        row_y = HEIGHT - row_h * (i + 1)           # first line on top
        r = ICON / 2
        cx = LPAD + r
        cy = row_y + row_h / 2
        (_draw_sunburst if kind == "claude" else _draw_hexagon)(
            cx, cy, r, CLAUDE_COLOR if kind == "claude" else CODEX_COLOR)
        ts = s.size()
        s.drawAtPoint_(NSMakePoint(LPAD + ICON + GAP, row_y + (row_h - ts.height) / 2))
    img.unlockFocus()
    img.setTemplate_(False)                        # keep our colors (not menu-bar tint)
    return img


class AppDelegate(NSObject):
    def applicationDidFinishLaunching_(self, _notification):
        # --- status item + title ---
        self.statusItem = NSStatusBar.systemStatusBar().statusItemWithLength_(
            NSVariableStatusItemLength)
        btn = self.statusItem.button()
        btn.setTitle_("…")
        btn.setTarget_(self)
        btn.setAction_("togglePopover:")
        self._lines = []

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

    # --- title updating (fetch off the main thread, draw on it) ---
    def refresh_(self, _timer):
        def work():
            try:
                with urllib.request.urlopen(f"{BASE}/api/latest", timeout=5) as r:
                    d = json.load(r)
                self._lines = lines_for(d.get("latest"), d.get("codex"))
            except Exception:
                self._lines = []
            self.performSelectorOnMainThread_withObject_waitUntilDone_(
                "renderLines:", None, False)
        threading.Thread(target=work, daemon=True).start()

    def renderLines_(self, _):
        btn = self.statusItem.button()
        img = render_menubar_image(self._lines)
        if img is None:
            btn.setImage_(None)
            btn.setTitle_("—")
        else:
            btn.setTitle_("")
            btn.setImage_(img)
            btn.setImagePosition_(NSImageOnly)


def main():
    app = NSApplication.sharedApplication()
    app.setActivationPolicy_(NSApplicationActivationPolicyAccessory)  # no Dock icon
    delegate = AppDelegate.alloc().init()
    app.setDelegate_(delegate)
    app.run()


if __name__ == "__main__":
    main()
