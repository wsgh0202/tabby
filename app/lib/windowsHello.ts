import { app, BrowserWindow, IpcMainInvokeEvent, ipcMain, safeStorage } from 'electron'
import { writeFile } from 'atomically'
import { createHash } from 'node:crypto'
import { readFile, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { configPath } from './config'
import { getWindows10Build } from './windows'
import { logMainError } from './errors'

interface WindowsHello {
    checkAvailability: () => Promise<number>
    verify: (window: Buffer, message: string) => Promise<unknown>
}

// Values returned by the WinRT UserConsentVerifierAvailability enum.
enum ConsentAvailability {
    Available = 0,
    DeviceNotPresent = 1,
    NotConfiguredForUser = 2,
    DisabledByPolicy = 3,
    DeviceBusy = 4,
}

export function registerWindowsHello (): void {
    const windowsBuild = getWindows10Build() ?? 0
    let hello: WindowsHello | undefined = undefined
    try {
        hello = require('./windows-hello.node')
    } catch (error) {
        logMainError('Windows Hello native module failed to load', error)
    }

    const configID = createHash('sha256').update(resolve(configPath).toLowerCase()).digest('hex')
    const credentialPath = join(app.getPath('userData'), `vault-hello-${configID}.bin`)
    const appURL = pathToFileURL(join(app.getAppPath(), 'dist', 'index.html')).href
    let operation = Promise.resolve<unknown>(undefined)
    let lastAvailabilityError: string | undefined = undefined

    function reportAvailabilityError (detail: string): void {
        if (detail !== lastAvailabilityError) {
            logMainError('Windows Hello unavailable', detail)
            lastAvailabilityError = detail
        }
    }

    async function getAvailability (): Promise<boolean> {
        if (!hello) {
            reportAvailabilityError(`Native verifier unavailable on Windows build ${windowsBuild}`)
            return false
        }
        try {
            if (!await safeStorage.isAsyncEncryptionAvailable()) {
                reportAvailabilityError('Windows credential encryption is unavailable')
                return false
            }
            const status = await hello.checkAvailability()
            // A busy device can still be used once Windows queues the verification request.
            if (status === ConsentAvailability.Available || status === ConsentAvailability.DeviceBusy) {
                lastAvailabilityError = undefined
                return true
            }
            reportAvailabilityError(`Windows build ${windowsBuild}, verifier status ${ConsentAvailability[status] ?? `0x${(status >>> 0).toString(16)}`}`)
        } catch (error) {
            reportAvailabilityError(error instanceof Error ? error.message : String(error))
        }
        return false
    }

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
        if (window.isDestroyed() || await hello.verify(window.getNativeWindowHandle(), message) !== true) {
            return false
        }
        return trustedWindow(event) === window
    }

    ipcMain.handle('vault:windows-hello-status', async event => {
        if (!trustedWindow(event)) {
            return { supported: false, available: false, enabled: false }
        }
        const enabled = await stat(credentialPath).then(file => file.isFile(), () => false)
        const available = await getAvailability()
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
