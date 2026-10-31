import { Injectable } from '@angular/core'
import { SettingsTabProvider } from 'tabby-settings'
import { MCPSettingsTabComponent } from './components/mcpSettingsTab.component'

/** @hidden */
@Injectable()
export class MCPSettingsTabProvider extends SettingsTabProvider {
    id = 'mcp'
    icon = 'network-wired'
    title = 'MCP'

    getComponentType (): typeof MCPSettingsTabComponent {
        return MCPSettingsTabComponent
    }
}
