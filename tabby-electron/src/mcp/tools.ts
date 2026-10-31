import { MCPConnectionCapability } from './access'

/** Only deliberately authored, credential-free adapter errors reach MCP clients. */
export class MCPToolError extends Error { }

interface ArgumentSchema {
    type: 'string'|'integer'|'object'
    properties?: Record<string, ArgumentSchema>
    required?: string[]
    additionalProperties?: boolean
    maxLength?: number
    minimum?: number
    maximum?: number
}

export interface MCPToolDefinition {
    name: string
    description: string
    capability?: MCPConnectionCapability
    inputSchema: ArgumentSchema
    annotations: { readOnlyHint: boolean, openWorldHint: boolean }
}

const connectionId: ArgumentSchema = { type: 'string', maxLength: 1024 }
const sessionId: ArgumentSchema = { type: 'string', maxLength: 128 }
const path: ArgumentSchema = { type: 'string', maxLength: 4096 }

function tool (
    name: string,
    description: string,
    properties: Record<string, ArgumentSchema> = {},
    required = Object.keys(properties),
    capability?: MCPConnectionCapability,
    readOnly = true,
): MCPToolDefinition {
    return {
        name, description, capability,
        inputSchema: { type: 'object', properties, required, additionalProperties: false },
        annotations: { readOnlyHint: readOnly, openWorldHint: capability !== undefined },
    }
}

// Protocol descriptions describe the operation. Configuration help and safety
// notices belong to the UI, independently of this model-facing registry.
export const MCP_TOOLS: MCPToolDefinition[] = [
    tool('list_connection_groups', 'List groups containing accessible connections.'),
    tool('list_connections', 'List accessible connections.'),
    tool('list_group_connections', 'List accessible connections in a group.', { groupId: connectionId }),
    tool('get_connection_config', 'Read a connection configuration without credentials.', { connectionId }, undefined, 'view_config'),
    tool('update_connection_config', 'Update a saved connection configuration.', {
        connectionId,
        changes: {
            type: 'object',
            properties: { name: { type: 'string', maxLength: 512 }, options: { type: 'object' } },
            additionalProperties: false,
        },
    }, undefined, 'edit_config', false),
    tool('open_connection', 'Open a terminal connection. Returns a session ID and output cursor.', {
        connectionId,
        columns: { type: 'integer', minimum: 1, maximum: 500 },
        rows: { type: 'integer', minimum: 1, maximum: 300 },
    }, ['connectionId'], 'access', false),
    tool('read_connection', 'Read terminal output from a session cursor.', {
        connectionId, sessionId,
        cursor: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        maxBytes: { type: 'integer', minimum: 1, maximum: 65536 },
    }, ['connectionId', 'sessionId'], 'access'),
    tool('write_connection', 'Send text input to a terminal session.', {
        connectionId, sessionId, input: { type: 'string', maxLength: 65536 },
    }, undefined, 'access', false),
    tool('close_connection', 'Close a terminal session.', { connectionId, sessionId }, undefined, 'access', false),
    tool('upload_file', 'Write base64 file data to a connection path. Maximum file size: 4 MiB.', {
        connectionId, path, data: { type: 'string', maxLength: 5592408 },
    }, undefined, 'upload', false),
    tool('download_file', 'Read a file from a connection path as base64 data. Maximum file size: 4 MiB.', {
        connectionId, path,
    }, undefined, 'download'),
]

/** Match the advertised schemas before invoking an adapter or loading profiles. */
export function validateMCPToolArguments (definition: MCPToolDefinition, args: Record<string, unknown>): void {
    const validate = (schema: ArgumentSchema, value: unknown): boolean => {
        if (schema.type === 'string') {
            return typeof value === 'string' && value.length <= (schema.maxLength ?? Infinity)
        }
        if (schema.type === 'integer') {
            return typeof value === 'number' && Number.isSafeInteger(value)
                && value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity)
        }
        if (!value || typeof value !== 'object' || Array.isArray(value)) { return false }
        const record = value as Record<string, unknown>
        if ((schema.required ?? []).some(key => !Object.prototype.hasOwnProperty.call(record, key))) { return false }
        return Object.entries(record).every(([key, item]) => {
            if (['__proto__', 'constructor', 'prototype'].includes(key)) { return false }
            const child = schema.properties?.[key]
            return child ? validate(child, item) : schema.additionalProperties !== false
        })
    }
    if (!validate(definition.inputSchema, args)) { throw new Error('Invalid tool arguments') }
}
