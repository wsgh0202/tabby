import { randomUUID } from 'crypto'
import { StringDecoder } from 'string_decoder'
import { MCPToolError } from './tools'

export const MCP_MAX_FILE_BYTES = 4 * 1024 * 1024
export const MCP_MAX_OUTPUT_BYTES = 1024 * 1024
export const MCP_SESSION_IDLE_TIMEOUT = 5 * 60 * 1000

export interface MCPOwnedSession {
    readonly open: boolean
    write: (input: string) => void
    close: () => Promise<void>
}

export interface MCPSessionCallbacks {
    output: (data: Buffer) => void
    closed: () => void
    authorize: () => Promise<boolean>
}

interface SessionEntry {
    tokenId: string
    connectionId: string
    session?: MCPOwnedSession
    authorize: () => Promise<boolean>
    output: Buffer
    decoder: StringDecoder
    firstCursor: number
    lastAccess: number
    active: boolean
    ended: boolean
}

interface RuntimeOptions {
    now?: () => number
    idleTimeout?: number
    outputLimit?: number
    sweepInterval?: number
}

/** Owns only MCP-created terminals; an HTTP transport is not their lifetime. */
export class MCPRuntime {
    private sessions = new Map<string, SessionEntry>()
    private now: () => number
    private idleTimeout: number
    private outputLimit: number
    private sweeping = false

    constructor (options: RuntimeOptions = {}) {
        this.now = options.now ?? Date.now
        this.idleTimeout = options.idleTimeout ?? MCP_SESSION_IDLE_TIMEOUT
        this.outputLimit = options.outputLimit ?? MCP_MAX_OUTPUT_BYTES
        if (options.sweepInterval !== 0) {
            const timer = setInterval(() => this.sweep(), options.sweepInterval ?? 10000) as ReturnType<typeof setInterval>|number
            // Renderer globals return DOM IDs; only Node timer handles support unref.
            if (typeof timer !== 'number') { timer.unref() }
        }
    }

    async open (
        tokenId: string,
        connectionId: string,
        create: (callbacks: MCPSessionCallbacks) => Promise<MCPOwnedSession>,
        authorize: () => Promise<boolean>,
    ): Promise<{ sessionId: string, cursor: number, idleTimeoutMs: number }> {
        if (this.sessions.size >= 32 || [...this.sessions.values()].filter(x => x.tokenId === tokenId).length >= 8) {
            throw new MCPToolError('Terminal session limit reached. Close an existing session first.')
        }
        const entry: SessionEntry = {
            tokenId, connectionId, authorize, output: Buffer.alloc(0), decoder: new StringDecoder('utf8'),
            firstCursor: 0, lastAccess: this.now(), active: true, ended: false,
        }
        const sessionId = randomUUID()
        this.sessions.set(sessionId, entry)
        const guard = async () => entry.active && await authorize()
        try {
            if (!await guard()) { throw new MCPToolError('Connection access denied.') }
            entry.session = await create({
                output: data => this.append(entry, data),
                closed: () => { entry.ended = true },
                authorize: guard,
            })
            if (!await guard()) { throw new MCPToolError('Connection access denied.') }
            return { sessionId, cursor: entry.firstCursor, idleTimeoutMs: this.idleTimeout }
        } catch (error) {
            await this.remove(sessionId, entry)
            throw error
        }
    }

