import { createServer, IncomingMessage, Server as HTTPServer, ServerResponse } from 'http'
import { Server, StreamableHTTPServerTransport, CallToolRequestSchema, ListToolsRequestSchema } from './sdk'
import { callMCPTool, canAccessConnection, MCPCatalog, MCPConnection, resolveMCPConnectionCapability } from './access'
import { MCP_TOOLS, MCPToolError, validateMCPToolArguments } from './tools'
import { MCPToken } from './tokens'

export interface MCPServerOptions {
    authenticate: (token: string) => Promise<MCPToken|null>
    getCatalog: () => Promise<MCPCatalog>
    callOperation?: (tokenId: string, connection: MCPConnection, name: string, args: Record<string, unknown>, authorize: () => Promise<boolean>) => Promise<unknown>
    disposeOperations?: () => Promise<void>
}

/** Stateless SDK transports keep every request bound to its current bearer token. */
export class MCPHTTPServer {
    port: number|null = null
    private http: HTTPServer|null = null
    private active = false

    constructor (private options: MCPServerOptions) { }

    get address (): string|null {
        return this.port === null ? null : `http://127.0.0.1:${this.port}/mcp`
    }

    async start (port: number|null, lastRandomPort: number|null): Promise<number> {
        if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) {
            throw new Error('MCP port must be between 1 and 65535')
        }
        await this.stop()
        const preferred = port ?? (Number.isInteger(lastRandomPort) && lastRandomPort! > 0 && lastRandomPort! <= 65535 ? lastRandomPort! : 0)
        try {
            await this.listen(preferred)
        } catch (error) {
            if (port !== null || error.code !== 'EADDRINUSE' || !preferred) {
                throw error
            }
            await this.listen(0)
        }
        this.active = true
        return this.port!
    }

    async stop (): Promise<void> {
        this.active = false
        const http = this.http
        this.http = null
        this.port = null
        if (http) {
            await new Promise<void>(resolve => {
                http.close(() => resolve())
                http.closeAllConnections()
            })
        }
        await this.options.disposeOperations?.()
    }

    private async listen (port: number): Promise<void> {
        const http = createServer((request, response) => {
            this.handle(request, response).catch(() => {
                // Never log request headers or SDK errors containing untrusted request data.
                if (!response.headersSent) {
                    response.writeHead(503).end('MCP request failed')
                } else {
                    response.end()
                }
            })
        })
        http.requestTimeout = 15000
        http.headersTimeout = 10000
        await new Promise<void>((resolve, reject) => {
            http.once('error', reject)
            http.listen(port, '127.0.0.1', () => {
                http.removeListener('error', reject)
                resolve()
            })
        })
        const address = http.address()
        if (!address || typeof address === 'string') {
            throw new Error('Could not determine MCP port')
        }
        this.http = http
        this.port = address.port
    }

    private async handle (request: IncomingMessage, response: ServerResponse): Promise<void> {
        response.setHeader('Cache-Control', 'no-store')
        const allowedHosts = [`127.0.0.1:${this.port}`, `localhost:${this.port}`]
        const allowedOrigins = allowedHosts.map(host => `http://${host}`)
        if (!allowedHosts.includes(request.headers.host ?? '')
            || (request.headers.origin !== undefined && !allowedOrigins.includes(request.headers.origin))) {
            response.writeHead(403).end('Forbidden host or origin')
            return
        }
        if (request.url !== '/mcp') {
            response.writeHead(404).end()
            return
        }
        const authorization = request.headers.authorization ?? ''
        const match = /^Bearer ([a-f0-9]{64})$/i.exec(authorization)
        const bearer = match?.[1]
        const listener = this.http
        const authorize = async () => {
            if (!this.active || !bearer) { return null }
            const token = await this.options.authenticate(bearer)
            return this.http === listener ? token : null
        }
        if (!await authorize()) {
            response.setHeader('WWW-Authenticate', 'Bearer realm="Tabby MCP"')
            response.writeHead(401).end('Invalid token or locked vault')
            return
        }
        // HTTP transports remain stateless. Owned terminal sessions use explicit
        // IDs/cursors and bounded idle leases rather than transport lifetime.
        if (request.method !== 'POST') {
            response.setHeader('Allow', 'POST')
            response.writeHead(405).end()
            return
        }
        const server = new Server({ name: 'tabby', version: '1.0.0' }, { capabilities: { tools: {} } })
        server.setRequestHandler(ListToolsRequestSchema, async () => {
            const token = await authorize()
            if (!token) { throw new Error('Token access denied') }
            const catalog = await this.options.getCatalog()
            const current = await authorize()
            if (!current) { throw new Error('Token access denied') }
            return {
                tools: MCP_TOOLS.filter(tool => current.capabilities.includes('connection_operations')
                    && (!tool.capability || catalog.connections.some(connection => canAccessConnection(current, connection)
                        && resolveMCPConnectionCapability(current, catalog, connection.id, tool.capability!))))
                    .map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })),
            }
        })
        server.setRequestHandler(CallToolRequestSchema, async message => {
            try {
                const initialToken = await authorize()
                const definition = MCP_TOOLS.find(tool => tool.name === message.params.name)
                if (!initialToken?.capabilities.includes('connection_operations') || !definition) { throw new Error('Tool access denied') }
                const args = message.params.arguments ?? {}
                validateMCPToolArguments(definition, args)
                const catalog = await this.options.getCatalog()
                const token = await authorize()
                if (!token) { throw new Error('Token access denied') }
                let result: unknown = null
                if (!definition.capability) {
                    result = callMCPTool(token, catalog, definition.name, args)
                } else {
                    const connection = catalog.connections.find(item => item.id === args.connectionId)
                    if (!connection || !this.options.callOperation) { throw new Error('Connection access denied') }
                    const canOperate = async () => {
                        const currentToken = await authorize()
                        if (!currentToken || currentToken.id !== token.id) { return false }
                        const currentCatalog = await this.options.getCatalog()
                        const checkedToken = await authorize()
                        const target = currentCatalog.connections.find(item => item.id === connection.id)
                        return !!checkedToken && checkedToken.id === token.id && !!target && target.type === connection.type
                            && canAccessConnection(checkedToken, target)
                            && resolveMCPConnectionCapability(checkedToken, currentCatalog, target.id, definition.capability!)
                    }
                    if (!await canOperate()) { throw new Error('Connection access denied') }
                    result = await this.options.callOperation(token.id, connection, definition.name, args, canOperate)
                    // A completed read must not expose data after a permission change.
                    if (!await canOperate()) { throw new Error('Connection access denied') }
                }
                return { content: [{ type: 'text', text: JSON.stringify(result) }] }
            } catch (error) {
                return { isError: true, content: [{ type: 'text', text: error instanceof MCPToolError ? error.message : 'Tool denied or invalid arguments' }] }
            }
        })
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
        response.once('close', () => { server.close().catch(() => undefined) })
        await server.connect(transport)
        await transport.handleRequest(request, response)
    }
}
