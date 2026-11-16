// GNOME's own "extension settings" entry point: the same pages as the Festoon window.

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {Pages} from './lib/app/pages.js';

export default class FestoonPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        new Pages(this.path, this.metadata['version-name']).fill(window, this.getSettings());
    }
}
