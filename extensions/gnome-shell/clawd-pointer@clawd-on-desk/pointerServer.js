// Announces "v <version>\n" on connect, then streams "x y shift\n" to local
// clients whenever one changes. Nothing reads
// the pointer while no client is connected. The socket lives in the user's
// private runtime directory and is restricted to the user.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const POLL_MS = 50;
const MAX_CLIENTS = 4;
const encoder = new TextEncoder();

export class PointerServer {
    constructor({socketPath, readPointer, pollMs = POLL_MS, version}) {
        this._version = version;
        this._socketPath = socketPath;
        this._readPointer = readPointer;
        this._pollMs = pollMs;
        this._clients = new Set();
        this._service = null;
        this._pollId = 0;
        this._last = null;
    }

    start() {
        const file = Gio.File.new_for_path(this._socketPath);
        try {
            file.delete(null);
        } catch {
            // No stale socket from an earlier session.
        }
        this._service = new Gio.SocketService();
        this._service.add_address(
            Gio.UnixSocketAddress.new(this._socketPath),
            Gio.SocketType.STREAM,
            Gio.SocketProtocol.DEFAULT,
            null);
        file.set_attribute_uint32('unix::mode', 0o600, Gio.FileQueryInfoFlags.NONE, null);
        this._service.connect('incoming', (_service, connection) => {
            this._addClient(connection);
            return true;
        });
        this._service.start();
    }

    stop() {
        this._stopPolling();
        for (const client of [...this._clients])
            this._dropClient(client);
        if (this._service) {
            this._service.stop();
            this._service.close();
            this._service = null;
        }
        try {
            Gio.File.new_for_path(this._socketPath).delete(null);
        } catch {
            // Already gone.
        }
    }

    _addClient(connection) {
        if (this._clients.size >= MAX_CLIENTS) {
            connection.close(null);
            return;
        }
        const client = {
            connection,
            output: connection.get_output_stream(),
            input: connection.get_input_stream(),
            cancellable: new Gio.Cancellable(),
            writing: false,
            pending: null,
        };
        this._clients.add(client);
        this._watchClosed(client);
        if (this._version !== undefined)
            this._send(client, `v ${this._version}\n`);
        if (this._last)
            this._send(client, this._last);
        this._startPolling();
        this._poll();
    }

    _dropClient(client) {
        if (!this._clients.delete(client))
            return;
        client.cancellable.cancel();
        try {
            client.connection.close(null);
        } catch {
            // The peer already went away.
        }
        if (this._clients.size === 0) {
            this._stopPolling();
            this._last = null;
        }
    }

    // Clients never send anything, so any read ending means they left.
    _watchClosed(client) {
        client.input.read_bytes_async(16, GLib.PRIORITY_DEFAULT, client.cancellable, (stream, result) => {
            let bytes = null;
            try {
                bytes = stream.read_bytes_finish(result);
            } catch {
                this._dropClient(client);
                return;
            }
            if (bytes.get_size() === 0)
                this._dropClient(client);
            else
                this._watchClosed(client);
        });
    }

    _startPolling() {
        if (this._pollId)
            return;
        this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._pollMs, () => {
            this._poll();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopPolling() {
        if (!this._pollId)
            return;
        GLib.source_remove(this._pollId);
        this._pollId = 0;
    }

    _poll() {
        const [x, y, shift] = this._readPointer();
        const line = `${Math.round(x)} ${Math.round(y)} ${shift ? 1 : 0}\n`;
        if (line === this._last)
            return;
        this._last = line;
        for (const client of this._clients)
            this._send(client, line);
    }

    // A slow client only ever gets the newest position.
    _send(client, line) {
        if (client.writing) {
            client.pending = line;
            return;
        }
        client.writing = true;
        const bytes = new GLib.Bytes(encoder.encode(line));
        client.output.write_bytes_async(bytes, GLib.PRIORITY_DEFAULT, client.cancellable, (stream, result) => {
            client.writing = false;
            try {
                stream.write_bytes_finish(result);
            } catch {
                this._dropClient(client);
                return;
            }
            if (client.pending) {
                const next = client.pending;
                client.pending = null;
                this._send(client, next);
            }
        });
    }
}
