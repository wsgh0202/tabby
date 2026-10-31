import { createServer, IncomingMessage, Server as HTTPServer, ServerResponse } from 'http'
import { Server, StreamableHTTPServerTransport, CallToolRequestSchema, ListToolsRequestSchema } from './sdk'
import { callMCPTool, MCPCatalog, MCP_TOOLS } from './access'
import { MCPToken } from './tokens'

export interface MCPServerOptions {
    authenticate: (token: string) => Promise<MCPToken|null>
    getCatalog: () => Promise<MCPCatalog>
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
        // This server has no long-lived sessions or unsolicited streams.
        if (request.method !== 'POST') {
            response.setHeader('Allow', 'POST')
            response.writeHead(405).end()
            return
        }
        const server = new Server({ name: 'tabby', version: '1.0.0' }, { capabilities: { tools: {} } })
        server.setRequestHandler(ListToolsRequestSchema, async () => {
            const token = await authorize()
            if (!token) { throw new Error('Token access denied') }
            return {
                tools: MCP_TOOLS.filter(tool => token.tools.includes(tool.name)).map(tool => ({
                    ...tool,
                    inputSchema: tool.name === 'list_group_connections'
                        ? { type: 'object' as const, properties: { groupId: { type: 'string' } }, required: ['groupId'], additionalProperties: false }
                        : { type: 'object' as const, properties: {}, additionalProperties: false },
                    annotations: { readOnlyHint: true, openWorldHint: false },
                })),
            }
        })
        server.setRequestHandler(CallToolRequestSchema, async message => {
            try {
                const initialToken = await authorize()
                if (!initialToken?.tools.includes(message.params.name)) { throw new Error('Tool access denied') }
                const catalog = await this.options.getCatalog()
                const token = await authorize()
                if (!token) { throw new Error('Token access denied') }
                const result = callMCPTool(token, catalog, message.params.name, message.params.arguments ?? {})
                return { content: [{ type: 'text', text: JSON.stringify(result) }] }
            } catch {
                return { isError: true, content: [{ type: 'text', text: 'Tool denied or invalid arguments' }] }
            }
        })
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
        response.once('close', () => { server.close().catch(() => undefined) })
        await server.connect(transport)
        await transport.handleRequest(request, response)
    }
}
