# Connecting agents to Tabby

The desktop app includes a Model Context Protocol (MCP) server using the official
TypeScript SDK and Streamable HTTP. Open **Settings → MCP** to configure it.

1. Configure a master passphrase in **Settings → Vault** if you have not already.
2. In **MCP**, create a token and select its tools, groups and connections. A name
   is optional; unnamed tokens are displayed using their first eight and last
   four characters, with the middle omitted.
3. Copy the token before dismissing the result. The original token is shown once;
   Tabby stores its SHA-256 hash in the encrypted vault and a shortened display
   preview in configuration. The preview cannot be used to authenticate.
4. Enable the server and copy the running address. Leave the port empty for an
   automatic port, or enter a port from 1 to 65535 and click **Apply**.
5. Configure your agent to use Streamable HTTP with the copied address and an
   `Authorization: Bearer TOKEN` header. Keep the vault in the main window unlocked
   while using MCP.

For clients supporting this configuration format:

```json
{
  "mcpServers": {
    "tabby": {
      "type": "http",
      "url": "http://127.0.0.1:PORT/mcp",
      "headers": {
        "Authorization": "Bearer TOKEN"
      }
    }
  }
}
```

Replace `PORT` and `TOKEN` with the values from Settings. Client configuration
formats vary; the endpoint and authorization header are the same.

The server listens on IPv4 loopback only. A blank port reuses the last automatic
port if available, otherwise the operating system selects a free port. A manually
configured occupied port reports an error. The server runs in the main window;
closing it transfers ownership to a remaining window. Disabling the switch stops
the listener and closes active requests.

## Tools and permissions

Each token has its own tool allowlist. New tokens grant no tools or connections by
default. Edit a token's permissions at any time or revoke it from the token list.
Every `tools/list` request reflects current grants, and every call checks the grants
again. Clients should refresh their tool list after changing permissions. There are
no persistent MCP sessions.

| Tool | Arguments | Returns |
| --- | --- | --- |
| `list_connection_groups` | None | Accessible groups: `id`, `name` |
| `list_connections` | None | Accessible connections: `id`, `name`, `type`, `group` |
| `list_group_connections` | `groupId` (string) | Accessible connections in that group |

The catalog includes saved connections and built-in profiles with stable IDs;
templates are excluded. Built-in and ungrouped entries use the groups shown by
Tabby's profile service. Results never include profile options, group defaults,
passwords or private keys.

Group and connection selections are independent and additive:

- **All groups** grants every group and its current and future connections.
- **Custom groups** grants the checked groups and their current and future
  connections. Nested groups must be checked separately.
- **All connections** grants all current and future connections and makes their
  groups visible. Empty groups still require a group grant.
- **Custom connections** grants only the checked connection IDs. Their groups
  become visible, but listing those groups returns only accessible connections.

Supplying a group ID or other arguments cannot expand these permissions. Unknown
and inaccessible group IDs both return an error.

## Vault storage

Each credential is a `custom:password` secret with an ID of
`mcp:token:<SHA-256 hash>` and a description of `MCP token: <name>`. Its value is
the token hash. Token names and access policies are stored in Tabby's configuration;
the credential must also exist in the vault for authentication to succeed.

Requests received while the vault is locked are rejected without opening an unlock
dialog. Unlock it locally from **Settings → MCP**. Deleting a credential from the
Vault page also invalidates that token. A displayed hash cannot be used as a token.

## Development

Run `npm run test:mcp` with Node.js 22 or newer. Tests bind temporary loopback ports
and exercise the real SDK transport, token lifecycle, permission filtering and
server configuration. The SDK adapter in `tabby-electron/src/mcp/sdk.ts` isolates
current SDK/Zod declarations from Angular 15's TypeScript 4.9 compiler; all protocol
and transport handling remains in the official SDK.
