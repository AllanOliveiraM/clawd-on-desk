// Runs the extension's real PointerServer outside GNOME Shell with a fake
// pointer: x counts up on every read, unless "still" is the third argument.
import GLib from 'gi://GLib';
import {PointerServer} from '../../extensions/gnome-shell/clawd-pointer@clawd-on-desk/pointerServer.js';
import {exit, programArgs} from 'system';

const [socketPath, reportPath, mode] = programArgs;
let reads = 0;
const server = new PointerServer({
    socketPath,
    pollMs: 10,
    readPointer: () => {
        reads += 1;
        GLib.file_set_contents(reportPath, String(reads));
        return mode === 'still' ? [7, 9] : [reads, 5];
    },
});
server.start();
print('ready');
const loop = new GLib.MainLoop(null, false);
GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, 15, () => {
    server.stop();
    loop.quit();
    return GLib.SOURCE_REMOVE;
});
loop.run();
exit(0);
