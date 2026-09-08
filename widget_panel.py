"""Always-on-top floating pill: one signed margin per platform, over everything.

A borderless non-activating NSPanel hosting a WKWebView pointed at /widget. The
margin arithmetic comes from the same JavaScript the dashboard uses instead of a
second implementation that would drift (see static/forecast.js).

Shaped after reflect-mono's quick-pill: a 46pt fully-rounded dark bar, sized to
its content rather than to a fixed width.

Two details are load-bearing:

* Non-activating panel + `NSStatusWindowLevel`. Clicking the widget must never
  pull focus out of whatever you are typing in, and the panel has to sit above
  ordinary windows. It joins all Spaces and rides along beside full-screen apps;
  a genuinely full-screen app on its own Space can still cover it — macOS gives
  no way around that.
* A native drag overlay covering the WHOLE webview. WKWebView answers NO to
  `mouseDownCanMoveWindow`, so `movableByWindowBackground` alone does nothing
  and the panel could not be moved at all. Overriding that on WKWebView itself
  does not help either — hit-testing lands on its internal content view, not the
  outer one. A transparent sibling laid over the top catches the mouseDown and
  calls `performWindowDragWithEvent:`, making every pixel a drag handle. Note
  that `movableByWindowBackground` is NOT the mechanism: it never fires on a
  clearColor window, which is exactly what a translucent widget needs to be.
  Safe here precisely because the widget is a read-only readout: there is
  nothing inside it to click. The cost is that the `title` tooltips on
  truncated rows no longer appear.
"""
import os
import sys

from AppKit import (
    NSPanel, NSView, NSColor, NSBezierPath, NSScreen, NSMakeRect, NSMakePoint,
    NSBackingStoreBuffered, NSStatusWindowLevel,
    NSWindowStyleMaskBorderless, NSWindowStyleMaskNonactivatingPanel,
    NSWindowCollectionBehaviorCanJoinAllSpaces,
    NSWindowCollectionBehaviorFullScreenAuxiliary,
    NSWindowCollectionBehaviorStationary,
    NSTrackingArea, NSTrackingMouseEnteredAndExited, NSTrackingActiveAlways,
    NSTrackingInVisibleRect,
)
import objc
from Foundation import NSObject, NSURL, NSURLRequest, NSTimer
from WebKit import (WKWebView, WKWebViewConfiguration, WKUserContentController,
                    WKWebsiteDataStore)

PORT = int(os.environ.get("CLAUDE_USAGE_PORT", "44405"))
BASE = f"http://127.0.0.1:{PORT}"

# Starting size only; the page measures its pill and reports the real one.
# Height mirrors reflect-mono's quick-pill (46pt pill + 8pt padding each side).
W, H = 210, 62
MIN_W, MAX_W = 80, 620   # clamps, so a broken page can't produce a silly panel
MIN_H, MAX_H = 40, 200
MARGIN = 24              # inset from the screen corner on first run
POS_KEY_X, POS_KEY_Y = "widgetX", "widgetY"


class DragOverlay(NSView):
    """Transparent full-panel overlay: drag the widget from anywhere on it,
    and report hover so the page can fade itself in."""

    owner = None            # set to the WidgetPanel after construction

    def mouseDownCanMoveWindow(self):
        # NSView's default is already YES, but that path is AppKit's own
        # background-drag — which never fires on a clearColor window, and which
        # would swallow the mouseDown we need below. Say NO and do it ourselves.
        return False

    def mouseDown_(self, event):
        # performWindowDragWithEvent: runs the whole drag loop and works
        # regardless of background colour or key status. This is what actually
        # moves the panel.
        self.window().performWindowDragWithEvent_(event)

    # The overlay swallows every mouse event, so the page can never see CSS
    # :hover. Track it out here and hand the answer to the page instead.
    def mouseEntered_(self, _event):
        if self.owner is not None:
            self.owner.setHover_(True)

    def mouseExited_(self, _event):
        if self.owner is not None:
            self.owner.setHover_(False)

    def drawRect_(self, _rect):
        # The page paints its own grip; nothing to draw here. Kept explicit so
        # it is clear the overlay is deliberately invisible, not unfinished.
        pass


