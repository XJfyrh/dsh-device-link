import type * as ReactTypes from 'react'

// DSH has no exported device icon; match its 16px regular icon grid and stroke.
export function createDeviceIcon(React: typeof ReactTypes) {
  return function DeviceIcon({ size = 16 }: { size?: number }) {
    return <svg className="dl-device-icon" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1} aria-hidden="true">
      <rect x={2} y={2.5} width={12} height={8} rx={1} />
      <path d="M8 10.5V13.5M5 13.5H11" />
    </svg>
  }
}
