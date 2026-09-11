# Changelog

What changed in each release, newest first.

## [0.14.1] - 2026-09-11
- dashboard: place the chat bars by last use, not creation

## [0.14.0] - 2026-09-11
- settings: working days, behind a cogwheel

## [0.13.2] - 2026-09-10
- dashboard: range control back inside the chart card

## [0.13.1] - 2026-09-10
- dashboard: split the two pickers, and floor the forecast at current usage

## [0.13.0] - 2026-09-10
- predict: the cone is each model's own error, and one control bar for both charts

## [0.12.1] - 2026-09-10
- predict: delete the block-bootstrap cone, now unused

## [0.12.0] - 2026-09-10
- predict: every model returns a calibrated band, not a bare line

## [0.11.2] - 2026-09-10
- predict: the cycle after a reset is not empty

## [0.11.1] - 2026-09-10
- predict: adaptive decays to the sustained pace, not to zero

## [0.11.0] - 2026-09-10
- predict: add "adaptive", and make it the default

## [0.10.0] - 2026-09-10
- forecast: one trajectory behind the chart, the text row and the pill

## [0.9.3] - 2026-09-10
- dashboard: draw the charts after the reset instants are known

## [0.9.2] - 2026-09-10
- dashboard: stop the chat hover box flickering and chasing the cursor

## [0.9.1] - 2026-09-09
- ccost: stop double-counting turns, and price Opus at its real rate

## [0.9.0] - 2026-09-09
- dashboard: All / Today modes for the spend bars

## [0.8.1] - 2026-09-09
- dashboard: bars show share of provider spend, not of one model

## [0.8.0] - 2026-09-09
- dashboard: per-chat spend chart, and one colour per provider

## [0.7.2] - 2026-09-09
- dashboard: show y values in the cursor readout, and fix Codex's series labels

## [0.7.1] - 2026-09-09
- dashboard: show the timestamp under the cursor on both charts
- docs: refresh the dashboard screenshot

## [0.7.0] - 2026-09-09
- widget: show where you land, name the window, drop decimals, shrink to 80%
- dashboard: backtest the forecast models against your own history
- Revert "widget: invert the pill's sign convention — + now means hitting the limit"

## [0.6.3] - 2026-09-08
- widget: invert the pill's sign convention — + now means hitting the limit

## [0.6.2] - 2026-09-08
- poller: close the cookie-db connection — it leaked a descriptor per poll

## [0.6.1] - 2026-09-08
- widget: drop the pill's drop shadow, swap the mark colours

## [0.6.0] - 2026-09-08
- widget: reshape as a pill showing one signed margin per platform

## [0.5.0] - 2026-09-07
- widget: floating always-on-top panel with the forecast lines

## [0.4.4] - 2026-09-07
- poller: a failed poll can no longer kill sampling; warn when data is stale

## [0.4.3] - 2026-09-04
- forecast: cycle+tod predicts a distribution; fix range-dependent staleness

## [0.4.2] - 2026-09-04
- dashboard: remove the numbered spike badges + Spike-window control
- docs: update dashboard screenshot to the current UI

## [0.4.1] - 2026-09-04
- dashboard: wire authoritative resets, drop metric cards + Spark line
- change: default port 8787 -> 44405
- fix: project Codex resets on the authoritative window, not inferred drops

## [0.4.0] - 2026-09-03
- chore: gitignore .build/ (local Swift-rewrite build artifacts)
- fix: anchor cycle+tod hour-of-day rates to the overall rate (no flat tail)
- feat: blend recent trailing slope into cycle+tod (reactive forecast)
- feat: recency-weight the rate estimators (3-day half-life)
- feat: derive the 7-day forecast from the 5-hour projection
- feat: cycle + time-of-day predictor (now the default)
- fix: 7-day forecast cut off when the two lines project differently
- feat: reset-aware cycle projection + default to cycle
- feat: forecast-method selector (Linear / Cycle)
- feat: reset-aware 'cycle' predictor
- feat: forecast projection in dashboard charts (rightmost 25%)
- feat: generic usage-prediction interface + linear strategy
- Design spec: generic usage-prediction interface

## [0.3.7] - 2026-08-27
- Codex gauge: fixed 0–8 %/h dial

## [0.3.6] - 2026-08-27
- Self-heal Claude 404 from a stale org (account/org switch)

## [0.3.5] - 2026-08-26
- Harden zen-mode persistence across restarts

## [0.3.4] - 2026-08-26
- Add menu-bar zen mode; gentler CLI polling + friendlier rate-limit banner

## [0.3.3] - 2026-08-26
- Add steam animation to the gauge when over the dial max

## [0.3.2] - 2026-08-26
- Vibrate the gauge needle when over the dial max

## [0.3.1] - 2026-08-25
- Codex chart cleanup: drop 5-hour, unify 7-day color, reorder forecast

## [0.3.0] - 2026-08-25
- Include Codex in the API-equivalent spend figure

## [0.2.7] - 2026-08-25
- Fix blank menu-bar webview when the server isn't up at launch

## [0.2.6] - 2026-08-25
- Menu bar: rev gauge on rising usage; tighten box margins, pad content

## [0.2.5] - 2026-08-24
- Footer button doubles as an "Update to vX" button when one is available

## [0.2.4] - 2026-08-24
- Fix dark-mode chart visibility: axis numbers + zoom selection

## [0.2.3] - 2026-08-24
- Show spike badges on the Codex chart

## [0.2.2] - 2026-08-21
- Refine burn-rate gauges: menu-bar backdrop, 0–100 Claude scale, readout
- README: update hero screenshot to the current dashboard

## [0.2.1] - 2026-08-21
- Fix Codex burn-rate gauge (window-relative, binding window)

## [0.2.0] - 2026-08-20
- Add burn-rate gauges (web dashboard + menu bar)

## [0.1.2] - 2026-08-20
- Add "Check for updates" button

## [0.1.1] - 2026-08-20
- Fix update banner always visible: guard the hidden attribute
- Fix update banner hanging on "Updating…" when no update starts

## [0.1.0] - 2026-08-20
- Add self-updater: check GitHub release tags, one-click update
- Prefer desktop app for Claude; make CLI a rate-limit-aware fallback
- Menu bar: stack Claude + Codex rows with icons when both have data
- Read Claude usage from the CLI OAuth token, no desktop app needed
- Add API-equivalent spend strip to dashboard
- Widget view: hide title via ?widget=1; move status to per-column dots
- README: add 'Give this to your agent' block + install.md
- Update README with image and app details
- Chart header: stack 'used' tally under the legend, fix narrow-view wrapping
- Make it installable by others: README, install prereqs, uninstall
- Menu bar: embed live dashboard as a WKWebView popover
- Initial commit: Claude & Codex usage dashboard
