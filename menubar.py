"""macOS menu-bar app for Claude/Codex usage.

Shows one dial per platform on the status bar (see render_menubar_image): the
arc fills with what's used plus the forecast to the reset, the needle is the
burn rate, and the text is the time until the reset (Verbose adds every
number). Clicking it drops the full live dashboard as a popover — a WKWebView
pointed at the local server (http://127.0.0.1:PORT), so charts/forecasts/
WebSocket updates all work as-is. A slim header row inside the popover has
Reload / Open in browser / Zen / Widget / Verbose / ? / Quit.

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
    NSFontAttributeName, NSForegroundColorAttributeName, NSBezelStyleHelpButton,
)
from Foundation import (
    NSObject, NSURL, NSURLRequest, NSAttributedString, NSUserDefaults,
    NSProcessInfo, NSActivityUserInitiatedAllowingIdleSystemSleep,
)
from WebKit import WKWebView, WKWebViewConfiguration

from menubar_fmt import dials_for
from menubar_watchdog import HangWatchdog, start_main_thread_heartbeat
from widget_panel import WidgetPanel

PORT = int(os.environ.get("CLAUDE_USAGE_PORT", "44405"))
BASE = f"http://127.0.0.1:{PORT}"
REFRESH_SEC = 30
POPW, POPH, HEADER_H = 960, 680, 36
HELPW, HELPH = 380, 400  # the ? popover that explains the dial
REV_DUR = 0.9          # menu-bar gauge ignition sweep (seconds)
ANIM_STEP = 0.03       # animation frame interval
RISE_EPS = 0.03        # min needle increase (of full dial) to trigger a rev
GAUGES = ("claude", "codex")

# Brand accents, matching the dashboard: Claude is always orange, Codex always blue.
CLAUDE_COLOR = NSColor.colorWithSRGBRed_green_blue_alpha_(0.961, 0.620, 0.043, 1.0)
CODEX_COLOR = NSColor.colorWithSRGBRed_green_blue_alpha_(0.388, 0.400, 0.945, 1.0)


def _arc(px, py, r, p0, p1, width, color):
    """Stroke the part of the top semicircle from p0% to p1% (0 = left end)."""
    if p1 - p0 < 0.5:
        return
    path = NSBezierPath.bezierPath()
    path.appendBezierPathWithArcWithCenter_radius_startAngle_endAngle_clockwise_(
        NSMakePoint(px, py), r, 180.0 * (1 - p0 / 100), 180.0 * (1 - p1 / 100), True)
    path.setLineWidth_(width)
    color.set()
    path.stroke()


def _draw_dial(px, py, r, d, frac, color, zen):
    """One platform's dial, AppKit y-up, pivot at (px, py). The arc is the
    window: solid = used, faint = the forecast still to come before the reset
    (red when it runs out first), empty = left at the reset. The needle is the
    burn rate on the gauge's dial (frac 0..1, red when pegged)."""
    sw = max(1.8, r * 0.3)
    ink = NSColor.labelColor()
    warn = ink if zen else NSColor.systemRedColor()
    used = ink if zen else color
    _arc(px, py, r, 0, 100, sw, ink.colorWithAlphaComponent_(0.16))
    _arc(px, py, r, d["pct"], d["at_reset"], sw,
         # Zen can't use red, so overrunning there is only a darker faint arc.
         (warn.colorWithAlphaComponent_(0.5 if zen else 0.75) if d["over"]
          else used.colorWithAlphaComponent_(0.35)))
    _arc(px, py, r, 0, d["pct"], sw, used)

    f = max(0.0, min(1.0, frac or 0.0))
    a = math.radians(180.0 * (1 - f))
    nl = r - sw - 0.8
    ncol = warn if f >= 1.0 else ink
    needle = NSBezierPath.bezierPath()
    needle.moveToPoint_(NSMakePoint(px, py))
    needle.lineToPoint_(NSMakePoint(px + nl * math.cos(a), py + nl * math.sin(a)))
    needle.setLineWidth_(1.4)
    needle.setLineCapStyle_(1)
    ncol.set()
    needle.stroke()
    NSBezierPath.bezierPathWithOvalInRect_(NSMakeRect(px - 1.4, py - 1.4, 2.8, 2.8)).fill()