    async read (tokenId: string, connectionId: string, sessionId: string, cursor = 0, maxBytes = 65536): Promise<unknown> {
        const entry = await this.get(tokenId, connectionId, sessionId)
        if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 65536) {
            throw new MCPToolError('Invalid terminal output cursor or size.')
        }
        const endCursor = entry.firstCursor + entry.output.length
        if (cursor > endCursor) { throw new MCPToolError('Terminal output cursor is beyond available output.') }
        const start = Math.max(cursor, entry.firstCursor) - entry.firstCursor
        let end = Math.min(start + maxBytes, entry.output.length)
        // Preserve complete UTF-8 characters even when a read stops inside one.
        while (end > start && end < entry.output.length && (entry.output[end] & 0xc0) === 0x80) { end-- }
        if (end === start && end < entry.output.length) {
            end++
            while (end < entry.output.length && (entry.output[end] & 0xc0) === 0x80) { end++ }
        }
        return {
            output: entry.output.subarray(start, end).toString('utf8'),
            cursor: entry.firstCursor + end,
            hasMore: entry.firstCursor + end < endCursor,
            truncated: cursor < entry.firstCursor,
            open: !entry.ended && !!entry.session?.open,
        }
    }

    async write (tokenId: string, connectionId: string, sessionId: string, input: string): Promise<unknown> {
        if (typeof input !== 'string' || Buffer.byteLength(input) > 65536) {
            throw new MCPToolError('Terminal input exceeds 64 KiB.')
        }
        const entry = await this.get(tokenId, connectionId, sessionId)
        if (entry.ended || !entry.session?.open) { throw new MCPToolError('Terminal session is closed.') }
        entry.session.write(input)
        return { written: Buffer.byteLength(input) }
    }

    async close (tokenId: string, connectionId: string, sessionId: string): Promise<unknown> {
        const entry = await this.get(tokenId, connectionId, sessionId)
        await this.remove(sessionId, entry)
        return { closed: true }
    }

    async disposeToken (tokenId: string): Promise<void> {
        await Promise.all([...this.sessions].filter(([, entry]) => entry.tokenId === tokenId).map(([id, entry]) => this.remove(id, entry)))
    }

    async disposeAll (): Promise<void> {
        await Promise.all([...this.sessions].map(([id, entry]) => this.remove(id, entry)))
    }

    async sweep (): Promise<void> {
        if (this.sweeping) { return }
        this.sweeping = true
        try {
            await Promise.all([...this.sessions].map(async ([id, entry]) => {
                const valid = await entry.authorize().catch(() => false)
                if (!valid || this.now() - entry.lastAccess >= this.idleTimeout) {
                    await this.remove(id, entry)
                }
            }))
        } finally { this.sweeping = false }
    }

    private async get (tokenId: string, connectionId: string, sessionId: string): Promise<SessionEntry> {
        const entry = this.sessions.get(sessionId)
        if (!entry?.active || entry.tokenId !== tokenId || entry.connectionId !== connectionId) {
            throw new MCPToolError('Terminal session not found.')
        }
        if (this.now() - entry.lastAccess >= this.idleTimeout || !await entry.authorize()) {
            await this.remove(sessionId, entry)
            throw new MCPToolError('Connection access denied or terminal session expired.')
        }
        entry.lastAccess = this.now()
        return entry
    }

    private append (entry: SessionEntry, data: Buffer): void {
        if (!entry.active) { return }
        const next = Buffer.concat([entry.output, Buffer.from(entry.decoder.write(data))])
        let drop = Math.max(0, next.length - this.outputLimit)
        while (drop < next.length && (next[drop] & 0xc0) === 0x80) { drop++ }
        entry.firstCursor += drop
        entry.output = next.subarray(drop)
    }

    private async remove (sessionId: string, entry: SessionEntry): Promise<void> {
        entry.active = false
        this.sessions.delete(sessionId)
        const session = entry.session
        entry.session = undefined
        await session?.close().catch(() => undefined)
    }
}

/** Buffer.from(base64) accepts malformed input, so validate before decoding. */
export function decodeMCPFile (value: unknown): Buffer {
    if (typeof value !== 'string' || value.length > Math.ceil(MCP_MAX_FILE_BYTES / 3) * 4
        || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
        throw new MCPToolError('File data must be canonical base64 and at most 4 MiB.')
    }
    const data = Buffer.from(value, 'base64')
    if (data.length > MCP_MAX_FILE_BYTES || data.toString('base64') !== value) {
        throw new MCPToolError('File data must be canonical base64 and at most 4 MiB.')
    }
    return data
}

