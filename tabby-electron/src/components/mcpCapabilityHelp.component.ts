import { DOCUMENT } from '@angular/common'
import { Component, ElementRef, Inject, Input, OnDestroy, OnInit, ViewChild } from '@angular/core'
import { NgbPopover } from '@ng-bootstrap/ng-bootstrap'
import { Options } from '@popperjs/core'
import { MCPCapabilityLabel } from '../mcp/capabilityLabels'

/** @hidden */
@Component({
    selector: 'mcp-capability-help',
    templateUrl: './mcpCapabilityHelp.component.pug',
    styleUrls: ['./mcpCapabilityHelp.component.scss'],
})
export class MCPCapabilityHelpComponent implements OnInit, OnDestroy {
    @Input() capability: MCPCapabilityLabel
    @ViewChild(NgbPopover) popover?: NgbPopover
    pinned = false
    private focused = false
    private closeTimer: ReturnType<typeof setTimeout>|null = null
    private static active: MCPCapabilityHelpComponent|null = null

    constructor (
        private element: ElementRef<HTMLElement>,
        @Inject(DOCUMENT) private document: Document,
    ) { }

    ngOnInit (): void {
        // NgbModal listens on the dialog. Capture Escape first so help closes alone.
        this.document.addEventListener('keydown', this.handleEscape, true)
        this.document.addEventListener('click', this.handleOutsideClick, true)
    }

    ngOnDestroy (): void {
        this.document.removeEventListener('keydown', this.handleEscape, true)
        this.document.removeEventListener('click', this.handleOutsideClick, true)
        this.close()
    }

    readonly popperOptions = (options: Partial<Options>): Partial<Options> => {
        const dialog = this.element.nativeElement.closest('.modal-content')
        const boundary = dialog ?? 'viewport'
        return {
            ...options,
            modifiers: [
                ...options.modifiers ?? [],
                { name: 'preventOverflow', options: { boundary, padding: 8, altAxis: true } },
                { name: 'flip', options: { boundary, padding: 8 } },
                {
                    name: 'mcpSize',
                    enabled: true,
                    phase: 'beforeWrite',
                    fn: ({ state }) => {
                        const bounds = dialog?.getBoundingClientRect()
                        state.styles.popper.maxWidth = `min(23rem, ${Math.max(1, (bounds?.width ?? this.document.documentElement.clientWidth) - 16)}px)`
                        state.styles.popper.maxHeight = `${Math.max(1, (bounds?.height ?? this.document.documentElement.clientHeight) - 16)}px`
                        state.styles.popper.overflowY = 'auto'
                    },
                },
            ],
        }
    }

    open (): void {
        this.cancelClose()
        if (MCPCapabilityHelpComponent.active !== this) {
            MCPCapabilityHelpComponent.active?.close()
            MCPCapabilityHelpComponent.active = this
        }
        this.popover?.open()
    }

    focus (): void {
        this.focused = true
        this.open()
    }

    blur (): void {
        this.focused = false
        this.leave()
    }

    togglePinned (): void {
        if (this.pinned) {
            this.close()
        } else {
            this.open()
            this.pinned = true
        }
    }

    leave (): void {
        this.cancelClose()
        if (!this.pinned && !this.focused) {
            this.closeTimer = setTimeout(() => this.close(), 120)
        }
    }

    cancelClose (): void {
        if (this.closeTimer !== null) { clearTimeout(this.closeTimer) }
        this.closeTimer = null
    }

    close (): void {
        this.cancelClose()
        this.pinned = false
        this.popover?.close(false)
        if (MCPCapabilityHelpComponent.active === this) { MCPCapabilityHelpComponent.active = null }
    }

    readonly handleEscape = (event: KeyboardEvent): void => {
        if (event.key === 'Escape' && this.popover?.isOpen()) {
            event.preventDefault()
            event.stopImmediatePropagation()
            this.close()
        }
    }

    readonly handleOutsideClick = (event: MouseEvent): void => {
        if (!this.popover?.isOpen() || !event.target) { return }
        const target = event.target as Node
        if (this.element.nativeElement.contains(target)) { return }
        const describedBy = this.element.nativeElement.querySelector('button')?.getAttribute('aria-describedby') ?? ''
        if (describedBy.split(/\s+/).some(id => id && this.document.getElementById(id)?.contains(target))) { return }
        // Ng-bootstrap's outside mode excludes the trigger and closes its opening click.
        this.close()
    }
}
