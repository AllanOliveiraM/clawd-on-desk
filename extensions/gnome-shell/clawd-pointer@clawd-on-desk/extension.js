import GLib from 'gi://GLib';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {PointerServer} from './pointerServer.js';

export default class ClawdPointerExtension extends Extension {
    enable() {
        this._server = new PointerServer({
            socketPath: GLib.build_filenamev([GLib.get_user_runtime_dir(), 'clawd-pointer.sock']),
            readPointer: () => global.get_pointer().slice(0, 2),
        });
        this._server.start();
    }

    disable() {
        this._server?.stop();
        this._server = null;
    }
}
