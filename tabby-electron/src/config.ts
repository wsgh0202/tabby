import { ConfigProvider, Platform } from 'tabby-core'
import { DEFAULT_MCP_HOST } from './mcp/listenAddress'

/** @hidden */
export class ElectronConfigProvider extends ConfigProvider {
    platformDefaults = {
        [Platform.macOS]: {
            hotkeys: {
                'toggle-window': ['Ctrl-Space'],
                'new-window': ['⌘-N'],
            },
        },
        [Platform.Windows]: {
            hotkeys: {
                'toggle-window': ['Ctrl-Space'],
                'new-window': ['Ctrl-Shift-N'],
            },
        },
        [Platform.Linux]: {
            hotkeys: {
                'toggle-window': ['Ctrl-Space'],
                'new-window': ['Ctrl-Shift-N'],
            },
        },
    }

    defaults = {
        mcp: {
            enabled: false,
            host: DEFAULT_MCP_HOST,
            port: null,
            lastRandomPort: null,
            tokens: [],
        },
    }
}
