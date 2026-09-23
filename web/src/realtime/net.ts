/**
 * The browser's own network state, shared by the realtime rooms (docs.ts, meta.ts).
 *
 * Why Folio cares (SEC2-1). A frame handed to a WebSocket that cannot reach the network does not
 * fail: the browser keeps it in its send buffer and flushes it when the network returns —
 * closing the socket does not drop it either (the close frame simply queues behind it). So an
 * edit typed during a network blip that leaves the socket *open* can still arrive at the server
 * after the user logged out, moments before the retried logout revokes the session, even though
 * every provider was torn down at the logout itself. Nothing that was never written can leak, so
 * as soon as the browser reports it has no network, every provider is disconnected: edits made
 * meanwhile stay local (pending / unsynced, kept for the user) and go out on the next
 * connection, which is exactly what happens when a socket drops outright.
 *
 * `navigator.onLine` is only believed when it says *offline* — false means the machine has no
 * usable interface, while true says nothing about the server being reachable. A blip the browser
 * does not notice (a dead link, a black hole between here and the server) still leaves the socket
 * open; the server closes such a connection on its next message once the session is gone
 * (server/src/collab/doc-room.ts).
 */

/** True when the browser reports that this machine has no network at all. */
export function browserOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false
}

/**
 * Run `fn(offline)` when the browser goes offline or online. Returns the unsubscribe function
 * (a no-op outside a browser).
 */
export function onBrowserNetwork(fn: (offline: boolean) => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const onOffline = () => fn(true)
  const onOnline = () => fn(false)
  window.addEventListener('offline', onOffline)
  window.addEventListener('online', onOnline)
  return () => {
    window.removeEventListener('offline', onOffline)
    window.removeEventListener('online', onOnline)
  }
}
