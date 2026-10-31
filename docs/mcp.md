# Connecting agents to Tabby

The desktop app includes a Model Context Protocol (MCP) server using the official
TypeScript SDK and Streamable HTTP. Open **Settings → MCP** to configure it.

1. Configure a master passphrase in **Settings → Vault** if you have not already.
2. In **MCP**, create a token, enable **Connection operations**, and configure its
   connections and capabilities. A name is optional; unnamed tokens are displayed
   using their first eight and last four characters, with the middle omitted.
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

New tokens grant no capabilities or connections. **Connection operations** is a
global capability package; its configuration opens in a separate, scrollable
dialog. The group tree follows Tabby's connection configuration and shows the
number of selected connections out of all connections in each group, including
subgroups. Token details keep **General** and **Tool capabilities** in the same
scrolling form. Closing a modified token draft asks whether to discard it, and a
failed save keeps the draft open for retrying.

Connection selection controls which connections the agent can discover and use.
It is independent of the five capabilities below. A selected connection can appear
in directory results with every capability disabled; reading its configuration
still requires **View configuration**. Deselecting a connection retains its
capability overrides but denies all operations on it. Selecting a group toggles
its existing descendant connections; it does not select future connections.

| Capability | Tools |
| --- | --- |
| View configuration | `get_connection_config` |
| Edit configuration | `update_connection_config` |
| Access connection | `open_connection`, `read_connection`, `write_connection`, `close_connection` |
| Upload | `upload_file` |
| Download | `download_file` |

The package also includes three directory tools, which are always available while
the package is enabled:

| Tool | Arguments | Returns |
| --- | --- | --- |
| `list_connection_groups` | None | Groups containing selected connections and their ancestors: `id`, `name`, optional `parentId` |
| `list_connections` | None | Selected connections: `id`, `name`, `type`, `group` |
| `list_group_connections` | `groupId` | Selected connections directly in that group |

Only selected connections make their groups visible. Empty groups and unrelated
groups are omitted. A visible ancestor does not expose its unselected connections.
The catalog includes saved connections and built-in profiles with stable IDs;
templates are excluded. Built-in and ungrouped entries use the groups shown by
Tabby's profile service. Directory results omit profile options, group defaults,
credentials and UI icon data. Unknown and inaccessible group IDs both return an
error. Supplying a known connection ID cannot bypass selection or capability
checks.

Root groups have independent capability switches, disabled by default. Each
capability on a subgroup or connection has three states: **Inherited**,
**Independent enabled**, and **Independent disabled**. Inherited capabilities
follow the direct parent group, continuing through its ancestors as needed.
Explicitly disabling a capability keeps it disabled when parent settings change.
Group templates supply defaults to new connections, which remain unselected
until explicitly included.

**Reset** in the group toolbar removes capability overrides from selected
connections in the current group and its descendants. It preserves connection
selection, group templates and overrides on unselected connections. The reset icon
on a connection row removes only that connection's overrides, including retained
overrides on an unselected connection. **Batch configuration** opens a separate
dialog with a snapshot of the selected targets. Applying it writes independent
capability values to those connections without changing group templates or
selection; canceling or closing it preserves the parent draft. Confirm connection
configuration and then save the token to persist changes.

Every `tools/list` request reflects the current policy. Operation tools are listed
when at least one selected connection grants the corresponding capability. Every
call checks the requested connection again, so a listed tool does not grant access
to other connections. Clients should refresh their tool list after changing
permissions. The HTTP transport is stateless; application-level terminal sessions
have their own IDs and lifetime.

## Connection configuration

`get_connection_config` takes `connectionId` and returns the connection's permitted
configuration fields. `update_connection_config` takes `connectionId` and a
`changes` object containing `name` and/or supported `options`. Configuration
fields are not returned by the update tool; it only confirms the successful edit.
This keeps configuration reading independent from configuration modification.
Provider-specific allowlists limit configuration fields that can be read or
changed. Credentials, private keys, environment variables and arbitrary
command-line arguments are not returned. Built-in connections are read-only. Unsupported profile providers expose
metadata and support renaming saved connections, without exposing their options.

## Terminal sessions

`open_connection` takes `connectionId` and optional `columns` and `rows`. It opens a
new terminal owned by the calling token and returns `sessionId`, `cursor` and
`idleTimeoutMs`. It never reuses a terminal opened by the user or another token.

Pass both `connectionId` and `sessionId` to subsequent operations:

- `write_connection` sends the `input` string to the terminal. Include a newline
  when sending a command that should run immediately.
- `read_connection` takes an optional `cursor` and `maxBytes` (1–65,536). It returns
  `output`, the next `cursor`, `hasMore`, `truncated` and `open`. Start with the
  cursor returned by `open_connection`, then use each read's returned cursor. The
  cursor counts UTF-8 bytes. A read preserves complete characters, so it can exceed
  `maxBytes` by up to three bytes.
- `close_connection` closes that token's terminal session.

This supports commands such as `tail -f`: start the command with
`write_connection`, poll `read_connection` for new output, then close the session
when finished. Only the latest 1 MiB of terminal output is retained. A stale cursor
reports `truncated` and resumes from the retained output. Sessions expire after
five minutes without an agent read or write. Limits are eight sessions per token
and 32 in total. Current selection and access permission are checked on requests
and periodically while sessions remain open. Saving token edits, revoking a token
or stopping the MCP server closes its managed terminals.

## File transfer

For MCP file operations, the local file belongs to the **agent**, and the target
path belongs to the **connection opened by Tabby**. The agent sends file content
through MCP; a path on the agent's computer is never interpreted as a path on the
Tabby host.

`upload_file` takes `connectionId`, target `path` and canonical base64 `data`.
`download_file` takes `connectionId` and source `path`, returning base64 content.
Each operation is limited to 4 MiB of decoded file content. SSH connections use
SFTP and local terminal connections use the Tabby host's filesystem, with WSL path
mapping where available. Other connection types report that file transfer is
unsupported. File transfer does not require the terminal access capability.
Transfers use the connection's configured SSH authentication. Keyboard-interactive
authentication without stored answers must be configured locally before a
headless file transfer can succeed.

Upload and download capabilities gate these convenience tools. They do not isolate
file access performed through a terminal: commands, programs and text encodings
can transfer binary data through ordinary terminal input and output. Granting
terminal access therefore permits operations that can bypass restrictions on the
dedicated file tools. The settings dialog explains this limitation; MCP tool
descriptions contain concise operation details rather than UI warning text.

## Vault storage

Each credential is a `custom:password` secret with an ID of
`mcp:token:<SHA-256 hash>` and a description of `MCP token: <name>`. Its value is
the token hash. The description records the creation label (name or shortened
token). Display names and access policies are stored in Tabby's configuration;
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
