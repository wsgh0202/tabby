import { execFile } from 'child_process'
import { isIP } from 'net'
import { networkInterfaces } from 'os'
import { join } from 'path'
import { DEFAULT_MCP_HOST, formatMCPAddress, getMCPMappedIPv4Address, normalizeMCPHost } from './listenAddress'

export interface MCPInterfaceAddress {
    host: string
    interfaceName: string
}

export interface MCPListenEndpoint {
    host: string
    port: number|string
    dualStack?: boolean
}

export function getMCPInterfaceAddresses (interfaces = networkInterfaces()): MCPInterfaceAddress[] {
    const addresses = new Map<string, MCPInterfaceAddress>()
    for (const [interfaceName, entries] of Object.entries(interfaces)) {
        for (const entry of entries ?? []) {
            // An HTTP URL cannot represent an IPv6 address that requires a zone.
            if (entry.internal || ('scopeid' in entry && entry.scopeid !== 0) || entry.address.includes('%')) { continue }
            const host = normalizeMCPHost(entry.address)
            if (!addresses.has(host)) { addresses.set(host, { host, interfaceName }) }
        }
    }
    return [...addresses.values()]
}

export function getMCPServiceAddresses (
    { host: listenHost, port, dualStack }: MCPListenEndpoint,
    interfaces: readonly MCPInterfaceAddress[],
    defaultInterface: string|null,
): { url: string, host: string, interfaceName?: string, isDefault?: boolean }[] {
    const host = getMCPMappedIPv4Address(listenHost) ?? listenHost
    const destinations: { host: string, interfaceName?: string }[] = []
    if (host === '0.0.0.0' || (host === '::' && dualStack)) {
        const ipv4 = interfaces.filter(entry => isIP(entry.host) === 4)
        destinations.push(...ipv4.filter(entry => entry.interfaceName === defaultInterface),
            { host: DEFAULT_MCP_HOST }, ...ipv4.filter(entry => entry.interfaceName !== defaultInterface))
    }
    if (host === '::') {
        destinations.push({ host: '::1' }, ...interfaces.filter(entry => isIP(entry.host) === 6))
    } else if (host !== '0.0.0.0') {
        destinations.push(interfaces.find(address => address.host === host) ?? { host })
    }
    return destinations.map(address => ({
        url: formatMCPAddress(address.host, port),
        host: address.host,
        interfaceName: address.interfaceName,
        isDefault: address.interfaceName === defaultInterface,
    }))
}

function readRoute (program: string, args: string[]): Promise<string> {
    return new Promise(resolve => {
        execFile(program, args, { timeout: 3500, windowsHide: true }, (error, stdout) => resolve(error ? '' : stdout))
    })
}

function lowestMetricInterface (routes: { name?: string, metric: number }[]): string|null {
    const lowest = Math.min(...routes.map(route => route.metric))
    const names = new Set(routes.filter(route => route.metric === lowest).map(route => route.name))
    return names.size === 1 ? [...names][0] ?? null : null
}

export async function getMCPDefaultInterface (interfaces: readonly MCPInterfaceAddress[]): Promise<string|null> {
    if (process.platform === 'darwin') {
        const output = await readRoute('/sbin/route', ['-n', 'get', '-inet', 'default'])
        return /^\s*interface:\s*(\S+)/m.exec(output)?.[1] ?? null
    }
    if (process.platform === 'win32') {
        const route = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'route.exe')
        const output = await readRoute(route, ['print', '-4'])
        // The active route includes an interface IP. Persistent routes omit
        // that column, and localized table headings are irrelevant here.
        const defaultName = lowestMetricInterface(output.split(/\r?\n/).flatMap(line => {
            const match = /^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+.+?\s+(\d+\.\d+\.\d+\.\d+)\s+(\d+)\s*$/.exec(line)
            if (!match) { return [] }
            const name = interfaces.find(entry => entry.host === match[1])?.interfaceName ?? match[1]
            return [{ name, metric: Number(match[2]) }]
        }))
        return interfaces.some(entry => entry.interfaceName === defaultName) ? defaultName : null
    }
    if (process.platform === 'linux') {
        const output = await readRoute('ip', ['-4', 'route', 'show', 'default'])
        return lowestMetricInterface(output.split('\n').flatMap(line => {
            if (!line.startsWith('default ') || /\blinkdown\b/.test(line)) { return [] }
            const name = /\bdev\s+(\S+)/.exec(line)?.[1]
            const metric = Number(/\bmetric\s+(\d+)/.exec(line)?.[1] ?? 0)
            return [{ name: /\bnexthop\b/.test(line) ? undefined : name, metric }]
        }))
    }
    return null
}
