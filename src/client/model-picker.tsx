import type * as ReactTypes from 'react'
import type { ClientPrimitives, CreatePortal } from './contracts.js'
import type { ExecutionContext, ModelSelection } from '../lib/types.js'

export function createModelPicker(React: typeof ReactTypes, primitives: ClientPrimitives, createPortal: CreatePortal) {
  const { useState, useEffect, useLayoutEffect, useRef, useId } = React
  const { MenuSurface, MenuGroup, IconChevronDownOutlineRegular: Down, IconChevronRightOutlineRegular: Right, IconCheckOutlineRegular: Check } = primitives
  return function ModelPicker({ context, selected, disabled, onChange }: {
    context: ExecutionContext; selected: ModelSelection; disabled: boolean; onChange(selection: ModelSelection): void
  }) {
    const [open, setOpen] = useState(false)
    const [pane, setPane] = useState<'root' | 'model' | 'effort'>('root')
    const [query, setQuery] = useState('')
    const [position, setPosition] = useState<ReactTypes.CSSProperties>({ visibility: 'hidden' })
    const trigger = useRef<HTMLButtonElement>(null)
    const menu = useRef<HTMLDivElement>(null)
    const search = useRef<HTMLInputElement>(null)
    const id = useId()
    const current = context.catalog.groups.find(group => group.id === selected.provider)?.models.find(model => model.id === selected.model)
    const reasoning = current?.reasoning
    const effectiveEffort = selected.reasoningEffort ?? reasoning?.defaultEffort
    const effortLabel = reasoning ? reasoning.efforts.find(effort => effort.id === effectiveEffort)?.name ?? effectiveEffort ?? '默认强度' : undefined
    const efforts = reasoning ? [...(reasoning.defaultEffort === undefined ? [{ id: undefined, name: '默认强度' }] : []), ...reasoning.efforts] : []
    const groups = context.catalog.groups.map(group => ({ ...group, models: group.models.filter(model => `${group.name} ${model.name}`.toLowerCase().includes(query.trim().toLowerCase())) })).filter(group => group.models.length)
    const showSearch = context.catalog.groups.reduce((count, group) => count + group.models.length, 0) > 4
    const modelLabel = current?.name ?? '所选模型不可用'
    const visible = open && !disabled
    function close(restoreFocus = false) {
      setOpen(false)
      if (restoreFocus) trigger.current?.focus()
    }
    function choose(selection: ModelSelection) {
      if (disabled) return
      onChange(selection)
      close(true)
    }
    useEffect(() => { if (disabled) setOpen(false) }, [disabled])
    useLayoutEffect(() => {
      if (!visible) return
      const place = () => {
        if (!trigger.current || !menu.current) return
        const rect = trigger.current.getBoundingClientRect()
        const { offsetWidth: width, offsetHeight: height } = menu.current
        setPosition({ left: Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)), top: Math.max(12, Math.min(rect.top - height - 8, window.innerHeight - height - 12)) })
      }
      place()
      const observer = new ResizeObserver(place)
      if (menu.current) observer.observe(menu.current)
      window.addEventListener('resize', place)
      window.addEventListener('scroll', place, true)
      return () => { observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
    }, [visible, pane, query])
    useEffect(() => {
      if (!visible) return
      if (pane === 'model' && showSearch) search.current?.focus()
      else (menu.current?.querySelector<HTMLElement>('[aria-checked="true"]') ?? menu.current?.querySelector<HTMLElement>('[role="menuitem"], [role="menuitemradio"]'))?.focus()
    }, [visible, pane, showSearch])
    useEffect(() => {
      if (!visible) return
      const outside = (event: PointerEvent) => {
        if (event.target instanceof Node && !menu.current?.contains(event.target) && !trigger.current?.contains(event.target)) close()
      }
      document.addEventListener('pointerdown', outside)
      return () => document.removeEventListener('pointerdown', outside)
    }, [visible])
    function keyDown(event: ReactTypes.KeyboardEvent) {
      if (event.nativeEvent.isComposing) return
      if (event.key === 'Escape' || event.key === 'ArrowLeft' && pane !== 'root') {
        event.preventDefault(); event.stopPropagation()
        if (pane !== 'root' && current) setPane('root')
        else close(true)
        return
      }
      const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled), [role="menuitemradio"]:not(:disabled)') ?? [])
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        if ((event.key === 'Home' || event.key === 'End') && event.target === search.current) return
        event.preventDefault()
        const index = items.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : index < 0 ? event.key === 'ArrowDown' ? 0 : items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
        items[next]?.focus(); items[next]?.scrollIntoView({ block: 'nearest' })
      }
      if (event.key === 'ArrowRight' && pane === 'root' && document.activeElement instanceof HTMLButtonElement) { event.preventDefault(); document.activeElement.click() }
      if (event.key === 'Enter' && event.target === search.current) { event.preventDefault(); items[0]?.click() }
    }
    return <div className="dl-models" onKeyDown={keyDown} onBlur={event => {
      if (event.relatedTarget instanceof Node && (menu.current?.contains(event.relatedTarget) || trigger.current?.contains(event.relatedTarget))) return
      close()
    }}>
      <button ref={trigger} className="dl-model-trigger" type="button" aria-label={`模型与思考强度，当前 ${modelLabel}${effortLabel ? `，${effortLabel}` : ''}`} title={`模型：${modelLabel}${effortLabel ? `；思考强度：${effortLabel}` : ''}`} aria-haspopup="menu" aria-expanded={visible} aria-controls={visible ? id : undefined} disabled={disabled} onClick={() => {
        if (visible) close(true)
        else { setQuery(''); setPane(current ? 'root' : 'model'); setPosition({ visibility: 'hidden' }); setOpen(true) }
      }} onKeyDown={event => {
        if (!visible && ['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); setPane(current ? 'root' : 'model'); setOpen(true) }
      }}>
        <span className="dl-model-name">{modelLabel}</span>{effortLabel && <span className="dl-model-effort">{effortLabel}</span>}<span className={`dl-model-chevron ${visible ? 'open' : ''}`}><Down size={12} /></span>
      </button>
      {visible && createPortal(<MenuSurface ref={menu} id={id} className="dl-model-menu" style={position} role="menu" aria-label={pane === 'root' ? '模型与思考强度' : pane === 'model' ? '模型' : '思考强度'}>
        {pane === 'root' ? <>
          <button type="button" role="menuitem" className="dl-model-cell" onClick={() => setPane('model')}><span>模型</span><span className="dl-model-value">{modelLabel}</span><Right size={12} /></button>
          {reasoning && <button type="button" role="menuitem" className="dl-model-cell" onClick={() => setPane('effort')}><span>思考强度</span><span className="dl-model-value">{effortLabel}</span><Right size={12} /></button>}
        </> : pane === 'model' ? <>
          {showSearch && <input ref={search} className="dl-model-search" role="searchbox" aria-label="搜索模型" placeholder="搜索模型…" value={query} onChange={event => setQuery(event.target.value)} />}
          <div className="dl-model-options">{groups.map(group => <MenuGroup key={group.id} label={group.name}>{group.models.map(model => {
            const checked = selected.provider === group.id && selected.model === model.id
            return <button key={model.id} type="button" role="menuitemradio" aria-checked={checked} className="dl-model-option" title={model.name} onClick={() => choose(checked ? selected : { provider: group.id, model: model.id, reasoningEffort: model.reasoning?.defaultEffort })}>
              <span className="dl-model-name">{model.name}</span><span className="dl-model-check">{checked && <Check size={14} />}</span>
            </button>
          })}</MenuGroup>)}</div>
          {!groups.length && <div className="dl-model-empty" role="status">没有匹配的模型</div>}
        </> : <div className="dl-model-options">{efforts.map(effort => <button key={effort.id ?? 'default'} type="button" role="menuitemradio" aria-checked={effectiveEffort === effort.id} className="dl-model-option" onClick={() => choose({ ...selected, reasoningEffort: effort.id })}>
          <span className="dl-model-name">{effort.name}</span><span className="dl-model-check">{effectiveEffort === effort.id && <Check size={14} />}</span>
        </button>)}</div>}
      </MenuSurface>, document.body)}
    </div>
  }
}