export function validateMCPFilePath (value: unknown): string {
    if (typeof value !== 'string' || !value.length || value.length > 4096 || value.includes('\0')) {
        throw new MCPToolError('Invalid connection file path.')
    }
    return value
}

/** SFTP reads are bounded even when a file grows after the initial stat. */
export async function readMCPFileChunks (read: () => Promise<Uint8Array>, authorize: () => Promise<boolean>): Promise<Buffer> {
    const chunks: Buffer[] = []
    let length = 0
    while (true) {
        if (!await authorize()) { throw new MCPToolError('Connection access denied.') }
        const chunk = Buffer.from(await read())
        if (!chunk.length) { break }
        length += chunk.length
        if (length > MCP_MAX_FILE_BYTES) { throw new MCPToolError('File exceeds the 4 MiB transfer limit.') }
        chunks.push(chunk)
    }
    if (!await authorize()) { throw new MCPToolError('Connection access denied.') }
    return Buffer.concat(chunks)
}

// Explicit provider fields keep credentials, environment values, CLI arguments,
// private-key locations and unknown plugin-specific secrets out of MCP responses.
const PUBLIC_OPTIONS: Record<string, Record<string, 'string'|'number'|'boolean'>> = {
    ssh: { host: 'string', port: 'number', user: 'string', cwd: 'string', keepaliveInterval: 'number', keepaliveCountMax: 'number', readyTimeout: 'number', x11: 'boolean', agentForward: 'boolean', term: 'string' },
    telnet: { host: 'string', port: 'number' },
    local: { cwd: 'string', pauseAfterExit: 'boolean' },
    serial: { port: 'string', baudrate: 'number', dataBits: 'number', stopBits: 'number', parity: 'string' },
}

export interface MCPRuntimeProfile {
    id?: string
    name: string
    type: string
    group?: string
    icon?: string|null
    color?: string|null
    isBuiltin?: boolean
    isTemplate?: boolean
    options?: Record<string, unknown>
}

export function publicMCPProfile (profile: MCPRuntimeProfile): unknown {
    const fields = PUBLIC_OPTIONS[profile.type] ?? {}
    return {
        id: profile.id, name: profile.name, type: profile.type, group: profile.group ?? '',
        icon: profile.icon ?? null, color: profile.color ?? null, editable: !profile.isBuiltin,
        options: Object.fromEntries(Object.entries(fields).filter(([key, type]) => typeof profile.options?.[key] === type)
            .map(([key]) => [key, profile.options![key]])),
        editableOptions: Object.keys(fields),
    }
}

function isRecord (value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value)
        && [Object.prototype, null].includes(Object.getPrototypeOf(value))
}

export function updateMCPProfile (profile: MCPRuntimeProfile, changes: unknown): MCPRuntimeProfile {
    if (profile.isBuiltin) { throw new MCPToolError('Built-in connections are read-only.') }
    if (!isRecord(changes) || Object.keys(changes).some(key => !['name', 'options'].includes(key))) {
        throw new MCPToolError('Only connection name and supported options can be changed.')
    }
    const result = { ...profile, options: { ...profile.options } }
    if (Object.prototype.hasOwnProperty.call(changes, 'name')) {
        if (typeof changes.name !== 'string' || !changes.name.trim() || changes.name.length > 512) {
            throw new MCPToolError('Connection name must contain 1 to 512 characters.')
        }
        result.name = changes.name
    }
    if (Object.prototype.hasOwnProperty.call(changes, 'options')) {
        if (!isRecord(changes.options)) { throw new MCPToolError('Invalid connection options.') }
        const fields = PUBLIC_OPTIONS[profile.type] ?? {}
        for (const [key, value] of Object.entries(changes.options)) {
            if (!Object.prototype.hasOwnProperty.call(fields, key) || typeof value !== fields[key]
                || (typeof value === 'string' && (value.length > 4096 || value.includes('\0')))
                || (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0))
                || (key === 'port' && typeof value === 'number' && (value < 1 || value > 65535))) {
                throw new MCPToolError('Unsupported connection option or invalid value.')
            }
            result.options[key] = value
        }
    }
    return result
}
