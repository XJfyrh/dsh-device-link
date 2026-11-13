import { pickBindAddress, resolveConfig } from './lib/config.js'
import { openStore } from './lib/store.js'
import { createPairing } from './lib/pairing.js'
import { createOwnerCredentials } from './lib/credentials.js'
import { createGuiProxy } from './lib/proxy.js'
import { createDeviceLinkServer } from './lib/serve.js'
import { createConnector } from './lib/connect.js'
import { registerDeviceApi } from './lib/api.js'
import { registerDeviceCommands } from './lib/commands.js'
import { registerDeviceTools } from './lib/tool.js'
import { collectHostFacts, readSessionContent } from './lib/host-facts.js'
import { createDelegationRunner } from './lib/delegation.js'
import { createTaskManager } from './lib/tasks.js'
import { createOutgoingTasks } from './lib/outgoing-tasks.js'
import { executionContext } from './lib/models.js'
import { createResourceProvider } from './lib/resources.js'
import { createReferences } from './lib/references.js'
import type { HostContext } from './lib/host.js'
import type { Scope } from './lib/types.js'

export const name = 'device-link'
export const inject = ['commands', 'webServer', 'connection']

export async function bootstrap(ctx: HostContext, rawConfig: Record<string, unknown> = {}) {
  const config = resolveConfig(rawConfig)
  const startedAt = Date.now()
  const store = await openStore({ deviceName: config.deviceName })
  const bind = pickBindAddress(config.bindAddress)
  const origin = ctx.webServer.getOrigin()
  const credentials = createOwnerCredentials({ origin, getAuthenticatedUrl: () => ctx.connection.authenticatedUrl(origin), log: console })
  const proxy = createGuiProxy({ origin, getCookie: credentials.getCookie, onAuthFailure: credentials.invalidate, log: console, timeoutMs: config.proxyRequestTimeoutMs })
  const pairing = createPairing({ ttlMs: config.pairingTtlMs, maxAttempts: config.maxPairFailures })
  const delegation = createDelegationRunner({ ctx })
  const taskManager = await createTaskManager({ store, ctx, run: delegation.run })
  const hostFacts = (scope?: Scope) => collectHostFacts(ctx, { scope, startedAt })
  const server = createDeviceLinkServer({
    config: { port: config.listenPort, bindAddress: bind.address, allowIncoming: config.allowIncoming, accessTtlMs: config.accessTtlMs, maxPairFailures: config.maxPairFailures, failureWindowMs: config.failureWindowMs },
    store, pairing, proxy, factsProvider: hostFacts,
    sessionProvider: (id, scope) => readSessionContent(ctx, id, scope),
    executionProvider: (workspace, sessionId) => executionContext(ctx, workspace, sessionId),
    resourceProvider: createResourceProvider(ctx),
    taskManager,
  })
  const connector = createConnector({ store })
  const references = await createReferences({ store, connector })
  const outgoingTasks = createOutgoingTasks({ store, connector })
  const listen = await server.start()
  await store.update(draft => { draft.serve.port = listen.port; draft.serve.lastAddress = listen.host })
  console.log(`[device-link] ${store.state().identity.name} listening on ${listen.host}:${listen.port}`)
  return { config, store, server, connector, delegation, taskManager, outgoingTasks, hostFacts, references }
}
export type Runtime = Awaited<ReturnType<typeof bootstrap>>
export type LoadRuntime = () => Promise<Runtime>

export function apply(ctx: HostContext, rawConfig: Record<string, unknown> = {}): void {
  let pending: Promise<Runtime> | undefined
  let stopped = false
  const load = () => pending ??= bootstrap(ctx, rawConfig).then(async runtime => {
    if (stopped) { await runtime.taskManager.dispose(); await runtime.delegation.disposeAll(); await runtime.server.stop() }
    return runtime
  })
  ctx.effect(() => registerDeviceApi(ctx, { load }))
  ctx.effect(() => registerDeviceCommands(ctx, { load }))
  ctx.effect(() => registerDeviceTools(ctx, { load, enabled: resolveConfig(rawConfig).toolsEnabled }))
  ctx.effect(() => {
    void load().catch(error => console.error('[device-link]', error))
    return () => {
      stopped = true
      void pending?.then(async runtime => { await runtime.taskManager.dispose(); await runtime.delegation.disposeAll(); await runtime.server.stop() }).catch(error => console.error('[device-link]', error))
    }
  })
}
