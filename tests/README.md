# Tests

`python3 tests/run.py` (or `make test`) starts a private, headless GNOME Shell and loads the
extension from this checkout, which starts the line. It then drives everything with a virtual
mouse and keyboard. A plain GTK window (`probe-app.js`) sits underneath: it logs the clicks and
drops it receives, and copies text, pictures, files and password-manager secrets to the clipboard
on request, like any app. Screenshots are saved to `tests/out/`.

You need `gnome-shell`, `gjs`, GTK 4, libadwaita and `rsvg-convert`; `tesseract` for the check
that text in screenshots is read. Nothing touches your own session or settings: the run uses a
temporary home folder and its own D-Bus.

In a container there is usually no system bus and no login manager. Start one bus with
`dbus-daemon --system --fork`, and if GNOME Shell exits complaining about the login manager,
move an empty `/run/systemd/seats` out of the way.

The headless shell cannot show sound, or the exact pacing of animations (it draws frames as fast
as it can).
