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
import time
import urllib.request

from AppKit import (
    NSApplication, NSApplicationActivationPolicyAccessory, NSStatusBar,
    NSVariableStatusItemLength, NSPopover, NSPopoverBehaviorTransient,
    NSViewController, NSView, NSButton, NSBezelStyleRounded, NSFont,
    NSMakeRect, NSMakePoint, NSMakeSize, NSApp, NSWorkspace, NSTimer,
    NSMinYEdge, NSImage, NSImageOnly, NSColor, NSBezierPath,
    NSFontAttributeName, NSForegroundColorAttributeName,
)
from Foundation import NSObject, NSURL, NSURLRequest, NSAttributedString, NSUserDefaults
from WebKit import WKWebView, WKWebViewConfiguration

from menubar_fmt import lines_for

PORT = int(os.environ.get("CLAUDE_USAGE_PORT", "8787"))
BASE = f"http://127.0.0.1:{PORT}"
REFRESH_SEC = 30
POPW, POPH, HEADER_H = 960, 680, 36
REV_DUR = 0.9          # menu-bar gauge ignition sweep (seconds)
ANIM_STEP = 0.03       # animation frame interval
RISE_EPS = 0.03        # min needle increase (of full dial) to trigger a rev
GAUGES = ("claude", "codex")

# Brand-ish accents, matching the dashboard (Claude indigo, Codex amber).
CLAUDE_COLOR = NSColor.colorWithSRGBRed_green_blue_alpha_(0.388, 0.400, 0.945, 1.0)
CODEX_COLOR = NSColor.colorWithSRGBRed_green_blue_alpha_(0.961, 0.620, 0.043, 1.0)


def _draw_gauge(cx, cy, box_r, frac, color):
    """Mini speedometer: a faint platform-colored arc with a needle whose angle
    encodes the dial fraction (0 → left/idle, 1 → right/redline). AppKit is y-up."""
    px, py = cx, cy - box_r * 0.5          # pivot low in the box; arc rises above
    ra = box_r
    f = max(0.0, min(1.0, frac or 0.0))
    deg = 180.0 * (1 - f)                  # 0→180° (left), 1→0° (right)

    arc = NSBezierPath.bezierPath()
    arc.appendBezierPathWithArcWithCenter_radius_startAngle_endAngle_(
        NSMakePoint(px, py), ra, 0.0, 180.0)     # top semicircle (CCW 0→180)
    color.colorWithAlphaComponent_(0.4).set()
    arc.setLineWidth_(max(0.8, box_r * 0.22))
    arc.stroke()

    a = math.radians(deg)
    needle = NSBezierPath.bezierPath()
    needle.moveToPoint_(NSMakePoint(px, py))
    needle.lineToPoint_(NSMakePoint(px + ra * 0.9 * math.cos(a), py + ra * 0.9 * math.sin(a)))
    color.set()
    needle.setLineWidth_(max(1.0, box_r * 0.28))
    needle.setLineCapStyle_(1)
    needle.stroke()


