import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {PointerServer} from './pointerServer.js';

export default class ClawdPointerExtension extends Extension {
    enable() {
        this._server = new PointerServer({
            version: this.metadata['clawd-version'],
            socketPath: GLib.build_filenamev([GLib.get_user_runtime_dir(), 'clawd-pointer.sock']),
            readPointer: () => {
                const [x, y, mods] = global.get_pointer();
                return [x, y, (mods & Clutter.ModifierType.SHIFT_MASK) !== 0];
            },
        });
        this._server.start();
    }

    disable() {
        this._server?.stop();
        this._server = null;
    }
}