class WidgetPanel(NSObject):
    """Owns the panel. `defaults` is the caller's NSUserDefaults suite."""

    def initWithDefaults_(self, defaults):
        self = objc.super(WidgetPanel, self).init()   # objc.super, not builtins.super
        if self is None:
            return None
        self._defaults = defaults
        self._panel = None
        self._web = None
        self._loaded = False
        return self

    # ---- lifecycle ----
    def _build(self):
        frame = NSMakeRect(*self._initial_origin(), W, H)
        panel = NSPanel.alloc().initWithContentRect_styleMask_backing_defer_(
            frame,
            NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel,
            NSBackingStoreBuffered, False)
        panel.setLevel_(NSStatusWindowLevel)
        panel.setCollectionBehavior_(
            NSWindowCollectionBehaviorCanJoinAllSpaces
            | NSWindowCollectionBehaviorFullScreenAuxiliary
            | NSWindowCollectionBehaviorStationary)
        panel.setOpaque_(False)
        panel.setBackgroundColor_(NSColor.clearColor())
        panel.setHasShadow_(True)
        # Deliberately NOT movableByWindowBackground: it does nothing on a
        # transparent window. DragOverlay drives the drag explicitly instead.
        panel.setMovableByWindowBackground_(False)
        panel.setHidesOnDeactivate_(False)       # stays put when another app takes focus
        panel.setReleasedWhenClosed_(False)
        panel.setDelegate_(self)

        content = panel.contentView()

        conf = WKWebViewConfiguration.alloc().init()
        # Ephemeral store: no disk cache, so an updated forecast.js can never be
        # shadowed by a stale copy. This page is always a localhost fetch.
        conf.setWebsiteDataStore_(WKWebsiteDataStore.nonPersistentDataStore())
        # The page measures its own content and posts the height here, so the
        # panel hugs the rows instead of leaving dead space under the last one.
        ucc = WKUserContentController.alloc().init()
        ucc.addScriptMessageHandler_name_(self, "size")
        conf.setUserContentController_(ucc)
        web = WKWebView.alloc().initWithFrame_configuration_(NSMakeRect(0, 0, W, H), conf)
        web.setAutoresizingMask_(2 | 16)          # width | height
        web.setNavigationDelegate_(self)
        # Let the panel's transparency through, so the page's rounded corners are
        # the real silhouette. KVC because there is no public setter; harmless if
        # a future macOS drops it, we just get an opaque white card.
        try:
            web.setValue_forKey_(False, "drawsBackground")
        except Exception:
            pass
        content.addSubview_(web)
        self._web = web

        # Added last, so it sits above the webview and wins the mouse events.
        overlay = DragOverlay.alloc().initWithFrame_(NSMakeRect(0, 0, W, H))
        overlay.setAutoresizingMask_(2 | 16)      # width | height — always full-bleed
        overlay.owner = self
        # ActiveAlways because this app never becomes active; InVisibleRect so
        # the area re-fits itself when the panel resizes to its content.
        overlay.addTrackingArea_(NSTrackingArea.alloc().initWithRect_options_owner_userInfo_(
            NSMakeRect(0, 0, 0, 0),
            NSTrackingMouseEnteredAndExited | NSTrackingActiveAlways | NSTrackingInVisibleRect,
            overlay, None))
        content.addSubview_(overlay)

        self._panel = panel
        self._load()

    def _initial_origin(self):
        """Saved position, else the top-right corner of the main screen."""
        x = self._defaults.objectForKey_(POS_KEY_X)
        y = self._defaults.objectForKey_(POS_KEY_Y)
        if x is not None and y is not None:
            return float(x), float(y)
        vis = NSScreen.mainScreen().visibleFrame()
        return (vis.origin.x + vis.size.width - W - MARGIN,
                vis.origin.y + vis.size.height - H - MARGIN)

    # ---- shown/hidden ----
    def isShown(self):
        return self._panel is not None and self._panel.isVisible()

    def show(self):
        if self._panel is None:
            self._build()
        # orderFront, never makeKeyAndOrderFront: taking key would defeat the
        # whole point of a non-activating panel.
        self._panel.orderFrontRegardless()
        if not self._loaded:
            self._load()

    def hide(self):
        if self._panel is not None:
            self._panel.orderOut_(None)

    def toggle(self):
        if self.isShown():
            self.hide()
        else:
            self.show()

    # ---- webview loading (retry until the server answers) ----
    def _load(self):
        self._web.loadRequest_(
            NSURLRequest.requestWithURL_(NSURL.URLWithString_(f"{BASE}/widget")))

    def webView_didFinishNavigation_(self, _web, _nav):
        self._loaded = True

    def webView_didFailProvisionalNavigation_withError_(self, _web, _nav, _err):
        self._retry()

    def webView_didFailNavigation_withError_(self, _web, _nav, _err):
        self._retry()

    def _retry(self):
        self._loaded = False
        NSTimer.scheduledTimerWithTimeInterval_target_selector_userInfo_repeats_(
            2.0, self, "reload:", None, False)

    def reload_(self, _timer):
        if not self._loaded and self._panel is not None:
            self._load()

    # ---- hover (fed from the overlay's tracking area) ----
    def setHover_(self, on):
        if self._web is None:
            return
        self._web.evaluateJavaScript_completionHandler_(
            "document.documentElement.classList.toggle('hover', %s)"
            % ("true" if on else "false"), None)

    # ---- content-driven sizing ----
    def userContentController_didReceiveScriptMessage_(self, _ucc, message):
        body = message.body()
        try:
            # WKWebView hands a JS object over as an NSDictionary.
            w = int(round(float(body["w"])))
            h = int(round(float(body["h"])))
        except Exception as e:
            # Never silently: a malformed size message used to just freeze the
            # panel at its default with no clue why.
            print("widget: bad size message %r (%s: %s)" % (body, type(e).__name__, e),
                  file=sys.stderr)
            return
        self.resizeToW_h_(max(MIN_W, min(MAX_W, w)), max(MIN_H, min(MAX_H, h)))

    def resizeToW_h_(self, w, h):
        if self._panel is None:
            return
        f = self._panel.frame()
        if abs(f.size.width - w) < 1 and abs(f.size.height - h) < 1:
            return
        # AppKit origin is bottom-left. Hold the TOP-LEFT corner still: the panel
        # grows rightward and downward, so it never creeps across the screen as
        # the numbers change units (40m -> 5.4h -> 2.2d).
        top = f.origin.y + f.size.height
        self._panel.setFrame_display_animate_(
            NSMakeRect(f.origin.x, top - h, w, h), True, False)

    # ---- persistence ----
    def windowDidMove_(self, _notification):
        if self._panel is None:
            return
        o = self._panel.frame().origin
        self._defaults.setObject_forKey_(float(o.x), POS_KEY_X)
        self._defaults.setObject_forKey_(float(o.y), POS_KEY_Y)
        self._defaults.synchronize()
