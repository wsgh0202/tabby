import { Component, ViewChild, ElementRef } from '@angular/core'
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap'
import { PlatformService } from '../api/platform'

/** @hidden */
@Component({
    templateUrl: './unlockVaultModal.component.pug',
})
export class UnlockVaultModalComponent {
    passphrase: string
    rememberFor = 1
    rememberOptions = [1, 5, 15, 60, 1440, 10080]
    validateWindowsHelloPassphrase?: (passphrase: string) => Promise<void>
    windowsHelloEnabled = false
    windowsHelloPending = false
    windowsHelloFailed = false
    @ViewChild('input') input: ElementRef

    constructor (
        private modalInstance: NgbActiveModal,
        private platform: PlatformService,
    ) { }

    ngOnInit (): void {
        const stored = window.localStorage.vaultRememberPassphraseFor
        if (stored === undefined || stored === null || stored === '') {
            this.rememberFor = 1
        } else {
            const parsed = parseInt(stored, 10)
            this.rememberFor = isNaN(parsed) ? 1 : parsed
        }
        setTimeout(() => {
            this.input.nativeElement.focus()
        })
        void this.platform.getVaultWindowsHelloStatus().then(status => {
            this.windowsHelloEnabled = status.available && status.enabled && !!this.validateWindowsHelloPassphrase
        }).catch(() => {
            this.windowsHelloEnabled = false
        })
    }

    ok (): void {
        if (this.windowsHelloPending) {
            return
        }
        this.unlock(this.passphrase)
    }

    async unlockWithWindowsHello (): Promise<void> {
        if (!this.windowsHelloEnabled || this.windowsHelloPending || !this.validateWindowsHelloPassphrase) {
            return
        }
        this.windowsHelloPending = true
        this.windowsHelloFailed = false
        try {
            const passphrase = await this.platform.unlockVaultWindowsHello()
            if (passphrase) {
                await this.validateWindowsHelloPassphrase(passphrase)
                this.unlock(passphrase)
                return
            }
        } catch {
            // The local credential may be stale after a passphrase change on another device.
        } finally {
            this.windowsHelloPending = false
        }
        this.windowsHelloFailed = true
    }

    private unlock (passphrase: string): void {
        window.localStorage.vaultRememberPassphraseFor = this.rememberFor
        this.modalInstance.close({
            passphrase,
            rememberFor: this.rememberFor,
        })
    }

    cancel (): void {
        this.modalInstance.close(null)
    }

    getRememberForDisplay (rememberOption: number): string {
        if (rememberOption >= 1440) {
            return `${Math.round(rememberOption/1440*10)/10} day`
        } else if (rememberOption >= 60) {
            return `${Math.round(rememberOption/60*10)/10} hour`
        } else {
            return `${rememberOption} min`
        }
    }
}
