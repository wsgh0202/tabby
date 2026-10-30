import type { MCPToken } from './tokens'

/** Keep only a non-authenticating hint; the full bearer token is shown once. */
export function previewMCPToken (token: string): string {
    return `${token.slice(0, 8)}…${token.slice(-4)}`
}

export function getMCPTokenLabel (token: MCPToken): string {
    // Older entries have a name but no preview. Use their ID only as a last resort.
    return token.name ? token.name : token.preview ?? previewMCPToken(token.id.replace(/^mcp:token:/, ''))
}
