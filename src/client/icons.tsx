import type * as ReactTypes from 'react'

export const deviceIconMask = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="black" stroke-width="1.25"><rect x="2" y="2.5" width="12" height="8" rx="1"/><path d="M8 10.5V13.5M5 13.5H11"/></svg>')}`

/** The host's settings nav uses a fixed icon map and exposes no icon slot. */
export function installSettingsDeviceIcon() {
  const mark = () => {
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-shortcut-modal="settings"] nav button')) {
      if (button.textContent?.trim() === '设备连接') button.dataset.deviceLinkSettings = ''
    }
  }
  const observer = new MutationObserver(mark)
  observer.observe(document.body, { childList: true, subtree: true })
  mark()
  return () => {
    observer.disconnect()
    for (const button of document.querySelectorAll<HTMLElement>('[data-device-link-settings]')) delete button.dataset.deviceLinkSettings
  }
}

// DSH has no exported device icon; match its 16px regular icon grid and stroke.
export function createDeviceIcon(React: typeof ReactTypes) {
  return function DeviceIcon({ size = 16 }: { size?: number }) {
    return <svg className="dl-device-icon" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1} aria-hidden="true">
      <rect x={2} y={2.5} width={12} height={8} rx={1} />
      <path d="M8 10.5V13.5M5 13.5H11" />
    </svg>
  }
}
