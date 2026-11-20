import { app, BrowserWindow, IpcMainInvokeEvent, ipcMain, safeStorage } from 'electron'
import { writeFile } from 'atomically'
import { createHash } from 'node:crypto'
import { readFile, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { configPath } from './config'
import { isWindowsBuild } from './windows'

interface WindowsHello {
    verify: (window?: Buffer, message?: string) => Promise<boolean>
}

export function registerWindowsHello (): void {
    let hello: WindowsHello | undefined = undefined
    if (isWindowsBuild(22000)) {
        try {
            hello = require('./windows-hello.node')
        } catch {
            // The vault must remain usable if the native module is unavailable.
        }
    }

    const configID = createHash('sha256').update(resolve(configPath).toLowerCase()).digest('hex')
    const credentialPath = join(app.getPath('userData'), `vault-hello-${configID}.bin`)
    const appURL = pathToFileURL(join(app.getAppPath(), 'dist', 'index.html')).href
    let operation = Promise.resolve<unknown>(undefined)

    function trustedWindow (event: IpcMainInvokeEvent): BrowserWindow | null {
        const frame = event.senderFrame
        if (!frame || frame.parent !== null || frame.url.split('#')[0] !== appURL) {
            return null
        }
        return BrowserWindow.fromWebContents(event.sender)
    }

    function serialize<T> (callback: () => Promise<T>): Promise<T> {
        const result = operation.then(callback)
        operation = result.catch(() => undefined)
        return result
    }

    async function verify (event: IpcMainInvokeEvent, message: string): Promise<boolean> {
        const window = trustedWindow(event)
        if (!window?.isFocused() || !hello || !await safeStorage.isAsyncEncryptionAvailable()) {
            return false
        }
        if (window.isDestroyed() || !await hello.verify(window.getNativeWindowHandle(), message)) {
            return false
        }
        return trustedWindow(event) === window
    }

    ipcMain.handle('vault:windows-hello-status', async event => {
        if (!trustedWindow(event)) {
            return { supported: false, available: false, enabled: false }
        }
        const enabled = await stat(credentialPath).then(file => file.isFile(), () => false)
        const available = await (async () => Boolean(hello && await safeStorage.isAsyncEncryptionAvailable() && await hello.verify()))().catch(() => false)
        return { supported: true, available, enabled }
    })

    ipcMain.handle('vault:windows-hello-enroll', (event, passphrase: unknown) => serialize(async () => {
        if (typeof passphrase !== 'string' || !passphrase || !await verify(event, 'Enable Windows Hello for the Tabby vault')) {
            return false
        }
        // DPAPI protects this local-only file. Tabby separately requires Hello before reading it.
        await writeFile(credentialPath, await safeStorage.encryptStringAsync(passphrase))
        return true
    }))

    ipcMain.handle('vault:windows-hello-unlock', event => serialize(async () => {
        try {
            if (!await verify(event, 'Unlock the Tabby vault')) {
                return null
            }
            const { result } = await safeStorage.decryptStringAsync(await readFile(credentialPath))
            return trustedWindow(event) ? result : null
        } catch {
            return null
        }
    }))

    ipcMain.handle('vault:windows-hello-revoke', event => serialize(async () => {
        if (trustedWindow(event)) {
            await rm(credentialPath, { force: true })
        }
    }))
}
