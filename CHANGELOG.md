# Changelog

What's new in each version, newest first.

## [Unreleased]
- Desktop and CLI each show only the account they're signed in to right now. Switching Claude Code or the desktop app to another email used to carry the old account's history into the new one, which looked like a sudden reset and threw off the forecast. Your old account's history is kept, just not shown.

## [0.26.0] - 2026-11-09
- The API-equivalent spend card is simpler: one range picker (24h, 7 days, 30 days or All time) sets the total, a bar splits it between Claude and Codex, and below it is a list of your most expensive chats in that range. Click a chat for its details. The first start after updating takes a little longer while it re-reads your logs.

## [0.25.0] - 2026-11-08
- The reset countdown moved into the grey part of each meter, at its right end, so it's shorter: just the time left, like ↻ 2d 4h. When the bar is nearly full and there's no room, it shows just above the bar's end instead.

## [0.24.0] - 2026-11-08
- The charts have two more ranges: 2 weeks and Month, next to 24h, Week and Full.
- Clicking the menu bar opens the panel much faster after it has been closed for a while: it used to take a few seconds.

## [0.23.0] - 2026-11-08
- New usage meters on the dashboard, one per limit. Each bar shows how much you've used, what you'd add in the next hour at your current pace, the rest of the forecast to the reset (red if you'll run out first) and what's left, and it smokes when you're burning through it fast. Hover over any part of the bar for the details and a short explanation. The reset countdown sits above it, on the right. This replaces the old bars and the separate burn-rate gauge.
- The forecast card is gone: its forecast is on the meter now, and you pick the forecast model by hovering over the forecast part of the meter. The "used" total and the legend next to each chart are gone too.
- The 24h / Week / Full buttons moved under the timeline strip at the bottom of each chart, next to a line that says what the chart is showing, such as "Last 7 days" or "Nov 5 – Nov 9 · 5 days" after you drag.

## [0.22.0] - 2026-11-08
- A new menu bar: one dial each for Claude and Codex, with the time until that limit resets. The dial shows how much you've used, how much more you're forecast to use before the reset (red if you'll run out first), and how fast you're using it now. Tick Verbose in the panel to see every number, and click the ? next to it to learn how to read the dial.

## [0.21.0] - 2026-11-08
- The menu bar now recovers automatically if it freezes and stops responding to clicks. It saves a local diagnostic before restarting, while usage tracking continues.
- The window marker in the strip under each chart is easier to grab when zoomed in. It stays visible at a usable size, and dragging its middle always moves it instead of resizing it.
- Works with plans that no longer have a 5-hour limit, such as Ultra. The menu bar shows your weekly usage instead of disappearing, the burn-rate gauge follows the weekly limit, and the empty 5-hour row, forecast and legend entry are hidden.

## [0.20.6] - 2026-10-15
- The burn-rate gauges now show a slow, steady burn instead of sitting at 0. Usage moves in whole percents, so at a couple of percent an hour the needle used to read 0 most of the time and jump only when the number ticked over.

## [0.20.5] - 2026-10-15
- Pressing Update more than once, or from both the dashboard and the menu bar, no longer starts two updates at the same time. That could make a successful update look like it had failed with "couldn't reach the code repository".

## [0.20.4] - 2026-10-14
- Opening the menu-bar panel now shows your latest usage straight away. Before, the charts could fast-forward through everything that happened while the panel was closed.

## [0.20.3] - 2026-10-12
- The steam that rises from a burn-rate gauge running over the max is no longer cut off at the top.

## [0.20.2] - 2026-10-11
- Short connection blips show on the charts again, as in 0.20.0. Every time the connection dropped is shaded, however brief.

## [0.20.1] - 2026-10-11
- Short connection blips of a minute or two no longer show up as thin grey stripes on the charts. Only outages of 5 minutes or more are shaded, and outages a few minutes apart are shaded as one.

## [0.20.0] - 2026-10-11
- Times when you had no internet connection are now shaded grey on the charts and overview strips, labelled "offline", so a gap in your usage line explains itself. Hovering over one says "offline" too. Gaps from before this update are filled in from your history.
- When updating fails, the reason is now written to the log, which makes problems easier to track down.

## [0.19.1] - 2026-10-08
- Opening the dashboard after a long break (say, after your Mac was asleep) now fetches fresh usage straight away. You no longer see a "no new samples" warning first, or the charts and bars catching up step by step.
- Double-clicking a chart to reset the zoom now moves the overview strip's window back too. Dragging across a chart to zoom also moves it.

## [0.19.0] - 2026-10-07
- Each chart now has a small overview strip underneath showing all your history and the forecast. Drag the highlighted window to look back in time or further ahead (up to a week), drag its edges to zoom, or click anywhere on the strip to jump there. The 24h, Week and Full buttons snap back to the usual views.
- Charts now go all the way back to when you started tracking, not just the last two weeks, and still open just as fast. Stop on an older stretch for a moment and it fills in with full detail.

## [0.18.2] - 2026-10-07
- Usage now picks up again within a minute or two after your connection drops or your Mac wakes up. Before, it could stay frozen for up to half an hour.
- A single failed update no longer shows an error. You only see one if updates keep failing.

## [0.18.1] - 2026-10-06
- Opening the dashboard or the menu-bar panel now shows your latest usage straight away. No more bars sliding in, gauges sweeping, or numbers catching up after a moment.

## [0.18.0] - 2026-10-06
- Claude and Codex now each have their own forecast style and chart range (24h, Week, Full), so changing one no longer changes the other.
- New "Analog" forecast: it looks at what happened after earlier moments like now, the same time of day and the same busy-or-idle pace. It's the most accurate forecast for Codex so far, and new Codex setups start on it.

## [0.17.0] - 2026-09-25
- Claude usage now keeps up when you use Claude through apps like Conductor, not just in the terminal. Before, it could lag by up to half an hour.
- When Claude gives a model like Fable its own weekly limit, an All | Fable switch next to "Claude" shows how much of that limit you've used and when it resets.

## [0.16.1] - 2026-09-23
- "Update" used to get stuck saying the app would restart in a moment, forever, whenever the update couldn't be applied. It now tells you what stopped it — and if the app doesn't come back up after installing, it says that too instead of leaving you waiting.

## [0.16.0] - 2026-09-21
- Use Claude in both the desktop app and the terminal? A Desktop | CLI toggle next to "Claude" switches between them, in the menu bar too — handy when they're signed in to different accounts.
- Claude usage from the terminal updates as you work instead of every few minutes, and runs into "rate limit" pauses far less often. Your existing Claude Code status line keeps working as before.

## [0.15.1] - 2026-09-11
- The "What's new" notes are now easier to read, including the ones for earlier versions.

## [0.15.0] - 2026-09-11
- After an update you now get a short summary of what's new. Click the version number at the bottom of the dashboard to see the full history any time.
- Fixed a false "no new samples" warning that could appear when opening the menu-bar panel.

## [0.14.1] - 2026-09-11
- The chat spending chart now puts each chat on the day you last used it, not the day you started it.

## [0.14.0] - 2026-09-11
- New settings (the ⚙ button): pick the days you work, so forecasts don't expect usage on your days off.

## [0.13.2] - 2026-09-10
- The chart range buttons are back inside the chart.

## [0.13.1] - 2026-09-10
- Forecasts no longer predict less than you've already used.
- Clearer controls above the charts.

## [0.13.0] - 2026-09-10
- The shaded area around a forecast now reflects how accurate that forecast has actually been for you.
- One set of controls now drives both charts.

## [0.12.1] - 2026-09-10
- Behind-the-scenes cleanup.

## [0.12.0] - 2026-09-10
- Forecasts now show a shaded range of likely outcomes, not just a single line.

## [0.11.2] - 2026-09-10
- Fixed forecasts right after your limit resets.

## [0.11.1] - 2026-09-10
- The Adaptive forecast now follows your usual pace instead of dropping to zero.

## [0.11.0] - 2026-09-10
- New "Adaptive" forecast that adjusts to how you're working right now. It's the new default.

## [0.10.0] - 2026-09-10
- The charts, the forecast text and the floating widget now always show the same forecast.

## [0.9.3] - 2026-09-10
- Fixed the charts briefly showing a wrong forecast when the dashboard opens.

## [0.9.2] - 2026-09-10
- Smoother hovering on the chat spending chart.

## [0.9.1] - 2026-09-09
- More accurate spending estimates.

## [0.9.0] - 2026-09-09
- The spending chart can now show all time or just today.

## [0.8.1] - 2026-09-09
- Spending bars now show each chat's share of the total.

## [0.8.0] - 2026-09-09
- New chart showing what each chat would have cost at API prices.
- Claude and Codex now each have their own colour throughout.

## [0.7.2] - 2026-09-09
- Hovering over a chart now shows the exact values.

## [0.7.1] - 2026-09-09
- Hovering over a chart now shows the time.

## [0.7.0] - 2026-09-09
- The floating widget shows where you'll end up by the next reset.
- New: see how accurate each forecast method has been on your own history.

## [0.6.3] - 2026-09-08
- Changed the meaning of the widget's +/− sign (undone in the next version).

## [0.6.2] - 2026-09-08
- Fixed a problem that could slowly build up when the app ran for a long time.

## [0.6.1] - 2026-09-08
- A cleaner look for the floating widget.

## [0.6.0] - 2026-09-08
- The floating widget is now a compact pill showing how much room you have left on each service.

## [0.5.0] - 2026-09-07
- New floating widget: a small always-on-top window with your forecasts.

## [0.4.4] - 2026-09-07
- The app keeps collecting data even if one check fails, and tells you when data is out of date.

## [0.4.3] - 2026-09-04
- Better forecasts.
- Fixed a false "out of date" warning on some chart ranges.

## [0.4.2] - 2026-09-04
- Simpler charts.

## [0.4.1] - 2026-09-04
- Reset times now come straight from Claude and Codex, so they're exact.
- A simpler dashboard layout.
- The dashboard has a new address: http://127.0.0.1:44405

## [0.4.0] - 2026-09-03
- Forecasts: the charts now show where your usage is heading before the next reset.
- Choose between forecast methods. Forecasts take your time-of-day habits and recent pace into account.

## [0.3.7] - 2026-08-27
- The Codex gauge now uses a fixed scale.

## [0.3.6] - 2026-08-27
- Fixed Claude usage disappearing after switching accounts.

## [0.3.5] - 2026-08-26
- Zen mode now stays on after restarts.

## [0.3.4] - 2026-08-26
- New Zen mode for a quieter menu bar.
- Clearer message when Claude is rate-limiting the app.

## [0.3.3] - 2026-08-26
- The gauge lets off steam when you're using your limit very fast.

## [0.3.2] - 2026-08-26
- The gauge needle shakes when you're using your limit faster than its scale.

## [0.3.1] - 2026-08-25
- A simpler Codex chart.

## [0.3.0] - 2026-08-25
- The spending estimate now includes Codex.

## [0.2.7] - 2026-08-25
- Fixed the menu-bar panel sometimes opening blank.

## [0.2.6] - 2026-08-25
- The menu-bar gauge revs up when your usage rises, and the layout is tidier.

## [0.2.5] - 2026-08-24
- When an update is available, one click installs it.

## [0.2.4] - 2026-08-24
- Charts are easier to read in dark mode.

## [0.2.3] - 2026-08-24
- Usage spikes are now marked on the Codex chart too.

## [0.2.2] - 2026-08-21
- Nicer-looking gauges.

## [0.2.1] - 2026-08-21
- Fixed the Codex gauge.

## [0.2.0] - 2026-08-20
- New gauges show how fast you're using your limits, in the dashboard and the menu bar.

## [0.1.2] - 2026-08-20
- New "Check for updates" button.

## [0.1.1] - 2026-08-20
- Fixed issues with the update banner.

## [0.1.0] - 2026-08-20
- First release: your Claude and Codex usage in the menu bar and a live dashboard, with history charts, estimated spending and one-click updates.
