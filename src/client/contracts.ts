import type * as React from 'react'

export interface Snapshot<T> { getSnapshot(): T; subscribe(listener: () => void): () => void }
export interface Reference { source: string; ref: string; label: string; appearance: 'folder' | 'session'; clipboardText: string }
export interface Candidate { name: string; label: string; description: string; value: string; icon: 'folder' | 'session' }
export interface SessionInput {
  state: Snapshot<{ draft: string; draftRev: number }>
  insertReference(reference: Reference, span: { start: number; end: number; draftRev: number }): boolean
  focus(): void
}
export interface ClientContext {
  uiConversation: { userText: { register(rule: { id: string; order: number; match(text: string, from: number): unknown }): () => void } }
  slots: {
    inject(name: string, factory: () => unknown): unknown
    register<P>(options: { name: string; id?: string; key?: string; order?: number; label?: string; inject?: (sessionId: string) => object }, component: React.ComponentType<P>): unknown
  }
  inputTriggers: { registerSource(source: {
    trigger: '@'; name: string; order: number
    candidates(session: unknown, request: { query: string; signal: AbortSignal }): Promise<Candidate[]>
    onPick(pick: { candidate: Candidate }): { insert: Reference }
    codec: { clipboardText(ref: string): string; serialize(ref: string, signal: AbortSignal): Promise<string> }
    openReference(session: unknown, reference: { ref: string }): boolean
  }): () => void }
  sidebarRightTabs: { register(definition: { id: string; kind: string; patterns: string[]; title(address: string): string }): () => void }
  sidebarRight: {
    mounted: Snapshot<string | undefined>
    openResource(address: string, options?: { replaceTab?: string; revealIfOpened?: boolean }): unknown
    openTabs: Snapshot<readonly { sessionId: string; tabId: string; kind: string; contentId: string }[]>
    active(): { id: string; kind: string } | undefined
    close(tabId: string): void
    isExpanded(): boolean
    toggleExpanded(): void
  }
  layout: { selectPanel(id: string | null): void }
  sessions: { scope(sessionId: string): unknown }
  conversation: { input: { for(scope: unknown): SessionInput } }
  uiWorkspace: { startSession(workspaceId?: string): void; openSession(target: string): void }
  effect(factory: () => (() => void)): void
}
export interface TabProps {
  sessionId: string
  useTabInfo(): { tab: { navigation: { address: string }; visible: boolean } }
}
export interface MarkdownProps { text: string; labels: { code: { copyLabel: string; copiedLabel: string; toolbarLabels: { codeLabel: string; wrapLabel: string; unwrapLabel: string } }; footnotes: string } }
export interface ClientPrimitives {
  useModalLayer(ref: React.RefObject<HTMLElement | null>, open: boolean, onClose: () => void): void
  MarkdownText: React.ComponentType<MarkdownProps>
  TextShimmer: React.ComponentType<{ active?: boolean; className?: string; children?: React.ReactNode }>
  IconCopyOutlineRegular: React.ComponentType<{ size?: number }>
  IconCheckOutlineRegular: React.ComponentType<{ size?: number }>
  IconChevronRightOutlineRegular: React.ComponentType<{ size?: number }>
  IconChevronLeftOutlineRegular: React.ComponentType<{ size?: number }>
  IconChevronDownOutlineRegular: React.ComponentType<{ size?: number }>
  IconRightUpOutlineRegular: React.ComponentType<{ size?: number }>
  IconFolderCloseRegular: React.ComponentType<{ size?: number }>
  ReferenceIconRegular: React.ComponentType<{ kind: 'folder' | 'session'; size?: number }>
  IconAgentPresetOutlineRegular: React.ComponentType<{ size?: number }>
  IconChecklistOutlineRegular: React.ComponentType<{ size?: number }>
  MenuSurface: React.ComponentType<React.ComponentPropsWithRef<'div'>>
  MenuGroup: React.ComponentType<{ label: string; children?: React.ReactNode }>
}
export type CreatePortal = (children: React.ReactNode, container: Element | DocumentFragment) => React.ReactPortal
export interface ClientRequire {
  (name: 'react'): typeof React
  (name: 'react-dom'): { createPortal: CreatePortal }
  (name: '@deepseek-ai/dsh-client-ui-primitives'): ClientPrimitives
}

declare global {
  interface Window {
    __ModuleLoader__: { load(module: { id: string; factory(require: ClientRequire): { inject: string[]; apply(ctx: ClientContext): void } }): void }
  }
}
