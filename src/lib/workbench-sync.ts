import { ipc, isWebUIMode } from './ipc-client'
import { flushSharedStorage, refreshSharedState, subscribeSharedState } from './shared-storage'
import { getRemoteConnection, isCloudRemoteMode, subscribeRemoteConnection } from '../remote/browser'

/** One scheduler/agent lives on the host; every UI observes shared persisted configuration. */
export function startWorkbenchSync(): () => void {
  let stopped = false
  const hydrating = new Map<string, Promise<void>>()
  const rehydrate = (name: string): Promise<void> => {
    if (stopped) return Promise.resolve()
    const current = hydrating.get(name)
    if (current) return current
    const operation = (async () => {
      try {
        switch (name) {
          case 'clerkbox-settings': {
            const { useSettingsStore, hydrateProviderApiKeys } = await import('../stores/settings-store')
            await useSettingsStore.persist.rehydrate()
            if (!isWebUIMode) await hydrateProviderApiKeys()
            break
          }
          case 'clerkbox-skills': await (await import('../stores/skills-store')).useSkillsStore.persist.rehydrate(); break
          case 'clerkbox-vibe': await (await import('../stores/vibe-store')).useVibeStore.persist.rehydrate(); break
          case 'clerkbox-scheduled-tasks': await (await import('../stores/scheduled-tasks-store')).useScheduledTasksStore.persist.rehydrate(); break
          case 'clerkbox-token-usage': await (await import('../stores/token-usage-store')).useTokenUsageStore.persist.rehydrate(); break
          case 'clerkbox-account': await (await import('../stores/account-store')).useAccountStore.persist.rehydrate(); break
          case 'clerkbox-joule': await (await import('../stores/joule-store')).useJouleStore.persist.rehydrate(); break
          case 'clerkbox-goal-store': await (await import('../stores/goal-store')).useGoalStore.persist.rehydrate(); break
          case 'clerkbox-todo-store': await (await import('../stores/interactive-store')).useTodoStore.persist.rehydrate(); break
        }
      } catch (error) { console.warn('[workbench-sync] refresh failed:', error) }
      finally { hydrating.delete(name) }
    })()
    hydrating.set(name, operation)
    return operation
  }
  const refresh = () => {
    if (stopped || (isCloudRemoteMode() && getRemoteConnection().state !== 'connected')) return
    void refreshSharedState().catch(error => console.warn('[workbench-sync] host unavailable:', error))
  }
  const offState = subscribeSharedState(rehydrate)
  const offHost = ipc.onSharedStateChanged(refresh)
  const offConnection = isCloudRemoteMode() ? subscribeRemoteConnection(refresh) : () => {}
  const offCommands = ipc.onRemoteWorkbenchCommand(command => {
    void (async () => {
      try {
        await flushSharedStorage()
        await refreshSharedState()
        await rehydrate('clerkbox-scheduled-tasks')
        const { useScheduledTasksStore } = await import('../stores/scheduled-tasks-store')
        const runId = useScheduledTasksStore.getState().enqueueRun(command.taskId, 'manual')
        ipc.remoteWorkbenchReply(command.id, { runId })
      } catch (error) { ipc.remoteWorkbenchReply(command.id, { error: error instanceof Error ? error.message : String(error) }) }
    })()
  })
  const timer = window.setInterval(refresh, 2500)
  window.addEventListener('focus', refresh)
  refresh()
  return () => {
    stopped = true
    window.clearInterval(timer)
    window.removeEventListener('focus', refresh)
    offState(); offHost(); offConnection(); offCommands()
  }
}
