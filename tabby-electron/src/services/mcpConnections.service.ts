import * as fs from 'fs/promises'
import { constants as fsConstants } from 'fs'
import * as path from 'path'
import * as os from 'os'
import { randomUUID } from 'crypto'
import { Injectable, Injector } from '@angular/core'
import type { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { AppService, BaseTabComponent, ConfigService, PartialProfile, Profile, ProfilesService } from 'tabby-core'
import type { BaseTerminalTabComponent, BaseSession } from 'tabby-terminal'
import type { SSHProfile, SSHSession, SFTPSession, SSHTabComponent } from 'tabby-ssh'
import { MCPRuntime, MCPOwnedSession, MCPSessionCallbacks, MCPRuntimeProfile, MCP_MAX_FILE_BYTES, decodeMCPFile, publicMCPProfile, readMCPFileChunks, updateMCPProfile, validateMCPFilePath } from '../mcp/runtime'
import { MCPToolError } from '../mcp/tools'

interface ConnectionRef {
    id: string
    type: string
}

interface TransferScope {
    tokenId: string
    active: boolean
    closers: (() => Promise<void>)[]
    terminal?: boolean
}

/** Bridges MCP operations to Tabby without exposing the agent's local paths. */
@Injectable({ providedIn: 'root' })
export class MCPConnectionsService {
    private runtime = new MCPRuntime()
    private transfers = new Set<TransferScope>()
    private configUpdates: Promise<unknown> = Promise.resolve()
    private protectedSessions = new WeakSet<BaseSession>()

    constructor (
        private config: ConfigService,
        private profiles: ProfilesService,
        private injector: Injector,
    ) { }

    async callOperation (
        tokenId: string,
        connection: ConnectionRef,
        name: string,
        args: Record<string, unknown>,
        authorize: () => Promise<boolean>,
    ): Promise<unknown> {
        await this.check(authorize)
        if (name === 'read_connection') {
            return this.runtime.read(tokenId, connection.id, args.sessionId as string, args.cursor as number|undefined, args.maxBytes as number|undefined)
        }
        if (name === 'write_connection') {
            return this.runtime.write(tokenId, connection.id, args.sessionId as string, args.input as string)
        }
        if (name === 'close_connection') {
            return this.runtime.close(tokenId, connection.id, args.sessionId as string)
        }
        if (name === 'open_connection') {
            return this.runtime.open(tokenId, connection.id, callbacks => this.openTerminal(tokenId, connection.id, args, callbacks), authorize)
        }
        if (name === 'update_connection_config') {
            const update = this.configUpdates.then(() => this.updateConfiguration(connection.id, args.changes, authorize))
            this.configUpdates = update.catch(() => undefined)
            return update
        }
        if (name === 'get_connection_config') {
            const profile = await this.getProfile(connection.id)
            await this.check(authorize)
            return publicMCPProfile(this.fullProfile(profile))
        }
        if (name === 'upload_file' || name === 'download_file') {
            return this.transfer(tokenId, connection.id, name === 'upload_file', args, authorize)
        }
        throw new MCPToolError('Unsupported connection operation.')
    }

    async disposeToken (tokenId: string): Promise<void> {
        await Promise.all([
            this.runtime.disposeToken(tokenId),
            ...[...this.transfers].filter(scope => scope.tokenId === tokenId).map(scope => this.disposeTransfer(scope)),
        ])
    }

    async disposeAll (): Promise<void> {
        await Promise.all([this.runtime.disposeAll(), ...[...this.transfers].map(scope => this.disposeTransfer(scope))])
    }

    private async getProfile (id: string): Promise<PartialProfile<Profile>> {
        const profile = (await this.profiles.getProfiles({ clone: true })).find(item => item.id === id && !item.isTemplate)
        if (!profile) { throw new MCPToolError('Connection not found.') }
        return profile
    }

    private fullProfile (profile: PartialProfile<Profile>): Profile {
        // ConfigProxy contains live setters. Snapshot resolved defaults before
        // changing MCP-specific behavior, so the saved user profile stays intact.
        return JSON.parse(JSON.stringify(this.profiles.getConfigProxyForProfile(profile)))
    }

    private async updateConfiguration (id: string, changes: unknown, authorize: () => Promise<boolean>): Promise<unknown> {
        const profile = await this.getProfile(id)
        const updated = updateMCPProfile(profile as MCPRuntimeProfile, changes) as PartialProfile<Profile>
        await this.check(authorize)
        try {
            await this.profiles.writeProfile(updated)
            await this.check(authorize)
            await this.config.save()
        } catch (error) {
            await this.profiles.writeProfile(profile)
            throw error
        }
        return { connectionId: id, updated: true }
    }

    private async openTerminal (tokenId: string, id: string, args: Record<string, unknown>, callbacks: MCPSessionCallbacks): Promise<MCPOwnedSession> {
        const profile = this.fullProfile(await this.getProfile(id))
        profile.behaviorOnSessionEnd = 'close'
        profile.options = { ...profile.options, restoreFromPTYID: null, reuseSession: false }
        const params = await this.profiles.newTabParametersForProfile(profile)
        if (!params) { throw new MCPToolError('This connection does not provide a terminal.') }
        await this.check(callbacks.authorize)
        const state = { closed: false, disposed: false }
        const sshScope: TransferScope = { tokenId, active: true, closers: [], terminal: true }
        if (profile.type === 'ssh') {
            this.transfers.add(sshScope)
            const connect = (target: SSHProfile, promptHandler: (prompt: Parameters<SSHSession['emitKeyboardInteractivePrompt']>[0]) => void) =>
                this.openSSH(target, sshScope, callbacks.authorize, new Set(), promptHandler)
            params.inputs ??= {}
            // Use the tab's connection factory hook to own every SSH transport,
            // including jump hosts and authentication still in progress.
            params.inputs['setupOneSession'] = async function (this: SSHTabComponent, _injector: Injector, target: SSHProfile) {
                return connect(target, prompt => { this.activeKIPrompt = prompt })
            }
        }
        const baseTab = this.injector.get(AppService).openNewTab(params)
        const tab = baseTab as BaseTerminalTabComponent<any>
        if (!tab.sessionChanged$ || !tab.binaryOutput$ || typeof tab.sendInput !== 'function') {
            baseTab.destroy()
            await this.disposeTransfer(sshScope)
            throw new MCPToolError('This connection does not provide a terminal.')
        }
        const protectSession = (value: BaseSession|null) => { if (value) { this.protectPendingSession(value, state) } }
        const subscriptions = [
            tab.binaryOutput$.subscribe(data => callbacks.output(data)),
            tab.destroyed$.subscribe(() => {
                state.closed = true
                callbacks.closed()
                // Buffered output may outlive the tab, but its independent SSH
                // transports (including jump hosts) must not wait for that lease.
                this.disposeTransfer(sshScope).catch(() => undefined)
            }),
            tab.sessionChanged$.subscribe(protectSession),
        ]
        protectSession(tab.session)
        const session: MCPOwnedSession = {
            get open () { return !state.closed && !!tab.session?.open },
            write: input => tab.sendInput(input),
            close: async () => {
                if (state.disposed) { return }
                state.disposed = true
                state.closed = true
                subscriptions.forEach(subscription => subscription.unsubscribe())
                // Explicitly closing the own session cannot offer reconnect or
                // accidentally close a user tab through the closed-tabs stack.
                try {
                    await tab.session?.destroy()
                } finally {
                    // A provider can reject destruction after its native session
                    // has failed. Still close owned transports and remove the tab.
                    await this.disposeTransfer(sshScope)
                    try { await tab.destroy() } catch { BaseTabComponent.prototype.destroy.call(tab) }
                }
            },
        }
        try {
            const deadline = Date.now() + 30000
            while (!session.open) {
                if (state.closed) { throw new MCPToolError('Terminal closed before the connection was ready.') }
                await this.check(callbacks.authorize)
                if (Date.now() >= deadline) { throw new MCPToolError('Terminal connection timed out.') }
                await new Promise<void>(resolve => setTimeout(resolve, 50))
            }
            await this.check(callbacks.authorize)
            tab.session!.resize(args.columns as number|undefined ?? 80, args.rows as number|undefined ?? 24)
            return session
        } catch (error) {
            await session.close()
            throw error
        }
    }

    private protectPendingSession (session: BaseSession, state: { closed: boolean }): void {
        // Some providers publish a session before asynchronous PTY creation has
        // finished. BaseSession.destroy() cannot kill a process not created yet.
        // Defer that one close until start sets open, then close after the startup
        // subscriptions have been installed. This only wraps the owned instance.
        if (this.protectedSessions.has(session)) { return }
        this.protectedSessions.add(session)
        let open = session.open
        const destroy = session.destroy.bind(session)
        session.destroy = async () => {
            if (!state.closed || session.open) { await destroy() }
        }
        Object.defineProperty(session, 'open', {
            configurable: true,
            get: () => open,
            set: (value: boolean) => {
                open = value
                if (value && state.closed) { queueMicrotask(() => destroy().catch(() => undefined)) }
            },
        })
    }

    private async transfer (
        tokenId: string,
        connectionId: string,
        upload: boolean,
        args: Record<string, unknown>,
        authorize: () => Promise<boolean>,
    ): Promise<unknown> {
        if ([...this.transfers].filter(scope => !scope.terminal).length >= 8) { throw new MCPToolError('File transfer limit reached. Try again after a transfer finishes.') }
        const target = validateMCPFilePath(args.path)
        const data = upload ? decodeMCPFile(args.data) : undefined
        const scope: TransferScope = { tokenId, active: true, closers: [] }
        this.transfers.add(scope)
        const guard = async () => scope.active && await authorize()
        try {
            const profile = this.fullProfile(await this.getProfile(connectionId))
            await this.check(guard)
            const result = await this.withTimeout(this.transferProfile(profile, target, data, scope, guard), 'File transfer timed out.')
            await this.check(guard)
            return upload ? { bytes: data!.length } : { data: result!.toString('base64'), encoding: 'base64', bytes: result!.length }
        } finally {
            await this.disposeTransfer(scope)
        }
    }

    private async transferProfile (profile: Profile, target: string, data: Buffer|undefined, scope: TransferScope, authorize: () => Promise<boolean>): Promise<Buffer|undefined> {
        if (profile.type === 'ssh') {
            profile.options.forwardedPorts = []
            profile.options.agentForward = false
            const ssh = await this.openSSH(profile as SSHProfile, scope, authorize, new Set())
            await this.check(authorize)
            const sftp = await ssh.openSFTP()
            return this.sftpTransfer(sftp, target, data, scope, authorize)
        }
        if (profile.type === 'local') {
            return this.localTransfer(this.localPath(profile, target), data, scope, authorize)
        }
        throw new MCPToolError('File transfer is supported only for SSH and local connections.')
    }

    private async openSSH (
        profile: SSHProfile,
        scope: TransferScope,
        authorize: () => Promise<boolean>,
        ancestors: Set<string>,
        promptHandler?: (prompt: Parameters<SSHSession['emitKeyboardInteractivePrompt']>[0]) => void,
    ): Promise<SSHSession> {
        if (ancestors.size >= 8 || (profile.id && ancestors.has(profile.id))) {
            throw new MCPToolError('Invalid SSH jump-host chain.')
        }
        if (profile.id) { ancestors.add(profile.id) }
        await this.check(authorize)
        const session = this.createSSHSession(profile, scope)
        this.own(scope, async () => { await session.destroy() })
        // Stored keyboard-interactive answers can be used without a terminal.
        // A missing answer must fail rather than waiting on an invisible prompt.
        const prompts = session.keyboardInteractivePrompt$.subscribe(prompt => {
            if (!scope.active) { prompt.reject(); return }
            scope.closers.push(async () => { prompt.reject() })
            if (promptHandler) { promptHandler(prompt) } else if (prompt.responses.every(response => response.length > 0)) { prompt.respond() } else { prompt.reject() }
        })
        this.own(scope, async () => { prompts.unsubscribe() })
        if (profile.options.jumpHost) {
            const parent = this.fullProfile(await this.getProfile(profile.options.jumpHost))
            if (parent.type !== 'ssh') { throw new MCPToolError('SSH jump host must be an SSH connection.') }
            if (!scope.terminal) { parent.options.forwardedPorts = []; parent.options.agentForward = false }
            const jump = await this.openSSH(parent as SSHProfile, scope, authorize, ancestors, promptHandler)
            await this.check(authorize)
            if (!('openTCPForwardChannel' in jump.ssh)) { throw new MCPToolError('SSH jump host is not authenticated.') }
            session.jumpChannel = await jump.ssh.openTCPForwardChannel({
                addressToConnectTo: profile.options.host, portToConnectTo: profile.options.port ?? 22,
                originatorAddress: '127.0.0.1', originatorPort: 0,
            })
        }
        await this.check(authorize)
        const starting = session.start()
        starting.finally(async () => {
            // Cancellation may arrive while start is still loading credentials,
            // before SSHSession has assigned the native client it can disconnect.
            if (!scope.active) { await session.destroy().catch(() => undefined) }
        }).catch(() => undefined)
        await this.withTimeout(starting, 'SSH connection timed out.')
        await this.check(authorize)
        return session
    }

    protected createSSHSession (profile: SSHProfile, scope: TransferScope): SSHSession {
        const SSHSessionClass = require('tabby-ssh').SSHSession as typeof SSHSession
        const NgbModalClass = require('@ng-bootstrap/ng-bootstrap').NgbModal as typeof NgbModal
        const modals = this.injector.get(NgbModalClass)
        const ownedInjector = Injector.create({
            parent: this.injector,
            providers: [{
                provide: NgbModalClass,
                useValue: {
                    open: (...args: Parameters<NgbModal['open']>) => {
                        const modal = modals.open(...args)
                        this.own(scope, async () => { modal.dismiss() })
                        return modal
                    },
                },
            }],
        })
        return new SSHSessionClass(ownedInjector, profile)
    }

    protected getSFTPFlags (): { OPEN_READ: number, OPEN_WRITE: number, OPEN_CREATE: number, OPEN_TRUNCATE: number } {
        return require('russh')
    }

    private async sftpTransfer (sftp: SFTPSession, target: string, data: Buffer|undefined, scope: TransferScope, authorize: () => Promise<boolean>): Promise<Buffer|undefined> {
        const flags = this.getSFTPFlags()
        if (!data) {
            const info = await sftp.stat(target)
            if (info.isDirectory) { throw new MCPToolError('Only regular files can be downloaded.') }
            this.checkFileSize(info.size)
        }
        await this.check(authorize)
        const handle = await sftp.open(target, data ? flags.OPEN_WRITE | flags.OPEN_CREATE | flags.OPEN_TRUNCATE : flags.OPEN_READ)
        this.own(scope, () => handle.close())
        if (data) {
            await this.check(authorize)
            await handle.write(data)
            return undefined
        }
        return readMCPFileChunks(() => handle.read(), authorize)
    }

    private localPath (profile: Profile, target: string): string {
        if (profile.options.fsBase) {
            // WSL/guest paths belong to the selected connection. A Windows path
            // must not silently switch that request to the Tabby host filesystem.
            if (target.includes('\\') || /^[A-Za-z]:/.test(target)) {
                throw new MCPToolError('Use a POSIX path for this guest connection.')
            }
            const guestPath = path.posix.resolve(profile.options.cwd ?? '/', target)
            return path.join(profile.options.fsBase, ...guestPath.split('/'))
        }
        return path.resolve(profile.options.cwd ?? os.homedir(), target)
    }

    private async localTransfer (target: string, data: Buffer|undefined, scope: TransferScope, authorize: () => Promise<boolean>): Promise<Buffer|undefined> {
        await this.check(authorize)
        if (data) {
            const temporary = path.join(path.dirname(target), `.tabby-mcp-${randomUUID()}`)
            this.own(scope, async () => { await fs.unlink(temporary).catch(() => undefined) })
            try {
                await this.check(authorize)
                await fs.writeFile(temporary, data, { flag: 'wx', mode: 0o600 })
                await this.check(authorize)
                await fs.rename(temporary, target)
            } finally { await fs.unlink(temporary).catch(() => undefined) }
            return undefined
        }
        // Opening a FIFO in blocking mode would outlive the request timeout and
        // retain a worker thread before fstat could reject the special file.
        const flags = fsConstants.O_RDONLY | (process.platform === 'win32' ? 0 : fsConstants.O_NONBLOCK)
        const handle = await fs.open(target, flags)
        this.own(scope, () => handle.close())
        const info = await handle.stat()
        if (!info.isFile()) { throw new MCPToolError('Only regular files can be downloaded.') }
        this.checkFileSize(info.size)
        const buffer = Buffer.alloc(MCP_MAX_FILE_BYTES + 1)
        let length = 0
        while (true) {
            await this.check(authorize)
            const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
            if (!bytesRead) { break }
            length += bytesRead
            this.checkFileSize(length)
        }
        return buffer.subarray(0, length)
    }

    private checkFileSize (size: number): void {
        if (!Number.isSafeInteger(size) || size < 0 || size > MCP_MAX_FILE_BYTES) {
            throw new MCPToolError('File exceeds the 4 MiB transfer limit.')
        }
    }

    private async check (authorize: () => Promise<boolean>): Promise<void> {
        if (!await authorize()) { throw new MCPToolError('Connection access denied.') }
    }

    private async disposeTransfer (scope: TransferScope): Promise<void> {
        scope.active = false
        this.transfers.delete(scope)
        const closers = scope.closers.splice(0).reverse()
        await Promise.all(closers.map(close => close().catch(() => undefined)))
    }

    private own (scope: TransferScope, close: () => Promise<void>): void {
        if (!scope.active) {
            close().catch(() => undefined)
            throw new MCPToolError('Connection access denied.')
        }
        scope.closers.push(close)
    }

    private async withTimeout<T> (operation: Promise<T>, message: string): Promise<T> {
        let timer: ReturnType<typeof setTimeout>|undefined = undefined
        try {
            return await Promise.race([
                operation,
                new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(() => reject(new MCPToolError(message)), 30000)
                }),
            ])
        } finally { clearTimeout(timer) }
    }
}
