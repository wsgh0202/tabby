import type { MCPToken } from './tokens'

/** Metadata validation is separate from policy support, so old policies stay editable. */
export function isMCPTokenMetadata (value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { return false }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) { return false }
    const record = value as Record<string, unknown>
    return typeof record.id === 'string' && record.id.length > 0
        && typeof record.name === 'string'
        && (record.preview === undefined || typeof record.preview === 'string')
}

/** Keep only a non-authenticating hint; the full bearer token is shown once. */
export function previewMCPToken (token: string): string {
    return `${token.slice(0, 8)}…${token.slice(-4)}`
}

export function getMCPTokenLabel (token: MCPToken): string {
    // Older entries have a name but no preview. Use their ID only as a last resort.
    return token.name ? token.name : token.preview ?? previewMCPToken(token.id.replace(/^mcp:token:/, ''))
}
