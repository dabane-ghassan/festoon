// Reads the text in screenshots so search can find it. Uses tesseract when it is installed;
// everything stays on this computer. One picture at a time, at low priority.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// ISO 639-1 (from $LANG) to tesseract's language packs
const PACKS = {
    fr: 'fra', de: 'deu', es: 'spa', it: 'ita', pt: 'por', nl: 'nld', sv: 'swe', da: 'dan', nb: 'nor',
    fi: 'fin', pl: 'pol', cs: 'ces', ru: 'rus', uk: 'ukr', tr: 'tur', el: 'ell', ar: 'ara', he: 'heb',
    ja: 'jpn', ko: 'kor', zh: 'chi_sim', hi: 'hin', ro: 'ron', hu: 'hun', ca: 'cat', vi: 'vie',
};

export class Reader {
    constructor() {
        this._tool = GLib.find_program_in_path('tesseract');
        this._queue = [];
        this._busy = false;
        this._langs = null;
        this._cancel = new Gio.Cancellable();
    }

    get available() {
        return !!this._tool;
    }

    _languages() {
        if (this._langs !== null)
            return this._langs;
        this._langs = '';
        try {
            const [, out] = GLib.spawn_command_line_sync(`${GLib.shell_quote(this._tool)} --list-langs`);
            const have = new TextDecoder().decode(out).split('\n').map(s => s.trim());
            const want = ['eng'];
            for (const name of GLib.get_language_names()) {
                const pack = PACKS[name.slice(0, 2)];
                if (pack && !want.includes(pack))
                    want.push(pack);
            }
            this._langs = want.filter(l => have.includes(l)).join('+');
        } catch (_e) {
            // tesseract picks its default
        }
        return this._langs;
    }

    /** Calls done(text) later, or not at all if tesseract is missing or fails. */
    read(path, done) {
        if (!this._tool)
            return;
        this._queue.push([path, done]);
        this._next();
    }

    _next() {
        if (this._busy || !this._queue.length)
            return;
        const [path, done] = this._queue.shift();
        this._busy = true;
        const argv = ['nice', '-n', '15', this._tool, path, 'stdout', '--psm', '3'];
        const langs = this._languages();
        if (langs)
            argv.push('-l', langs);
        if (!GLib.find_program_in_path('nice'))
            argv.splice(0, 3);
        let proc;
        try {
            proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (_e) {
            this._busy = false;
            this._next();
            return;
        }
        proc.communicate_utf8_async(null, this._cancel, (p, res) => {
            try {
                const [, out] = p.communicate_utf8_finish(res);
                const text = (out ?? '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
                if (text)
                    done(text);
            } catch (_e) {
                // unreadable picture or cancelled
            }
            this._busy = false;
            this._next();
        });
    }

    destroy() {
        this._queue = [];
        this._cancel.cancel();
    }
}
