// Names shared by the shell side, the line, the app and the command.
// No imports here: this file is loaded both inside GNOME Shell and in ordinary gjs processes.

export const UUID = 'festoon@dabane-ghassan.github.io';
export const APP_ID = 'io.github.dabane_ghassan.Festoon';
export const SCHEMA = 'org.gnome.shell.extensions.festoon';

// The line runs as its own small GTK process so items can be dragged into any app.
export const LINE_ID = 'io.github.dabane_ghassan.Festoon.Line';
export const LINE_PATH = '/io/github/dabane_ghassan/Festoon/Line';
export const LINE_IFACE = 'io.github.dabane_ghassan.Festoon.Line';

// The shell side, on the org.gnome.Shell connection.
export const SHELL_PATH = '/io/github/dabane_ghassan/Festoon';
export const SHELL_IFACE = 'io.github.dabane_ghassan.Festoon';

export const LINE_XML = `
<node>
  <interface name="${LINE_IFACE}">
    <method name="Reveal"><arg type="s" direction="in" name="reason"/></method>
    <method name="Tuck"/>
    <method name="Toggle"/>
    <method name="Search"/>
    <method name="PanelHover"><arg type="b" direction="in" name="inside"/></method>
    <method name="HangText"><arg type="s" direction="in" name="text"/></method>
    <method name="HangFile">
      <arg type="s" direction="in" name="path"/>
      <arg type="s" direction="in" name="how"/>
      <arg type="s" direction="out" name="id"/>
    </method>
    <method name="Copy"><arg type="s" direction="in" name="which"/><arg type="b" direction="out" name="ok"/></method>
    <method name="LetGo"><arg type="s" direction="in" name="which"/><arg type="b" direction="out" name="ok"/></method>
    <method name="PutBack"><arg type="b" direction="out" name="ok"/></method>
    <method name="Clear"/>
    <method name="GetState"><arg type="s" direction="out" name="json"/></method>
    <method name="GetItems"><arg type="s" direction="out" name="json"/></method>
    <method name="GetLayout"><arg type="s" direction="out" name="json"/></method>
    <method name="Quit"/>
    <signal name="StateChanged"><arg type="s" name="json"/></signal>
    <signal name="Event"><arg type="s" name="name"/></signal>
  </interface>
</node>`;

export const SHELL_XML = `
<node>
  <interface name="${SHELL_IFACE}">
    <method name="SetClipboard">
      <arg type="s" direction="in" name="mime"/>
      <arg type="s" direction="in" name="value"/>
      <arg type="b" direction="in" name="isPath"/>
    </method>
    <method name="Show"/>
    <method name="Hide"/>
    <method name="Toggle"/>
    <method name="Search"/>
    <method name="Restart"/>
    <method name="GetState"><arg type="s" direction="out" name="json"/></method>
  </interface>
</node>`;

export const SIZES = {
    small: 92,
    medium: 124,
    large: 164,
};

/** Height of the line's window for an item size, in logical pixels. */
export function lineHeight(size) {
    return Math.ceil((SIZES[size] ?? SIZES.medium) * 2.25 + 76);
}
