import { marker as _ } from '@biesbjerg/ngx-translate-extract-marker'
import { MCPConnectionCapability, MCPGlobalCapability } from './access'

export const MCP_GLOBAL_CAPABILITIES: MCPGlobalCapability[] = ['connection_operations']

/** Presentation copy is separate from MCP tool descriptions sent to agents. */
export interface MCPCapabilityLabel {
    id: MCPConnectionCapability
    label: string
    description: string
    warning?: string
}

const transferWarning = _('Upload and download are convenience tools, not a file-transfer security boundary. With connection access, an agent may still transfer files through commands or encoded text.')

export const MCP_CAPABILITY_LABELS: MCPCapabilityLabel[] = [
    { id: 'view_config', label: _('View configuration'), description: _('Read the configuration of an included connection without opening a terminal or executing commands.') },
    { id: 'edit_config', label: _('Modify configuration'), description: _('Modify the configuration of an included connection without granting terminal or file-transfer access.') },
    { id: 'access', label: _('Access connection'), description: _('Use this connection through Tabby to execute commands and interact with its terminal.'), warning: _('Commands may read, write, or transfer files. Upload and download tool switches cannot prevent these operations.') },
    { id: 'upload', label: _('Upload'), description: _('Transfer files from the agent to this connection through MCP and Tabby.'), warning: transferWarning },
    { id: 'download', label: _('Download'), description: _('Transfer files from this connection to the agent through Tabby and MCP.'), warning: transferWarning },
]
