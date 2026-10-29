import type { IncomingMessage, ServerResponse } from 'http'

// Angular 15 requires TypeScript 4.9, while current SDK declarations import Zod 4's
// TypeScript 5 syntax. Keep that compiler boundary here; the SDK still owns all
// protocol parsing and transport handling. Integration tests exercise this API.
interface SDKTransport {
    handleRequest: (request: IncomingMessage, response: ServerResponse) => Promise<void>
}

interface SDKServer {
    connect: (transport: SDKTransport) => Promise<void>
    close: () => Promise<void>
    setRequestHandler: (schema: unknown, handler: (request: {
        params: { name: string, arguments?: Record<string, unknown> }
    }) => Promise<object>) => void
}

export const { Server } = require('@modelcontextprotocol/sdk/server/index.js') as {
    Server: new (info: { name: string, version: string }, options: { capabilities: { tools: object } }) => SDKServer
}

export const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js') as {
    StreamableHTTPServerTransport: new (options: { sessionIdGenerator: undefined, enableJsonResponse: boolean }) => SDKTransport
}

export const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js') as {
    CallToolRequestSchema: unknown
    ListToolsRequestSchema: unknown
}
