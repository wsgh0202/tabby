interface DisconnectableSSHClient {
    disconnect: () => Promise<void>
}

/** A cancelled connection may still produce a client after its first cleanup. */
export class SSHSessionCleanup {
    private announced = false
    private disconnects = new WeakMap<DisconnectableSSHClient, Promise<void>>()

    constructor (
        private announce: () => void,
        private onDisconnectError: () => void,
    ) { }

    disconnect (client?: DisconnectableSSHClient): Promise<void> {
        // Set the guard before callbacks: shell teardown can release the last
        // reference and synchronously re-enter SSHSession.destroy().
        if (!this.announced) {
            this.announced = true
            this.announce()
        }
        if (!client) { return Promise.resolve() }
        const previous = this.disconnects.get(client)
        if (previous) { return previous }
        // Cache before invoking the native operation, and handle its rejection
        // even when teardown was initiated by a fire-and-forget event callback.
        const pending = Promise.resolve().then(() => client.disconnect()).catch(() => {
            this.onDisconnectError()
        })
        this.disconnects.set(client, pending)
        return pending
    }
}