def render_menubar_image(lines, height, zen=False):
    """Build the status-item image (`height` = menu-bar thickness): one row per
    source (mini burn-rate gauge + text). One line when a single source has data,
    two stacked smaller lines when both do. `lines` are (kind, text, frac).
    `zen` drops the backdrop + colors (monochrome template). None when nothing."""
    if not lines:
        return None
    two = len(lines) >= 2
    VPAD = 2.5                                  # padding inside the box (top/bottom)
    GAP, LPAD, RPAD = 3.0, 4.0, 5.0
    inner_h = height - 2 * VPAD
    row_h = inner_h / 2 if two else inner_h
    font = NSFont.monospacedDigitSystemFontOfSize_weight_(min(9.5 if two else 12.5, row_h * 0.95), 0.0)
    text_color = NSColor.labelColor()
    ICON = min(11.0 if two else 14.0, row_h * 0.92)

    attrs = {NSFontAttributeName: font, NSForegroundColorAttributeName: text_color}
    strs = [NSAttributedString.alloc().initWithString_attributes_(t, attrs) for _, t, _ in lines]
    text_w = max((s.size().width for s in strs), default=0.0)
    width = math.ceil(LPAD + ICON + GAP + text_w + RPAD)

    img = NSImage.alloc().initWithSize_(NSMakeSize(width, height))
    img.lockFocus()
    if not zen:
        # Subtle rounded backdrop so the content stays legible on any wallpaper.
        # textBackgroundColor is appearance-adaptive (near-white in light,
        # near-black in dark), so a low-opacity fill lifts contrast either way.
        NSColor.textBackgroundColor().colorWithAlphaComponent_(0.4).set()
        NSBezierPath.bezierPathWithRoundedRect_xRadius_yRadius_(
            NSMakeRect(0.0, 0.0, width, height), 5.0, 5.0).fill()
    for i, ((kind, _text, frac), s) in enumerate(zip(lines, strs)):
        row_y = (height - VPAD) - row_h * (i + 1)  # inset from the box top/bottom
        cx = LPAD + ICON / 2
        cy = row_y + row_h / 2
        _draw_gauge(cx, cy, ICON / 2, frac, CLAUDE_COLOR if kind == "claude" else CODEX_COLOR)
        ts = s.size()
        s.drawAtPoint_(NSMakePoint(LPAD + ICON + GAP, row_y + (row_h - ts.height) / 2))
    img.unlockFocus()
    # Zen mode: render as a template so the menu bar tints it one monochrome color
    # (drops our brand colors); otherwise keep our colors.
    img.setTemplate_(zen)
    return img


