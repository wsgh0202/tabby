import { isIP } from 'net'

export const DEFAULT_MCP_HOST = '127.0.0.1'
export const MCP_INVALID_HOST_MESSAGE = 'MCP listen IP must be a valid IPv4 or IPv6 address'

export function normalizeMCPHost (value: unknown): string {
    if (typeof value !== 'string') { throw new Error(MCP_INVALID_HOST_MESSAGE) }
    const host = value.trim()
    // Scoped IPv6 literals cannot be represented by standard HTTP URLs.
    if (!isIP(host) || host.includes('%')) { throw new Error(MCP_INVALID_HOST_MESSAGE) }
    return isIP(host) === 6 ? new URL(`http://[${host}]`).hostname.slice(1, -1) : host
}

function authority (host: string, port: number|string): string {
    return `${host.includes(':') ? `[${host}]` : host}:${port}`
}

/** Wildcard listeners still need a usable local URL for Copy and previews. */
export function formatMCPAddress (host: string, port: number|string): string {
    let localHost = host
    if (host === '0.0.0.0') { localHost = DEFAULT_MCP_HOST } else if (host === '::') { localHost = '::1' }
    return `http://${authority(localHost, port)}/mcp`
}

/** Trust the actual accepted interface, never an arbitrary DNS Host header. */
export function getMCPAllowedHosts (localAddress: string|undefined, port: number): string[] {
    let host = ''
    try { host = normalizeMCPHost(localAddress) } catch { return [] }
    const hosts = [host]
    // Dual-stack listeners can report an IPv4 connection as ::ffff:aabb:ccdd.
    const mapped = /^::ffff:([a-f\d]{1,4}):([a-f\d]{1,4})$/.exec(host)
    if (mapped) {
        const high = parseInt(mapped[1], 16)
        const low = parseInt(mapped[2], 16)
        hosts.push([high >> 8, high & 255, low >> 8, low & 255].join('.'))
    }
    if (hosts.some(address => address === '::1' || address.startsWith('127.'))) {
        hosts.push('localhost')
    }
    // URL clients omit the default HTTP port from Host and Origin.
    const allowed = hosts.map(address => authority(address, port))
    if (port === 80) {
        allowed.push(...hosts.map(address => address.includes(':') ? `[${address}]` : address))
    }
    return allowed
}
