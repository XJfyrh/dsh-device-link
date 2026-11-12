import type * as ReactTypes from 'react'
import type { ClientPrimitives, CreatePortal } from './contracts.js'

export function createChoiceField(React: typeof ReactTypes, primitives: ClientPrimitives, createPortal: CreatePortal) {
  const { useState, useRef, useId, useEffect, useLayoutEffect } = React
  const { MenuSurface, IconChevronDownOutlineRegular: Down, IconCheckOutlineRegular: Check } = primitives
  return function ChoiceField<T extends string>({ label, value, options, disabled = false, onChange }: {
    label: string; value: T; options: readonly { value: T; label: string }[]; disabled?: boolean; onChange(value: T): void
  }) {
    const [open, setOpen] = useState(false)
    const [active, setActive] = useState(0)
    const [position, setPosition] = useState<ReactTypes.CSSProperties>({ visibility: 'hidden' })
    const trigger = useRef<HTMLButtonElement>(null)
    const menu = useRef<HTMLDivElement>(null)
    const id = useId()
    const selected = options.findIndex(option => option.value === value)
    const visible = open && !disabled
    function show() { setActive(Math.max(0, selected)); setPosition({ visibility: 'hidden' }); setOpen(true) }
    function choose(index: number) { if (!disabled && options[index]) onChange(options[index].value); setOpen(false) }
    useEffect(() => { if (disabled) setOpen(false) }, [disabled])
    useLayoutEffect(() => {
      if (!visible) return
      function place() {
        if (!trigger.current || !menu.current) return
        const rect = trigger.current.getBoundingClientRect()
        const width = Math.min(Math.max(rect.width, 200), window.innerWidth - 24)
        const height = menu.current.offsetHeight
        const below = window.innerHeight - rect.bottom - 8
        setPosition({ width, left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), top: Math.max(12, below >= height ? rect.bottom + 4 : rect.top - height - 4) })
      }
      place()
      const observer = new ResizeObserver(place)
      if (menu.current) observer.observe(menu.current)
      window.addEventListener('resize', place)
      window.addEventListener('scroll', place, true)
      return () => { observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
    }, [visible])
    useEffect(() => {
      if (!visible) return
      function outside(event: PointerEvent) {
        if (event.target instanceof Node && !menu.current?.contains(event.target) && !trigger.current?.contains(event.target)) setOpen(false)
      }
      document.addEventListener('pointerdown', outside)
      return () => document.removeEventListener('pointerdown', outside)
    }, [visible])
    return <div className="dl-choice-field">
      <span id={`${id}-label`}>{label}</span>
      <button ref={trigger} type="button" role="combobox" className="dl-choice-trigger" aria-labelledby={`${id}-label`} aria-describedby={`${id}-value`} aria-haspopup="listbox" aria-expanded={visible} aria-controls={visible ? id : undefined} aria-activedescendant={visible ? `${id}-${active}` : undefined} disabled={disabled}
        onClick={() => visible ? setOpen(false) : show()} onBlur={() => setOpen(false)} onKeyDown={event => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Escape' && visible) { event.preventDefault(); event.stopPropagation(); setOpen(false); return }
          if (event.key === 'Tab') { setOpen(false); return }
          if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault(); event.stopPropagation()
            if (!visible) show()
            else setActive(index => event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length)
          } else if (visible && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); event.stopPropagation(); choose(active) }
        }}>
        <span id={`${id}-value`}>{options[selected]?.label ?? '请选择'}</span><Down size={14} />
      </button>
      {visible && createPortal(<MenuSurface ref={menu} id={id} role="listbox" aria-labelledby={`${id}-label`} className="dl-model-menu dl-choice-menu" style={position}>
        {options.map((option, index) => <button type="button" tabIndex={-1} id={`${id}-${index}`} role="option" aria-selected={option.value === value} key={option.value} className={`dl-model-option ${active === index ? 'active' : ''}`} onMouseDown={event => event.preventDefault()} onPointerMove={() => setActive(index)} onClick={() => choose(index)}>
          <span className="dl-model-name">{option.label}</span><span className="dl-model-check">{option.value === value && <Check size={14} />}</span>
        </button>)}
      </MenuSurface>, document.body)}
    </div>
  }
}