class AppDelegate(NSObject):
    def applicationDidFinishLaunching_(self, _notification):
        # --- status item + title ---
        bar = NSStatusBar.systemStatusBar()
        self._bar_h = bar.thickness()          # full menu-bar height, for internal padding
        # Dedicated suite (own plist, not the shared org.python.python domain).
        self._defaults = NSUserDefaults.alloc().initWithSuiteName_("com.claude-usage")
        self._zen = self._defaults.boolForKey_("zenMode")
        self.statusItem = bar.statusItemWithLength_(NSVariableStatusItemLength)
        btn = self.statusItem.button()
        btn.setTitle_("…")
        btn.setTarget_(self)
        btn.setAction_("togglePopover:")
        # gauge animation state: displayed needle vs polled target, per gauge
        self._rows = []                                    # [(kind, text)] from the last poll
        self._new_frac = {}                                # fresh fracs from the bg fetch
        self._target = {k: None for k in GAUGES}           # last polled needle position
        self._disp = {k: 0.0 for k in GAUGES}              # currently drawn needle position
        self._rev = {k: None for k in GAUGES}              # rev start time, or None
        self._anim_timer = None

        # --- popover content: header row above a webview ---
        container = NSView.alloc().initWithFrame_(NSMakeRect(0, 0, POPW, POPH))

        conf = WKWebViewConfiguration.alloc().init()
        self.web = WKWebView.alloc().initWithFrame_configuration_(
            NSMakeRect(0, 0, POPW, POPH - HEADER_H), conf)
        self.web.setNavigationDelegate_(self)      # retry if the server isn't up yet
        self._loaded = False
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
        zen = NSButton.checkboxWithTitle_target_action_("Zen", self, "toggleZen:")
        zen.setFont_(NSFont.systemFontOfSize_(12))
        zen.sizeToFit()
        zsz = zen.frame().size
        zen.setFrameOrigin_(NSMakePoint((POPW - zsz.width) / 2, (HEADER_H - zsz.height) / 2))
        zen.setState_(1 if self._zen else 0)
        header.addSubview_(zen)
        mkbtn("Quit", POPW - 70, 62, "quit:")
        container.addSubview_(header)

        vc = NSViewController.alloc().init()
        vc.setView_(container)

        self.popover = NSPopover.alloc().init()
        self.popover.setContentSize_((POPW, POPH))
        self.popover.setBehavior_(NSPopoverBehaviorTransient)
        self.popover.setContentViewController_(vc)
        self._loadDashboard()

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
            if not self._loaded:                   # never loaded (server was down at launch)? load now
                self._loadDashboard()
            else:
                # Rev the gauges on every open (the webview stays loaded between opens).
                self.web.evaluateJavaScript_completionHandler_(
                    "window.revGauges && window.revGauges()", None)

    # --- webview loading (retry until the server is reachable) ---
    def _loadDashboard(self):
        self.web.loadRequest_(
            NSURLRequest.requestWithURL_(NSURL.URLWithString_(f"{BASE}/?widget=1")))

    def webView_didFinishNavigation_(self, web, nav):
        self._loaded = True

    def webView_didFailProvisionalNavigation_withError_(self, web, nav, err):
        self._retryLoad()                          # server likely not listening yet

    def webView_didFailNavigation_withError_(self, web, nav, err):
        self._retryLoad()

    def _retryLoad(self):
        self._loaded = False
        NSTimer.scheduledTimerWithTimeInterval_target_selector_userInfo_repeats_(
            2.0, self, "reloadWeb:", None, False)

    def reloadWeb_(self, _timer):
        if not self._loaded:
            self._loadDashboard()

    def reload_(self, _sender):
        self.web.reloadFromOrigin_(None)

    def openBrowser_(self, _sender):
        NSWorkspace.sharedWorkspace().openURL_(NSURL.URLWithString_(BASE))

    def quit_(self, _sender):
        NSApp.terminate_(None)

    def toggleZen_(self, sender):
        self._zen = sender.state() != 0
        self._defaults.setBool_forKey_(self._zen, "zenMode")
        self._defaults.synchronize()               # flush now — survives a hard restart
        self._redraw()

    # --- polling (fetch off the main thread) → diff + draw on it ---
    def refresh_(self, _timer):
        def work():
            try:
                with urllib.request.urlopen(f"{BASE}/api/latest", timeout=5) as r:
                    d = json.load(r)
                self._new_frac = {"claude": d.get("claude_frac") or 0.0,
                                  "codex": d.get("codex_frac") or 0.0}
                self._rows = list(lines_for(d.get("latest"), d.get("codex")))
            except Exception:
                self._new_frac, self._rows = {}, []
            self.performSelectorOnMainThread_withObject_waitUntilDone_(
                "applyPoll:", None, False)
        threading.Thread(target=work, daemon=True).start()

    def applyPoll_(self, _):
        """Adopt the new fracs; rev any gauge whose needle rose since last poll."""
        now = time.time()
        for k in GAUGES:
            nt = float(self._new_frac.get(k, 0.0))
            prev = self._target[k]
            self._target[k] = nt
            if prev is not None and nt > prev + RISE_EPS:
                self._rev[k] = now                         # rising → ignition sweep
            elif self._rev[k] is None:
                self._disp[k] = nt                         # not reving → settle now
        if any(self._rev[k] is not None for k in GAUGES):
            if self._anim_timer is None:
                self._anim_timer = NSTimer.scheduledTimerWithTimeInterval_target_selector_userInfo_repeats_(
                    ANIM_STEP, self, "animTick:", None, True)
        self._redraw()

    def animTick_(self, _timer):
        now, reving = time.time(), False
        for k in GAUGES:
            t0 = self._rev[k]
            tgt = self._target[k] or 0.0
            if t0 is None:
                self._disp[k] = tgt
                continue
            t = (now - t0) / REV_DUR
            if t >= 1.0:
                self._rev[k] = None
                self._disp[k] = tgt
            else:
                reving = True
                if t < 0.5:
                    x = t / 0.5
                    self._disp[k] = 1.0 - (1.0 - x) ** 2                # 0 → 1 (redline)
                else:
                    x = (t - 0.5) / 0.5
                    self._disp[k] = 1.0 + (tgt - 1.0) * (1.0 - (1.0 - x) ** 2)  # 1 → target
        self._redraw()
        if not reving and self._anim_timer is not None:
            self._anim_timer.invalidate()
            self._anim_timer = None

    def _redraw(self):
        btn = self.statusItem.button()
        img = render_menubar_image([(k, t, self._disp.get(k, 0.0)) for (k, t) in self._rows], self._bar_h, self._zen)
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
