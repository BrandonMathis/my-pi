# macOS Completion Chime

Plays a macOS alert sound when Pi finishes an agent run. The chime is enabled by default.

## Commands

- `/chime` or `/chime select` — open the sound picker
- `/chime preview` — demo the currently selected sound
- `/chime on` — enable completion chimes
- `/chime off` — disable completion chimes
- `/chime status` — show current config
- `/chime reset` — reset to Ping or the first available macOS sound

In the picker:

- `↑` / `↓` navigate
- `Space`, `P`, or `R` previews/replays the highlighted sound
- `A` toggles auto-preview, so moving through the list demos each highlighted sound
- `Enter` selects it
- `E` toggles enabled/disabled
- `Esc` cancels

Config is saved to:

```text
~/.pi/agent/state/mac-completion-chime.json
```

The extension discovers sounds from:

- `/System/Library/Sounds`
- `/Library/Sounds`
- `~/Library/Sounds`

File sounds are played with `afplay`. The `System Alert` option uses AppleScript `beep`, which respects your current macOS alert sound.
