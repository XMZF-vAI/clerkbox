import { useLayoutEffect, useRef, type RefObject } from 'react'

interface ModalEntry {
  panel: HTMLElement
  close: () => void
  initialFocus: () => HTMLElement | null
  previousFocus: HTMLElement | null
  respectOverlayLock: boolean
}

const modalStack: ModalEntry[] = []
let overlayLocks = 0
const topModal = () => modalStack[modalStack.length - 1]
const focusableSelector =
  'button, [href], input, select, textarea, [tabindex], [contenteditable="true"]'

function focusableElements(panel: HTMLElement) {
  return Array.from(panel.querySelectorAll<HTMLElement>(focusableSelector)).filter((element) =>
    element.tabIndex >= 0 && !element.matches(':disabled') &&
    !element.closest('[hidden], [inert]') && element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility !== 'hidden'
  )
}

function focusModal(entry: ModalEntry) {
  const initial = entry.initialFocus()
  if (initial && focusableElements(entry.panel).includes(initial)) initial.focus()
  else entry.panel.focus()
}

// One capture listener chooses its owner before any close handler can change the stack.
function handleKeyDown(event: KeyboardEvent) {
  const entry = topModal()
  if (!entry || event.defaultPrevented || (entry.respectOverlayLock && overlayLocks > 0)) return
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopImmediatePropagation()
    entry.close()
    return
  }
  if (event.key !== 'Tab') return

  const focusable = focusableElements(entry.panel)
  const active = document.activeElement
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (!first || !focusable.includes(active as HTMLElement) ||
      (event.shiftKey ? active === first : active === last)) {
    event.preventDefault()
    event.stopImmediatePropagation()
    ;(event.shiftKey ? last : first)?.focus()
    if (!first) entry.panel.focus()
  }
}

/** Compatibility lock for BotsDialog/BindPanel; confirmations themselves never honor this lock. */
export function useOverlayKeyboardLock(active: boolean) {
  useLayoutEffect(() => {
    if (!active) return
    overlayLocks += 1
    return () => { overlayLocks -= 1 }
  }, [active])
}

/** Shared Escape/Tab ownership and trigger-focus restoration for stacked dialogs. */
export function useModalAccessibility(
  onClose: () => void,
  initialFocus?: RefObject<HTMLElement | null>,
  { active = true, respectOverlayLock = false } = {},
) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const latest = useRef({ onClose, initialFocus })
  useLayoutEffect(() => { latest.current = { onClose, initialFocus } })

  useLayoutEffect(() => {
    const panel = dialogRef.current
    if (!active || !panel) return
    const entry: ModalEntry = {
      panel,
      close: () => latest.current.onClose(),
      initialFocus: () => latest.current.initialFocus?.current ?? null,
      previousFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
      respectOverlayLock,
    }
    // React mounts child effects first. Insert an enclosing panel below its already mounted children.
    const childIndex = modalStack.findIndex((other) => panel.contains(other.panel))
    if (childIndex < 0) modalStack.push(entry)
    else modalStack.splice(childIndex, 0, entry)
    if (modalStack.length === 1) document.addEventListener('keydown', handleKeyDown, true)
    // Wait for all panels in this commit; a parent must not steal its child's initial focus.
    queueMicrotask(() => {
      if (topModal() === entry && !(respectOverlayLock && overlayLocks > 0)) focusModal(entry)
    })

    return () => {
      const wasTop = topModal() === entry
      const index = modalStack.indexOf(entry)
      if (index >= 0) modalStack.splice(index, 1)
      if (!modalStack.length) document.removeEventListener('keydown', handleKeyDown, true)
      if (!wasTop) return
      const next = topModal()
      queueMicrotask(() => {
        // Do not steal focus from a dialog opened during the same commit.
        if (topModal() !== next) return
        const previous = entry.previousFocus
        if (previous?.isConnected && !previous.matches(':disabled') &&
            (!next || next.panel.contains(previous))) previous.focus()
        else if (next) focusModal(next)
      })
    }
  }, [active, respectOverlayLock])

  return dialogRef
}
