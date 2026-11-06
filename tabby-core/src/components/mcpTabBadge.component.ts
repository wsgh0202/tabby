import { Component, Input, OnDestroy, ViewChild } from '@angular/core'
import { NgbPopover } from '@ng-bootstrap/ng-bootstrap'
import { MCPTabOrigin } from './baseTab.component'

/** @hidden */
@Component({
    selector: 'mcp-tab-badge',
    templateUrl: './mcpTabBadge.component.pug',
    styleUrls: ['./mcpTabBadge.component.scss'],
})
export class MCPTabBadgeComponent implements OnDestroy {
    @Input() origins: MCPTabOrigin[] = []
    @ViewChild(NgbPopover) popover?: NgbPopover
    pinned = false
    focused = false
    insideDetails = false
    private closeTimer: ReturnType<typeof setTimeout>|null = null

    get sessionOpen (): boolean {
        return this.origins.some(origin => origin.sessionOpen)
    }

    open (): void {
        this.cancelClose()
        this.popover?.open()
    }

    leave (): void {
        this.cancelClose()
        if (!this.pinned && !this.focused && !this.insideDetails) {
            // Bridge the gap between the badge and the body-mounted popover.
            this.closeTimer = setTimeout(() => this.popover?.close(), 250)
        }
    }

    togglePinned (): void {
        if (this.pinned) {
            this.popover?.close()
        } else {
            this.open()
            this.pinned = true
        }
    }

    cancelClose (): void {
        if (this.closeTimer !== null) { clearTimeout(this.closeTimer) }
        this.closeTimer = null
    }

    hidden (): void {
        this.cancelClose()
        this.pinned = false
        // Removing the focused popover does not reliably dispatch focusout.
        this.focused = false
        this.insideDetails = false
    }

    ngOnDestroy (): void {
        this.cancelClose()
        this.popover?.close()
    }
}
