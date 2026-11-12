/**
 * Pairing code + device token primitives.
 *
 * A pairing code is 8 digits, short lived, single use, and burns out after
 * `maxAttempts` wrong guesses from the same client key (the caller's IP).
 * Device tokens are 32 random bytes. The receiving device stores their SHA-256
 * hashes; the connecting device stores the tokens to authenticate later requests.
 */

import crypto from 'node:crypto'

const DEFAULT_TTL_MS = 120_000
const DEFAULT_MAX_ATTEMPTS = 8
const CODE_MAX_EXCLUSIVE = 100_000_000

/** Constant-time string comparison; unequal lengths short-circuit (they are not secret). */
function constantTimeEqual(left: unknown, right: unknown) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const a = Buffer.from(left, 'utf8')
  const b = Buffer.from(right, 'utf8')
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

function expiresAtIso(milliseconds: number) {
  return new Date(milliseconds).toISOString()
}

export function hashToken(token: unknown) {
  if (typeof token !== 'string' || token.length === 0) return ''
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex')
}

export function createDeviceToken() {
  const token = crypto.randomBytes(32).toString('base64url')
  const tokenHash = hashToken(token)
  return { token, tokenHash }
}

export function verifyToken(token: unknown, tokenHash: unknown) {
  if (typeof token !== 'string' || token.length === 0) return false
  if (typeof tokenHash !== 'string' || tokenHash.length === 0) return false
  return constantTimeEqual(hashToken(token), tokenHash)
}

export function createPairing({ ttlMs = DEFAULT_TTL_MS, maxAttempts = DEFAULT_MAX_ATTEMPTS } = {}) {
  const ttl = Number.isInteger(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_TTL_MS
  const limit = Number.isInteger(maxAttempts) && maxAttempts > 0 ? maxAttempts : DEFAULT_MAX_ATTEMPTS

  let code: string | null = null
  let expiresAtMs = 0
  let enabled = false
  const attempts = new Map<string, number>()

  function newCode() {
    return String(crypto.randomInt(0, CODE_MAX_EXCLUSIVE)).padStart(8, '0')
  }

  function openPairing() {
    code = newCode()
    expiresAtMs = Date.now() + ttl
    enabled = true
    attempts.clear()
    return { code, expiresAt: expiresAtIso(expiresAtMs) }
  }

  return {
    openPairing,

    closePairing() {
      enabled = false
      code = null
      expiresAtMs = 0
      attempts.clear()
    },

    isOpen() {
      return enabled && code !== null && Date.now() < expiresAtMs
    },

    /**
     * Verify and consume the code. One successful consume closes pairing.
     * `clientKey` scopes the failure counter (the caller passes the remote IP).
     */
    consume(candidate: unknown, clientKey: string): { ok: true } | { ok: false; reason: 'expired' | 'mismatch' | 'attempts' } {
      const key = typeof clientKey === 'string' && clientKey ? clientKey : 'unknown'
      const failures = attempts.get(key) ?? 0

      // A code burned by repeated failures stays unusable until a new one is opened.
      if (failures >= limit) return { ok: false, reason: 'attempts' }

      if (!enabled || code === null) return { ok: false, reason: 'mismatch' }
      if (Date.now() >= expiresAtMs) return { ok: false, reason: 'expired' }

      if (!constantTimeEqual(candidate, code)) {
        const next = failures + 1
        attempts.set(key, next)
        if (next >= limit) {
          enabled = false
          return { ok: false, reason: 'attempts' }
        }
        return { ok: false, reason: 'mismatch' }
      }

      enabled = false
      code = null
      expiresAtMs = 0
      attempts.clear()
      return { ok: true }
    },
  }
}