def render_menubar_image(dials, height, zen=False, verbose=False):
    """Build the status-item image (`height` = menu-bar thickness): the
    platforms side by side, each a dial plus its text. Clean mode shows the
    time until the reset; verbose shows "53% · 34h" over "0.3/h · 37% left".
    `dials` are menubar_fmt.dial_for dicts whose "frac" is the drawn (animated)
    needle. `zen` drops the backdrop + colors (monochrome template). None when
    nothing to show."""
    if not dials:
        return None
    DIAL_W, R = 20.0, 8.0
    GAP, CELL_GAP, LPAD, RPAD = 3.0, 9.0, 4.0, 5.0
    ink = NSColor.labelColor()

    def astr(text, size, weight, color):
        font = NSFont.monospacedDigitSystemFontOfSize_weight_(size, weight)
        return NSAttributedString.alloc().initWithString_attributes_(
            text, {NSFontAttributeName: font, NSForegroundColorAttributeName: color})

    cells = []
    for d in dials:
        if verbose:
            low = (NSColor.systemRedColor() if d["over"] and not zen else NSColor.secondaryLabelColor())
            texts = [astr(d["top"], 10.0, 0.3, ink), astr(d["bottom"], 8.5, 0.0, low)]
        else:
            texts = [astr(d["clean"], 12.0, 0.23, ink)]
        cells.append((d, texts, max(t.size().width for t in texts)))
    width = math.ceil(LPAD + sum(DIAL_W + GAP + w for _, _, w in cells)
                      + CELL_GAP * (len(cells) - 1) + RPAD)

    img = NSImage.alloc().initWithSize_(NSMakeSize(width, height))
    img.lockFocus()
    if not zen:
        # Subtle rounded backdrop so the content stays legible on any wallpaper.
        # textBackgroundColor is appearance-adaptive (near-white in light,
        # near-black in dark), so a low-opacity fill lifts contrast either way.
        NSColor.textBackgroundColor().colorWithAlphaComponent_(0.4).set()
        NSBezierPath.bezierPathWithRoundedRect_xRadius_yRadius_(
            NSMakeRect(0.0, 0.0, width, height), 5.0, 5.0).fill()
    x = LPAD
    for d, texts, tw in cells:
        color = CLAUDE_COLOR if d["kind"] == "claude" else CODEX_COLOR
        # Pivot low so the arc (radius R) sits centred in the bar.
        _draw_dial(x + DIAL_W / 2, height / 2 - R / 2, R, d, d["frac"], color, zen)
        tx = x + DIAL_W + GAP
        total = sum(t.size().height for t in texts) - (2.0 if len(texts) > 1 else 0.0)
        y = (height + total) / 2
        for t in texts:
            y -= t.size().height - (1.0 if len(texts) > 1 else 0.0)
            t.drawAtPoint_(NSMakePoint(tx, y))
        x = tx + tw + CELL_GAP
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
        self._widget_on = self._defaults.boolForKey_("widgetShown")
        self._verbose = self._defaults.boolForKey_("verboseMode")   # default: clean
        self.widget = WidgetPanel.alloc().initWithDefaults_(self._defaults)
        self.statusItem = bar.statusItemWithLength_(NSVariableStatusItemLength)
        btn = self.statusItem.button()
        btn.setTitle_("…")
        btn.setTarget_(self)
        btn.setAction_("togglePopover:")
        # gauge animation state: displayed needle vs polled target, per gauge
        self._dials = []                                   # menubar_fmt.dial_for dicts, last poll
        self._new_frac = {}                                # fresh fracs from the bg fetch
        self._target = {k: None for k in GAUGES}           # last polled needle position
        self._disp = {k: 0.0 for k in GAUGES}              # currently drawn needle position
        self._rev = {k: None for k in GAUGES}              # rev start time, or None
        self._anim_timer = None

        # --- popover content: header row above a webview ---
        container = NSView.alloc().initWithFrame_(NSMakeRect(0, 0, POPW, POPH))

        conf = WKWebViewConfiguration.alloc().init()
        # A closed popover hides the page, and WebKit then suspends its process:
        # waking it took seconds on the next open. Keep it awake; the page itself
        # does no work while hidden (see tick() in app.js), so this costs nothing.
        prefs = conf.preferences()
        if prefs.respondsToSelector_("_setPageVisibilityBasedProcessSuppressionEnabled:"):
            prefs._setPageVisibilityBasedProcessSuppressionEnabled_(False)
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
        # Centre group: the display toggles, then ? (how to read the dials).
        group = []
        for title, action, on in (("Zen", "toggleZen:", self._zen),
                                  ("Widget", "toggleWidget:", self._widget_on),
                                  ("Verbose", "toggleVerbose:", self._verbose)):
            c = NSButton.checkboxWithTitle_target_action_(title, self, action)
            c.setFont_(NSFont.systemFontOfSize_(12))
            c.setState_(1 if on else 0)
            c.sizeToFit()
            group.append(c)
        self.helpBtn = NSButton.alloc().initWithFrame_(NSMakeRect(0, 0, 21, 21))
        self.helpBtn.setBezelStyle_(NSBezelStyleHelpButton)
        self.helpBtn.setTitle_("")
        self.helpBtn.setToolTip_("How to read the menu-bar dials")
        self.helpBtn.setTarget_(self)
        self.helpBtn.setAction_("showHelp:")
        group.append(self.helpBtn)
        SPACE = 16
        x = (POPW - sum(c.frame().size.width for c in group) - SPACE * (len(group) - 1)) / 2
        for c in group:
            sz = c.frame().size
            c.setFrameOrigin_(NSMakePoint(x, (HEADER_H - sz.height) / 2))
            header.addSubview_(c)
            x += sz.width + SPACE
        mkbtn("Quit", POPW - 70, 62, "quit:")
        container.addSubview_(header)

        vc = NSViewController.alloc().init()
        vc.setView_(container)

        # The ? popover: a small page that explains the dial.
        hvc = NSViewController.alloc().init()
        self.helpWeb = WKWebView.alloc().initWithFrame_configuration_(
            NSMakeRect(0, 0, HELPW, HELPH), WKWebViewConfiguration.alloc().init())
        hvc.setView_(self.helpWeb)
        self.helpPop = NSPopover.alloc().init()
        self.helpPop.setContentSize_((HELPW, HELPH))
        self.helpPop.setBehavior_(NSPopoverBehaviorTransient)
        self.helpPop.setContentViewController_(hvc)

        self.popover = NSPopover.alloc().init()
        self.popover.setContentSize_((POPW, POPH))
        self.popover.setBehavior_(NSPopoverBehaviorTransient)
        self.popover.setContentViewController_(vc)
        self._loadDashboard()

        if self._widget_on:
            self.widget.show()               # reopen where it was last left

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
                # The webview stays loaded between opens but is paused while
                # closed: catch it up to the latest data straight away.
                self.web.evaluateJavaScript_completionHandler_(
                    "window.showLatest && window.showLatest()", None)

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

    def toggleWidget_(self, sender):
        self._widget_on = sender.state() != 0
        self._defaults.setBool_forKey_(self._widget_on, "widgetShown")
        self._defaults.synchronize()
        self.widget.show() if self._widget_on else self.widget.hide()

    def toggleVerbose_(self, sender):
        self._verbose = sender.state() != 0
        self._defaults.setBool_forKey_(self._verbose, "verboseMode")
        self._defaults.synchronize()
        self._redraw()

    def showHelp_(self, sender):
        if self.helpPop.isShown():
            self.helpPop.performClose_(None)
            return
        self.helpWeb.loadRequest_(NSURLRequest.requestWithURL_(
            NSURL.URLWithString_(f"{BASE}/menubar-help")))
        self.helpPop.showRelativeToRect_ofView_preferredEdge_(sender.bounds(), sender, NSMinYEdge)

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
                self._dials = dials_for(d.get("outlook"))
            except Exception:
                self._new_frac, self._dials = {}, []
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
        dials = [{**d, "frac": self._disp.get(d["kind"], 0.0)} for d in self._dials]
        img = render_menubar_image(dials, self._bar_h, self._zen, self._verbose)
        if img is None:
            btn.setImage_(None)
            btn.setTitle_("—")
        else:
            btn.setTitle_("")
            btn.setImage_(img)
            btn.setImagePosition_(NSImageOnly)


def main():
    watchdog = HangWatchdog()
    timer, activity = None, None
    try:
        app = NSApplication.sharedApplication()
        app.setActivationPolicy_(NSApplicationActivationPolicyAccessory)  # no Dock icon
        # App Nap must not suppress the liveness timer for this live readout.
        # This activity explicitly allows the Mac to idle-sleep as usual.
        activity = NSProcessInfo.processInfo().beginActivityWithOptions_reason_(
            NSActivityUserInitiatedAllowingIdleSystemSleep,
            "Keep the live usage menu bar responsive")
        timer = start_main_thread_heartbeat(watchdog)
        delegate = AppDelegate.alloc().init()
        app.setDelegate_(delegate)
        app.run()
    finally:
        if timer is not None:
            timer.invalidate()
        if activity is not None:
            NSProcessInfo.processInfo().endActivity_(activity)
        watchdog.close()


if __name__ == "__main__":
    main()
