/** WebSocket base URL of the app's own origin: 'ws://host:port' or 'wss://host'. */
export function wsBase(): string {
  const loc = (globalThis as { location?: { protocol: string; host: string } }).location
  if (!loc || !loc.host) throw new Error('wsBase(): no browser location available')
  return `${loc.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc.host}`
}

/** True for close codes that y-websocket treats as permanent (no automatic reconnect). */
export function isPermanentCloseCode(code: number | null | undefined): boolean {
  return typeof code === 'number' && code >= 4400 && code < 4500
}
