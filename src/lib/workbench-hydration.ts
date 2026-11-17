/** Recover interrupted initial Zustand hydration without replacing a live workbench. */
export interface WorkbenchHydrationStore {
  name: string
  persist: {
    hasHydrated(): boolean
    rehydrate(): Promise<void> | void
    onFinishHydration(listener: () => void): () => void
  }
}

export interface WorkbenchHydrationState {
  ready: boolean
  loading: boolean
  pending: string[]
  failed: string[]
}

const attempts = new WeakMap<WorkbenchHydrationStore['persist'], Promise<boolean>>()

/** StrictMode and repeated connection events share one retry per persisted store. */
export function retryStoreHydration(store: WorkbenchHydrationStore): Promise<boolean> {
  if (store.persist.hasHydrated()) return Promise.resolve(true)
  const existing = attempts.get(store.persist)
  if (existing) return existing
  const operation = Promise.resolve().then(() => store.persist.rehydrate()).then(
    () => store.persist.hasHydrated(),
    () => false,
  )
  attempts.set(store.persist, operation)
  void operation.then(() => { if (attempts.get(store.persist) === operation) attempts.delete(store.persist) })
  return operation
}

export function startWorkbenchHydrationRecovery(options: {
  loadStores(): Promise<WorkbenchHydrationStore[]>
  isConnected(): boolean
  subscribeConnection(listener: () => void): () => void
  onState(state: WorkbenchHydrationState): void
  retryBaseMs?: number
  retryMaxMs?: number
}): { retry(): void; stop(): void } {
  let stores: WorkbenchHydrationStore[] | undefined
  let loadingStores: Promise<void> | undefined
  let running: Promise<void> | undefined
  let stopped = false
  let ready = false
  let attempt = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const unsubscribers: Array<() => void> = []
  const pending = () => stores?.filter(store => !store.persist.hasHydrated()).map(store => store.name) ?? []
  const publish = (loading: boolean, failed: string[] = []) => {
    if (stopped) return
    const waiting = pending()
    if (stores && waiting.length === 0) ready = true
    options.onState({ ready, loading, pending: waiting, failed })
  }
  const clearTimer = () => { if (timer) clearTimeout(timer); timer = undefined }
  const load = () => {
    if (stores) return Promise.resolve()
    if (loadingStores) return loadingStores
    loadingStores = options.loadStores().then(result => {
      if (stopped) return
      stores = result
      for (const store of stores) unsubscribers.push(store.persist.onFinishHydration(() => publish(!!running)))
      // Some auto-hydrations finish before their listeners can be registered.
      publish(true)
    }).finally(() => { loadingStores = undefined })
    return loadingStores
  }
  const schedule = (immediate = false) => {
    if (stopped || !options.isConnected()) return
    clearTimer()
    const delay = immediate ? 0 : Math.min((options.retryBaseMs ?? 1000) * 2 ** Math.min(attempt++, 5), options.retryMaxMs ?? 30_000)
    timer = setTimeout(() => { timer = undefined; void run() }, delay)
  }
  const run = (): Promise<void> => {
    if (stopped || !options.isConnected()) { publish(false); return Promise.resolve() }
    if (running) return running
    const operation = (async () => {
      publish(true)
      try {
        await load()
        if (stopped || !options.isConnected()) return
        await Promise.all(stores!.map(retryStoreHydration))
        const failed = pending()
        publish(false, failed)
        if (failed.length) schedule()
        else attempt = 0
      } catch {
        publish(false, ['workbench'])
        schedule()
      }
    })()
    running = operation
    void operation.finally(() => { if (running === operation) running = undefined })
    return operation
  }
  const retry = () => { attempt = 0; schedule(true) }
  const offConnection = options.subscribeConnection(() => {
    if (options.isConnected()) retry()
    else { clearTimer(); publish(false) }
  })
  void run()
  return {
    retry,
    stop() { stopped = true; clearTimer(); offConnection(); for (const off of unsubscribers) off() },
  }
}

/** Import every shared store even if its feature page has never been opened. */
export async function loadSharedWorkbenchHydrationStores(): Promise<WorkbenchHydrationStore[]> {
  const [settings, skills, vibe, scheduled, usage, account, joule, goal, todo] = await Promise.all([
    import('../stores/settings-store'), import('../stores/skills-store'), import('../stores/vibe-store'),
    import('../stores/scheduled-tasks-store'), import('../stores/token-usage-store'), import('../stores/account-store'),
    import('../stores/joule-store'), import('../stores/goal-store'), import('../stores/interactive-store'),
  ])
  return [
    { name: 'clerkbox-settings', persist: settings.useSettingsStore.persist },
    { name: 'clerkbox-skills', persist: skills.useSkillsStore.persist },
    { name: 'clerkbox-vibe', persist: vibe.useVibeStore.persist },
    { name: 'clerkbox-scheduled-tasks', persist: scheduled.useScheduledTasksStore.persist },
    { name: 'clerkbox-token-usage', persist: usage.useTokenUsageStore.persist },
    { name: 'clerkbox-account', persist: account.useAccountStore.persist },
    { name: 'clerkbox-joule', persist: joule.useJouleStore.persist },
    { name: 'clerkbox-goal-store', persist: goal.useGoalStore.persist },
    { name: 'clerkbox-todo-store', persist: todo.useTodoStore.persist },
  ]
}
