/*
 * Real remote transport/workbench integration. Only the upstream model is a local
 * OpenAI SSE fixture; the SQLite store, agent loop, connector, relay and UI are real.
 * Account/skill adapters are empty; model/MCP settings and history use synthetic
 * scale fixtures. KV uses the production merge with isolated in-memory records.
 * All profiles, credentials, workspace
 * files, relay state and evidence stay in temp.
 */
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const redact = value => String(value || '')
  .replace(/#invite=[^\s"'<>]*/g, '#invite=[redacted]')
  .replace(/\b[a-f0-9]{64}\b/gi, '[redacted]')

async function waitFor(label, probe, timeout = 30000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const result = await probe()
    if (result) return result
    await sleep(100)
  }
  throw new Error(`Timed out: ${label}`)
}

function progress(stage) { process.stdout.write(`[remote-ui] ${stage}\n`) }

async function stopOwnedProcess(child) {
  if (!child || child.exitCode !== null) return
  if (process.platform === 'win32') {
    await new Promise(resolve => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      killer.once('exit', resolve)
      killer.once('error', resolve)
    })
  } else child.kill('SIGTERM')
}

async function orchestrate() {
  const output = path.resolve(process.env.REMOTE_UI_OUTPUT || await fsp.mkdtemp(path.join(os.tmpdir(), 'clerkbox-remote-ui-')))
  await fsp.mkdir(output, { recursive: true })
  const origin = process.env.REMOTE_UI_ORIGIN || 'http://127.0.0.1:5195'
  const target = new URL(origin)
  const local = target.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(target.hostname)
  const production = target.origin === 'https://webui.clerkbox.xmzf.space' && process.env.REMOTE_UI_ALLOW_PRODUCTION === '1'
  assert.ok(local || production, 'Use local gateway, or explicitly enable the canonical production gateway test')
  assert.ok(fs.existsSync(path.join(root, 'dist-webui/index.html')), 'Build dist-webui first')
  let gateway
  const gatewayLogs = []
  const healthy = async () => {
    try { const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(production ? 10_000 : 1_000) }); return response.ok && (await response.json()).protocol === 1 }
    catch { return false }
  }
  try {
    if (!(await healthy())) {
      assert.ok(local, 'The production gateway must be deployed and healthy before this test')
      progress('starting isolated local Worker')
      const wrangler = path.join(root, 'workers/remote-gateway/node_modules/wrangler/bin/wrangler.js')
      assert.ok(fs.existsSync(wrangler), 'Install the remote-gateway subpackage first')
      gateway = spawn(process.execPath, [wrangler, 'dev', '--local', '--infer-origin-from-routes=false', '--ip', target.hostname, '--port', target.port || '5195', '--var', `PUBLIC_ORIGIN:${origin}`, '--var', 'ALLOW_LOCALHOST_ORIGINS:true', '--persist-to', path.join(output, 'worker-state')], {
        cwd: path.join(root, 'workers/remote-gateway'), windowsHide: true,
        env: { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
      })
      gateway.stdout.on('data', data => gatewayLogs.push(redact(data)))
      gateway.stderr.on('data', data => gatewayLogs.push(redact(data)))
      await waitFor('local Worker health', async () => {
        if (gateway.exitCode !== null) throw new Error(`Local Worker exited: ${gatewayLogs.join('').slice(-5000)}`)
        return healthy()
      }, 45000)
    } else progress(local ? 'using existing local Worker' : 'using canonical production Worker')

    const electron = require('electron')
    const env = { ...process.env, REMOTE_UI_CHILD: '1', REMOTE_UI_OUTPUT: output, REMOTE_UI_ORIGIN: origin, ELECTRON_ENABLE_LOGGING: '0', NO_COLOR: '1' }
    delete env.ELECTRON_RUN_AS_NODE
    // Isolate os.homedir() as well as Electron userData. No user memory/profile is read.
    env.USERPROFILE = path.join(output, 'home')
    const child = spawn(electron, [__filename], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let tail = ''
    child.stdout.on('data', data => {
      const safe = redact(data)
      tail = (tail + safe).slice(-12000)
      for (const line of safe.split(/\r?\n/)) if (line.startsWith('[remote-ui]')) process.stdout.write(`${line}\n`)
    })
    child.stderr.on('data', data => { tail = (tail + redact(data)).slice(-12000) })
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject)
      const timer = setTimeout(() => { void stopOwnedProcess(child); reject(new Error('Remote UI harness exceeded four minutes')) }, 240000)
      child.once('exit', code => { clearTimeout(timer); resolve(code) })
    })
    if (result !== 0) {
      await fsp.writeFile(path.join(output, 'gateway-failure.log'), gatewayLogs.join(''))
      throw new Error(`Remote UI integration failed. Evidence: ${output}\n${tail}`)
    }
    progress(`passed; evidence ${output}`)
  } finally {
    await stopOwnedProcess(gateway)
  }
}

async function runElectron() {
  const { app, BrowserWindow, ipcMain, session, nativeImage } = require('electron')
  const output = path.resolve(process.env.REMOTE_UI_OUTPUT)
  const origin = process.env.REMOTE_UI_ORIGIN
  const workspace = path.join(output, 'remote-ui-workspace')
  const otherWorkspace = path.join(output, 'other-project')
  const userData = path.join(output, 'electron-profile')
  const home = path.join(output, 'home')
  for (const directory of [workspace, otherWorkspace, userData, home]) fs.mkdirSync(directory, { recursive: true })
  app.setPath('userData', userData)
  app.setPath('home', home)
  app.commandLine.appendSwitch('disable-background-timer-throttling')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  app.commandLine.appendSwitch('force-device-scale-factor', '1')
  await app.whenReady()
  app.on('window-all-closed', () => {})
  const report = { ok: false, upstream: 'local OpenAI SSE test fixture; no real model or key', gateway: origin === 'https://webui.clerkbox.xmzf.space' ? 'canonical production Cloudflare Worker' : 'local real Wrangler Worker', database: '', stage: 'initialize', checks: [], captures: [], errors: [], upstreamRequests: 0 }
  let server
  let service
  let store
  let window
  let inviteWindow
  let manager
  let savedCredential = null
  const logs = []
  const statuses = []
  const transport = []
  const prompt = 'REMOTE_UI_E2E: 请确认浏览器到桌面 Agent 的真实链路。'
  const reply = '真实远程链路已验证。此回复来自隔离的本地 SSE 测试模型，已由桌面 Agent 写入 SQLite。'
  const upstreamCalls = []
  const statePatches = []
  const hydrationFault = { settingsReads: 0, interruptedReads: 0, injected: false, released: false, disconnected: false }
  report.hydrationRecovery = hydrationFault
  const pngBytes = nativeImage.createFromBitmap(Buffer.from([0, 0, 255, 255, 255, 90, 0, 255, 80, 180, 40, 255, 150, 60, 180, 255]), { width: 2, height: 2 }).toPNG()
  const pngBase64 = pngBytes.toString('base64')
  const pngDataUrl = `data:image/png;base64,${pngBase64}`
  const finishStage = stage => { report.stage = stage; progress(stage) }
  const check = (name, detail = {}) => { report.checks.push({ name, ok: true, ...detail }) }

  async function browserEval(code) { return window.webContents.executeJavaScript(code, true) }
  async function assertNoRunError(label) {
    const alerts = await browserEval(`[...document.querySelectorAll('.workspace-chat [role="alert"]')].map(element => element.textContent.trim()).filter(Boolean)`)
    assert.deepEqual(alerts, [], `${label}: the actual conversation displays a runtime error`)
  }
  async function verifyVisibleAssistant(label, reveal = false) {
    await assertNoRunError(label)
    await waitFor(`${label}: rendered assistant response`, () => browserEval(`[...document.querySelectorAll('.message-action-scope .markdown-body')].some(element => element.textContent.trim() === ${JSON.stringify(reply)})`))
    if (reveal) await browserEval(`[...document.querySelectorAll('.message-action-scope .markdown-body')].find(element => element.textContent.trim() === ${JSON.stringify(reply)}).scrollIntoView({block:'center'})`)
    await browserEval(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
    await waitFor(`${label}: assistant response visibly inside the message viewport`, () => browserEval(`(() => {
      const element = [...document.querySelectorAll('.message-action-scope .markdown-body')].find(node => node.textContent.trim() === ${JSON.stringify(reply)});
      if (!element || getComputedStyle(element).visibility !== 'visible') return false;
      const bounds = element.getBoundingClientRect();
      let top = 0, left = 0, right = innerWidth, bottom = innerHeight;
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0 || parent.hidden || parent.inert || parent.getAttribute('aria-hidden') === 'true') return false;
        const clip = parent.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom); }
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { left = Math.max(left, clip.left); right = Math.min(right, clip.right); }
      }
      const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
      return bounds.width > 0 && bounds.height > 0 && bounds.top >= top - 1 && bounds.bottom <= bottom + 1 && bounds.left >= left - 1 && bounds.right <= right + 1 && (hit === element || element.contains(hit));
    })()`))
    await assertNoRunError(label)
  }
  async function verifyHistoryImage(label) {
    await waitFor(`${label}: path attachment reference`, () => browserEval(`[...document.querySelectorAll('.message-action-scope figure')].some(figure => figure.querySelector('figcaption')?.textContent.includes('remote-e2e.png'))`))
    await browserEval(`[...document.querySelectorAll('.message-action-scope figure')].find(figure => figure.querySelector('figcaption')?.textContent.includes('remote-e2e.png')).scrollIntoView({block:'center'})`)
    await waitFor(`${label}: visible decoded path image preview`, () => browserEval(`(() => {
      const image = document.querySelector('.message-action-scope figure img[alt="remote-e2e.png"]');
      if (!image || !image.complete || image.naturalWidth !== 2 || image.naturalHeight !== 2) return false;
      const box = image.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < innerHeight && box.right > 0 && box.left < innerWidth;
    })()`))
    assert.equal(await browserEval(`document.querySelector('.message-action-scope figure img[alt="remote-e2e.png"]').currentSrc`), pngDataUrl, `${label}: preview bytes differ from the uploaded PNG`)
  }
  async function capture(scene, width, height = 900) {
    // A hidden native window can retain its last compositor frame when its
    // size is unchanged. Force a real resize before taking review evidence.
    window.setContentSize(width + 1, height)
    await sleep(100)
    window.setContentSize(width, height)
    await browserEval(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
    await sleep(450)
    if (scene === 'conversation') await verifyVisibleAssistant(`${scene}/${width}`, true)
    const dimensions = await browserEval(`(() => {
      const input = document.querySelector('textarea');
      const send = document.querySelector('.chat-toolbar-send');
      const assistant = [...document.querySelectorAll('.message-action-scope .markdown-body')].find(element => element.textContent.trim() === ${JSON.stringify(reply)});
      const box = element => { if (!element) return null; const r = element.getBoundingClientRect(); return { x:r.x, right:r.right, width:r.width, bottom:r.bottom }; };
      return { viewport:innerWidth, page:document.documentElement.scrollWidth, body:document.body.scrollWidth, input:box(input), send:box(send), assistant:box(assistant) };
    })()`)
    assert.ok(dimensions.page <= dimensions.viewport + 1, `${scene}/${width}: document horizontal overflow`)
    assert.ok(dimensions.body <= dimensions.viewport + 1, `${scene}/${width}: body horizontal overflow`)
    if (dimensions.send) assert.ok(dimensions.send.x >= -1 && dimensions.send.right <= dimensions.viewport + 1, `${scene}/${width}: send control outside viewport`)
    const file = path.join(output, `${scene}-${width}.png`)
    await fsp.writeFile(file, (await window.webContents.capturePage()).toPNG())
    report.captures.push({ scene, width, height, file, dimensions })
  }

  try {
    await fsp.writeFile(path.join(workspace, 'README.md'), '# Remote UI integration fixture\n\nThis workspace is temporary.\n')
    server = http.createServer(async (request, response) => {
      try {
        if (request.url !== '/v1/chat/completions' || request.method !== 'POST') { response.writeHead(404); response.end(); return }
        let raw = ''
        for await (const chunk of request) raw += chunk
        const body = JSON.parse(raw)
        const hasImage = (body.messages || []).some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url' && part.image_url?.url === pngDataUrl))
        upstreamCalls.push({ stream: body.stream === true, model: body.model, hasPrompt: JSON.stringify(body.messages).includes(prompt), hasImage })
        if (request.headers.authorization !== 'Bearer local-test-key-not-a-real-credential') { response.writeHead(401); response.end(); return }
        if (!body.stream) {
          response.writeHead(200, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify({ id: 'local-title', choices: [{ message: { role: 'assistant', content: '远程链路验证' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } }))
          return
        }
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
        const event = (delta, finish = null, usage) => `data: ${JSON.stringify({ id: 'chatcmpl-local-e2e', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`
        response.write(event({ role: 'assistant', content: reply.slice(0, 13) }))
        await sleep(100)
        response.write(event({ content: reply.slice(13) }))
        response.write(event({}, 'stop', { prompt_tokens: 20, completion_tokens: 25, total_tokens: 45 }))
        response.end('data: [DONE]\n\n')
      } catch { response.writeHead(500); response.end('Local fixture error') }
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const modelBase = `http://127.0.0.1:${server.address().port}/v1`
    const { createChatStore, registerDbIpcHandlers } = require(path.join(root, 'dist-electron/electron/db.js'))
    const { handlerRegistry } = require(path.join(root, 'dist-electron/electron/webui-server.js'))
    const { AgentSessionManager, installAgentHostBridge, setAgentHostWindowProbeForTest } = require(path.join(root, 'dist-electron/electron/agent-host.js'))
    const { RemoteAccessService } = require(path.join(root, 'dist-electron/electron/remote-access.js'))
    const { mergeRemoteState } = require(path.join(root, 'dist-electron/electron/remote-state.js'))
    const { publishRemoteUiEvent } = require(path.join(root, 'dist-electron/electron/remote-ui-events.js'))
    const { messageToRow } = require(path.join(root, 'dist-electron/src/lib/chat-row.js'))
    const originalHandle = ipcMain.handle.bind(ipcMain)
    ipcMain.handle = (channel, handler) => { handlerRegistry.set(channel, handler); return originalHandle(channel, handler) }
    store = await createChatStore({ userDataDir: userData, wasmBinary: fs.readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm')) })
    assert.equal(store.kind, 'sqlite', 'This integration must exercise the real SQLite engine')
    report.database = store.kind
    registerDbIpcHandlers(store)
    installAgentHostBridge()
    // Sessions deliberately span sibling folders and include an unbound chat.
    // A full-workbench pairing must see all of them without a selected root.
    const fixtureSessions = [
      { id: 'remote-fixture-a', title: 'REMOTE_FIXTURE_PROJECT_A', working_dir: workspace },
      { id: 'remote-fixture-b', title: 'REMOTE_FIXTURE_PROJECT_B', working_dir: otherWorkspace },
      { id: 'remote-fixture-unbound', title: 'REMOTE_FIXTURE_NO_FOLDER', working_dir: null },
      ...Array.from({ length: 100 }, (_, index) => ({
        id: `remote-scale-${String(index + 1).padStart(3, '0')}`,
        title: `REMOTE_SCALE_HISTORY_${String(index + 1).padStart(3, '0')}`,
        working_dir: index % 3 === 0 ? null : index % 3 === 1 ? workspace : otherWorkspace,
      })),
    ]
    const fixtureCreatedAt = Date.now() - 10000
    for (const fixture of fixtureSessions) {
      await store.createSession({ ...fixture, created_at: fixtureCreatedAt, updated_at: fixtureCreatedAt, harness_mode: 'default' })
      // The real sidebar intentionally omits empty drafts on desktop and web.
      // Seed actual history so these are existing conversations, not empty shells.
      await store.addMessage(messageToRow({ id: `${fixture.id}-history`, role: 'user', content: `Existing conversation: ${fixture.title}`, timestamp: fixtureCreatedAt }, fixture.id))
      await store.addMessage(messageToRow({ id: `${fixture.id}-answer`, role: 'assistant', content: `Synthetic history retained for ${fixture.title}.`, timestamp: fixtureCreatedAt + 1 }, fixture.id))
    }
    // Trusted desktop-only configuration. The remote browser receives a redacted projection.
    const model = { id: 'local-vision-integration-test', label: '本地集成测试模型', maxTokens: 1000, maxInputTokens: 184000, supportsThinking: false, supportsImages: true }
    const alternateModel = { ...model, id: 'local-vision-alternate-test', label: '远程切换验证模型' }
    const provider = { id: 'local-fixture', name: 'Local integration fixture', baseUrl: modelBase, apiKey: 'local-test-key-not-a-real-credential', apiCompat: 'openai', models: [model, alternateModel] }
    const providers = [provider, ...Array.from({ length: 7 }, (_, index) => ({
      ...provider, id: `remote-scale-provider-${index + 1}`, name: `REMOTE_SCALE_PROVIDER_${index + 1}`,
      apiKey: `remote-scale-fixture-secret-${index + 1}`,
      models: Array.from({ length: 12 }, (_, modelIndex) => ({ ...model, id: `remote-scale-model-${index + 1}-${modelIndex + 1}`, label: `Scale model ${index + 1}.${modelIndex + 1}` })),
    }))]
    const mcpServers = Array.from({ length: 12 }, (_, index) => ({
      id: `remote-scale-mcp-${index + 1}`, name: `REMOTE_SCALE_MCP_${index + 1}`, transport: 'http', enabled: false,
      url: `${modelBase}/mcp/fixture-${index + 1}`,
      headers: { Authorization: `Bearer remote-scale-mcp-secret-${index + 1}`, 'X-Fixture-Metadata': `isolated-test-only-${'metadata-'.repeat(120)}` },
    }))
    const settings = { model: model.id, activeModelId: model.id, activeProviderId: provider.id, apiCompat: 'openai', providers, mcpServers, baseUrl: modelBase, apiKey: provider.apiKey, temperature: 0.2, maxTokens: 1000, maxInputTokens: 184000, enableThinking: false, directFetch: false, approvalMode: 'manual', browserUseEnabled: false, computerUseEnabled: false, agentsMdEnabled: false, claudeMdCompat: false, permissionRules: [] }
    report.scale = { sessions: fixtureSessions.length, providers: providers.length, models: providers.reduce((sum, item) => sum + item.models.length, 0), mcpServers: mcpServers.length }
    const kv = new Map([
      ['clerkbox-settings', JSON.stringify({ state: { theme: 'dark', language: 'zh-CN', interfaceMode: 'coding', hasCompletedOnboarding: true, ...settings }, version: 0 })],
      ['clerkbox-skills', JSON.stringify({ state: { skills: [], sessionSkillIds: [] }, version: 0 })],
    ])
    const savedSettings = () => JSON.parse(kv.get('clerkbox-settings')).state
    handlerRegistry.set('kvGet', (_event, key) => {
      if (key === 'clerkbox-settings') {
        hydrationFault.settingsReads++
        if (hydrationFault.settingsReads > 1 && !hydrationFault.released) {
          hydrationFault.interruptedReads++
          if (!hydrationFault.injected) {
            hydrationFault.injected = true
            // The first read built the authenticated bootstrap. Reject the real
            // persist KV read, then interrupt the actual host transport before
            // a retry can hydrate settings. Release at that boundary so the
            // reconnect bootstrap itself can read settings normally.
            setTimeout(() => {
              hydrationFault.disconnected = true
              hydrationFault.released = true
              service.socket.close()
            }, 40)
          }
          throw new Error('remoteAccess.cloudDisconnected')
        }
      }
      return kv.get(key) ?? null
    })
    handlerRegistry.set('kvSet', (_event, key, value) => { kv.set(key, value); publishRemoteUiEvent('shared:changed', key) })
    handlerRegistry.set('kvRemove', (_event, key) => { kv.delete(key); publishRemoteUiEvent('shared:changed', key) })
    let patchQueue = Promise.resolve()
    handlerRegistry.set('remote:state.patch', (_event, input) => {
      const write = patchQueue.then(() => {
        const value = mergeRemoteState(input.name, kv.get(input.name) ?? null, input.base, input.value)
        if (value === null) kv.delete(input.name)
        else kv.set(input.name, value)
        statePatches.push({ name: input.name })
        publishRemoteUiEvent('shared:changed', input.name)
        return { value }
      })
      patchQueue = write.catch(() => {})
      return write
    })
    handlerRegistry.set('loadApiKeys', () => Object.fromEntries(providers.map(item => [item.id, item.apiKey])))
    handlerRegistry.set('accountGetStatus', () => ({ loggedIn: false, lastSyncAt: {} }))
    handlerRegistry.set('accountSyncGetPassphraseStatus', () => ({ set: false }))
    handlerRegistry.set('jouleGetState', () => ({ status: 'unlinked', user: null, subscription: null, expired: null, plan: null, quotas: null, desktop: null, models: [], login: null, lastSyncAt: null, stale: false, error: null, serverNow: null }))
    handlerRegistry.set('mcpStatus', () => mcpServers.map(item => ({ id: item.id, name: item.name, transport: item.transport, enabled: false, state: 'disabled', toolCount: 0, tools: [] })))
    handlerRegistry.set('mcpTools', () => [])
    handlerRegistry.set('scanSkillDirs', () => '[]')
    handlerRegistry.set('initClerkbox', async (_event, directory) => {
      assert.ok(!path.relative(output, directory).startsWith('..'), 'Fixture initialization escaped its temp profile')
      await fsp.mkdir(path.join(directory, '.clerkbox'), { recursive: true })
    })
    manager = new AgentSessionManager(store)
    manager.noteLocalSettings(settings)
    // A browser is never treated as a trusted local approval window.
    setAgentHostWindowProbeForTest(() => [])
    service = new RemoteAccessService({ store, manager, origin, readCredential: async () => savedCredential, writeCredential: async value => { savedCredential = value }, deleteCredential: async () => { savedCredential = null }, notify: status => { statuses.push({ state: status.state, pending: status.pending.length, online: status.devices.filter(device => device.online).length }) } })

    const browserSession = session.fromPartition('persist:remote-ui-integration')
    browserSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
      let allowed = false
      try {
        const requested = new URL(details.url)
        const gateway = new URL(origin)
        const socketProtocol = gateway.protocol === 'https:' ? 'wss:' : 'ws:'
        allowed = requested.origin === gateway.origin || (requested.host === gateway.host && requested.protocol === socketProtocol) || ['127.0.0.1', 'localhost'].includes(requested.hostname)
      } catch {}
      callback({ cancel: !allowed })
    })
    browserSession.webRequest.onErrorOccurred(details => { if (details.resourceType === 'webSocket') transport.push({ source: 'browser', error: details.error }) })
    browserSession.webRequest.onBeforeSendHeaders((details, callback) => { if (details.resourceType === 'webSocket') transport.push({ source: 'browser', handshakeOrigin: details.requestHeaders.Origin || details.requestHeaders.origin }); callback({ requestHeaders: details.requestHeaders }) })
    browserSession.webRequest.onHeadersReceived((details, callback) => { if (details.resourceType === 'webSocket') transport.push({ source: 'browser', handshakeStatus: details.statusCode }); callback({}) })
    window = new BrowserWindow({ width: 1280, height: 900, useContentSize: true, show: false, backgroundColor: '#131417', webPreferences: { session: browserSession, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    window.webContents.on('console-message', details => {
      const { level, message } = details
      if (level === 'error' || level === 3) report.errors.push(redact(message))
      else if (message) logs.push(redact(message))
    })
    window.webContents.on('render-process-gone', (_event, detail) => report.errors.push(`Renderer exited: ${detail.reason}`))
    window.webContents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => { if (mainFrame && code !== -3) report.errors.push(`Page load failed: ${code}`) })
    window.webContents.debugger.attach('1.3')
    window.webContents.debugger.on('message', (_event, method, params) => {
      if (!method.startsWith('Network.webSocket')) return
      const item = { source: 'browser', event: method.slice('Network.'.length) }
      if (params.errorMessage) item.error = params.errorMessage
      if (params.response?.status) item.status = params.response.status
      if (params.response?.payloadData) {
        try { const frame = JSON.parse(params.response.payloadData); item.type = frame.type; if (frame.payload) item.payloadKeys = Object.keys(frame.payload) } catch {}
      }
      transport.push(item)
    })

    finishStage('entry layouts')
    await window.loadURL(origin)
    await window.webContents.debugger.sendCommand('Network.enable')
    await waitFor('remote entry', () => browserEval(`!!document.querySelector('.remote-entry-card')`))
    await capture('entry', 1280)
    await capture('entry', 390, 844)
    check('entry renders at desktop and phone widths')

    finishStage('real relay pairing')
    const enabled = await service.enable({ scope: 'desktop', approve: true, files: true })
    service.socket.addEventListener('message', event => { try { const frame = JSON.parse(event.data); transport.push({ source: 'host', type: frame.type, invited: frame.invited, authorized: frame.authorized, payloadKeys: frame.payload ? Object.keys(frame.payload) : undefined }) } catch {} })
    assert.equal(enabled.state, 'online')
    assert.equal(enabled.scope, 'desktop', 'Remote access must not require a project folder')
    assert.ok(enabled.url, 'Real service did not generate an invitation')
    window.setContentSize(1280, 900)
    // Exercise the real entry form. A fragment-only navigation in an already
    // loaded document does not remount the app, unlike opening a fresh invite.
    await browserEval(`(() => { const input = document.querySelector('#remote-invite-link'); input.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(enabled.url)}); input.dispatchEvent(new Event('input', {bubbles:true})); return true; })()`)
    await waitFor('enabled invitation control', () => browserEval(`!!document.querySelector('.remote-invite-form button:not(:disabled)')`))
    await browserEval(`document.querySelector('.remote-invite-form button').click()`)
    const pair = await waitFor('desktop pairing request', () => service.getStatus().pending[0], 25000)
    const code = await waitFor('browser verification code', () => browserEval(`document.querySelector('.remote-pair-code')?.textContent || ''`))
    assert.equal(code, pair.code, 'Browser and desktop must display the same verification code')
    assert.equal(await browserEval(`location.hash`), '', 'Invitation credentials must be removed from the address bar')
    await service.approvePair(pair.id, true)
    finishStage('interrupted first settings hydration and automatic recovery')
    await waitFor('first authenticated settings KV read interrupted', () => hydrationFault.injected && hydrationFault.interruptedReads > 0)
    await waitFor('actual host transport interrupted during initial hydration', () => hydrationFault.disconnected && statuses.some(status => status.state === 'reconnecting'))
    // attachAgentEvents can still be replaying history before the lazy App mounts;
    // both that Suspense card and App's hydration card must clearly explain load.
    await waitFor('interrupted hydration displays an explicit workbench loading state', () => browserEval(`!document.querySelector('textarea') && [...document.querySelectorAll('main h1')].some(heading => heading.textContent.includes('正在载入桌面工作台')) && !!document.querySelector('main [role="status"]')`))
    assert.equal(await browserEval(`!!document.querySelector('.remote-recovery') || document.body.innerText.includes('此连接已失去授权')`), false, 'A temporary initial disconnect was presented as revoked access')
    await capture('initial-hydration-interrupted', 1280)
    await waitFor('authenticated real workbench', () => browserEval(`!!document.querySelector('.remote-connection-bar.is-connected') && !!document.querySelector('textarea')`), 45000)
    await waitFor('all history loaded after interrupted bootstrap hydration', () => browserEval(`${JSON.stringify(fixtureSessions.map(item => item.title))}.every(title => [...document.querySelectorAll('.sidebar-session-row button[title]')].some(button => button.title === title))`), 45000)
    assert.equal(service.getStatus().devices.length, 1, 'A recoverable initial disconnect lost the paired browser')
    assert.equal(service.getStatus().pending.length, 0, 'Initial hydration recovery requested a second pairing')
    assert.ok(service.getStatus().devices[0].online, 'Desktop device status remained offline after initial hydration recovery')
    assert.equal(await browserEval(`!!document.querySelector('#workbench-loading-title')`), false, 'Recovered browser remained stuck behind the hydration fallback')
    report.hydrationRecovery = { ...hydrationFault }
    check('the first post-bootstrap settings KV rejection and real transport interruption recover without reload or re-pairing; 103 historical conversations render')
    assert.equal(await browserEval(`Object.values(localStorage).some(value => value.includes('local-test-key-not-a-real-credential') || value.includes('remote-scale-fixture-secret-') || value.includes('remote-scale-mcp-secret-') || value.includes(${JSON.stringify(modelBase)}))`), false, 'Desktop model or MCP secrets leaked into browser storage')
    check('real invitation, matching code, desktop approval and redacted bootstrap')

    finishStage('complete workbench and cross-folder conversations')
    await waitFor('all desktop conversations, including another folder and unbound chat', () => browserEval(`${JSON.stringify(fixtureSessions.map(item => item.title))}.every(title => [...document.querySelectorAll('.sidebar-session-row button[title]')].some(button => button.title === title))`))
    for (const title of [fixtureSessions[0].title, fixtureSessions[2].title, fixtureSessions[1].title]) {
      await browserEval(`[...document.querySelectorAll('.sidebar-session-row button[title]')].find(button => button.title === ${JSON.stringify(title)}).click()`)
      await waitFor(`active desktop session ${title}`, () => browserEval(`[...document.querySelectorAll('.sidebar-session-row button[title]')].some(button => button.title === ${JSON.stringify(title)} && button.getAttribute('aria-current') === 'page')`))
    }
    check('full pairing lists and switches conversations from sibling folders and conversations without a folder')

    // Use actual settings controls. A browser must receive the full settings
    // page and write back through the host merge, rather than browser-only KV.
    await browserEval(`[...document.querySelectorAll('aside button')].find(button => button.textContent.trim() === '设置').click()`)
    await waitFor('full desktop settings tabs', () => browserEval(`['api','mcp','general','appearance','account','about'].every(tab => !!document.querySelector('#settings-tab-' + tab))`))
    await browserEval(`document.querySelector('#settings-tab-api').click()`)
    await waitFor('all configured providers survived large bootstrap and hydration recovery', () => browserEval(`${JSON.stringify(providers.map(item => item.name))}.every(name => document.querySelector('#settings-tabpanel')?.textContent.includes(name))`))
    await browserEval(`document.querySelector('#settings-tab-mcp').click()`)
    await waitFor('all configured MCP servers survived large bootstrap and hydration recovery', () => browserEval(`${JSON.stringify(mcpServers.map(item => item.name))}.every(name => document.querySelector('#settings-tabpanel')?.textContent.includes(name))`))
    await capture('scaled-mcp-settings', 1280)
    check('large real startup retains every configured provider and MCP server in the actual desktop settings pages', report.scale)
    await browserEval(`document.querySelector('#settings-tab-appearance').click()`)
    await waitFor('appearance controls', () => browserEval(`document.querySelector('#settings-tab-appearance')?.getAttribute('aria-selected') === 'true' && [...document.querySelectorAll('#settings-tabpanel button')].some(button => button.textContent.trim() === '浅色')`))
    await browserEval(`[...document.querySelectorAll('#settings-tabpanel button')].find(button => button.textContent.trim() === '浅色').click()`)
    await waitFor('browser appearance setting saved on host', () => savedSettings().theme === 'light')
    assert.ok(statePatches.some(patch => patch.name === 'clerkbox-settings'), 'Browser settings bypassed the shared state merge')
    assert.equal(savedSettings().providers[0].apiKey, provider.apiKey, 'A redacted form cleared the desktop credential')
    await capture('full-settings', 1280)
    // Simulate a desktop setting change through the same host queue and verify
    // the open browser consumes the real encrypted shared-state notification.
    const desktopBase = kv.get('clerkbox-settings')
    const desktopState = JSON.parse(desktopBase)
    desktopState.state.theme = 'dark'
    await handlerRegistry.get('remote:state.patch')(null, { name: 'clerkbox-settings', base: desktopBase, value: JSON.stringify(desktopState) })
    await waitFor('desktop setting appears in connected browser', () => browserEval(`document.documentElement.classList.contains('dark')`))
    await browserEval(`document.querySelector('[role=dialog] button[aria-label="关闭"]').click()`)
    await waitFor('settings closed', () => browserEval(`!document.querySelector('#settings-tabpanel')`))
    check('the full six-tab settings page persists browser edits to host, preserves credentials and receives desktop edits live')

    finishStage('model switch through actual composer controls')
    await browserEval(`document.querySelector('button[aria-controls="chat-model-menu"]').click()`)
    await waitFor('model root menu', () => browserEval(`!!document.querySelector('#chat-model-menu')`))
    await browserEval(`[...document.querySelectorAll('#chat-model-menu button')].find(button => button.textContent.includes('自定义模型')).click()`)
    await waitFor('configured host provider in model menu', () => browserEval(`[...document.querySelectorAll('#chat-model-menu button')].some(button => button.textContent.includes(${JSON.stringify(provider.name)}))`))
    await browserEval(`[...document.querySelectorAll('#chat-model-menu button')].find(button => button.textContent.includes(${JSON.stringify(provider.name)})).click()`)
    await waitFor('alternate host model in selector', () => browserEval(`[...document.querySelectorAll('#chat-model-menu button')].some(button => button.textContent.includes(${JSON.stringify(alternateModel.label)}))`))
    await browserEval(`[...document.querySelectorAll('#chat-model-menu button')].find(button => button.textContent.includes(${JSON.stringify(alternateModel.label)})).click()`)
    await waitFor('model selection committed to actual host settings', () => savedSettings().activeModelId === alternateModel.id && manager.getLocalSettingsSnapshot()?.model === alternateModel.id)
    await capture('full-workbench', 1280)
    check('actual browser model selector updates the desktop model while retaining host-only credentials')

    finishStage('paired browser reopening an invitation')
    const pairedInvite = await service.createInvite()
    await window.loadURL(pairedInvite.url)
    await waitFor('paired browser enters with persistent credential', () => browserEval(`!!document.querySelector('.remote-connection-bar.is-connected') && !!document.querySelector('textarea')`), 45000)
    report.pairedReconnectEarlyReady = await browserEval(`({ composerBusy:document.querySelector('input[type=file]')?.closest('[aria-busy]')?.getAttribute('aria-busy'), listedConversations:document.querySelectorAll('.sidebar-session-row').length, activeConversation:document.querySelector('.sidebar-session-row button[aria-current="page"]')?.title || null })`)
    assert.notEqual(report.pairedReconnectEarlyReady.composerBusy, 'true', 'Remote input/upload was exposed before session initialization')
    assert.equal(report.pairedReconnectEarlyReady.activeConversation, fixtureSessions[1].title, 'Remote composer became interactive before restoring its actual selected session')
    // A connected transport and an initial empty composer precede async history
    // hydration. Wait for the actual selected conversation before uploading into
    // it, otherwise the fixture targets the short-lived empty-session composer.
    await waitFor('paired browser restores complete history and selected conversation', () => browserEval(`${JSON.stringify(fixtureSessions.map(item => item.title))}.every(title => [...document.querySelectorAll('.sidebar-session-row button[title]')].some(button => button.title === title)) && !!document.querySelector('.sidebar-session-row button[aria-current="page"][title="${fixtureSessions[1].title}"]') && !document.querySelector('.workspace-chat [aria-busy="true"]')`), 45000)
    assert.equal(service.getStatus().pending.length, 0, 'A paired browser must not create a second desktop pairing request')
    assert.equal(await browserEval(`location.hash`), '', 'A paired browser must still remove invitation credentials')
    check('paired browser reopening an invitation connects directly with its persistent credential and creates no pending request')

    finishStage('direct invitation link and desktop rejection')
    const direct = await service.createInvite()
    assert.ok(direct.url)
    // Use an isolated browser profile for the rejection path. The main browser
    // has already been paired, so the real product intentionally reuses its
    // saved device credential when it scans another invitation.
    const unpairedSession = session.fromPartition('persist:remote-ui-unpaired')
    inviteWindow = new BrowserWindow({ width: 390, height: 844, useContentSize: true, show: false, webPreferences: { session: unpairedSession, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    inviteWindow.webContents.on('console-message', details => {
      const { level, message } = details
      if (level === 'error' || level === 3) report.errors.push(redact(message))
    })
    await inviteWindow.loadURL(direct.url)
    const directPair = await waitFor('fresh document invitation pairing request', () => service.getStatus().pending[0])
    const directCode = await waitFor('fresh invitation verification code', () => inviteWindow.webContents.executeJavaScript(`document.querySelector('.remote-pair-code')?.textContent || ''`))
    assert.equal(directCode, directPair.code)
    assert.equal(await inviteWindow.webContents.executeJavaScript('location.hash'), '', 'Direct invitation fragment must be removed immediately')
    await service.approvePair(directPair.id, false)
    await waitFor('desktop rejection feedback', () => inviteWindow.webContents.executeJavaScript(`!!document.querySelector('.remote-error')`))
    assert.equal(service.getStatus().pending.length, 0)
    const hashInvite = await service.createInvite()
    await inviteWindow.loadURL(hashInvite.url)
    const hashPair = await waitFor('same document invitation pairing request', () => service.getStatus().pending[0])
    const hashCode = await waitFor('same document verification code', () => inviteWindow.webContents.executeJavaScript(`document.querySelector('.remote-pair-code')?.textContent || ''`))
    assert.equal(hashCode, hashPair.code)
    assert.equal(await inviteWindow.webContents.executeJavaScript('location.hash'), '')
    await service.approvePair(hashPair.id, false)
    await waitFor('same document rejection feedback', () => inviteWindow.webContents.executeJavaScript(`!!document.querySelector('.remote-error')`))
    inviteWindow.destroy()
    inviteWindow = null
    check('fresh and same-document direct invitations consume their fragment, match desktop codes and display desktop rejection')

    finishStage('real browser message and desktop run')
    report.uploadStart = await browserEval(`({ composerBusy:document.querySelector('input[type=file]')?.closest('[aria-busy]')?.getAttribute('aria-busy'), activeConversation:document.querySelector('.sidebar-session-row button[aria-current="page"]')?.title || null })`)
    await browserEval(`(() => { const input = document.querySelector('input[type=file]'); if (!input) throw new Error('Real upload input missing'); const bytes = Uint8Array.from(atob(${JSON.stringify(pngBase64)}), char => char.charCodeAt(0)); const transfer = new DataTransfer(); transfer.items.add(new File([bytes], 'remote-e2e.png', {type:'image/png'})); input.files = transfer.files; input.dispatchEvent(new Event('change', {bubbles:true})); return true; })()`)
    await waitFor('uploaded image thumbnail', () => browserEval(`!!document.querySelector('img[alt="remote-e2e.png"]')`))
    await browserEval(`(() => { const input = document.querySelector('textarea'); input.focus(); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(prompt)}); input.dispatchEvent(new Event('input', {bubbles:true})); return true; })()`)
    await waitFor('enabled send control', () => browserEval(`!!document.querySelector('.chat-toolbar-send:not(:disabled)')`))
    await browserEval(`document.querySelector('.chat-toolbar-send').click()`)
    const persisted = await waitFor('real host reply persisted', async () => {
      const sessions = await store.getAllSessions()
      for (const row of sessions) {
        const messages = await store.getMessages(row.id)
        if (messages.some(message => message.role === 'user' && message.content === prompt) && messages.some(message => message.role === 'assistant' && message.content.includes(reply))) return { sessionId: row.id, messages }
      }
      return false
    }, 45000)
    await waitFor('host run idle', () => manager.inspect().every(item => !item.hasRun))
    const runErrors = manager.peekRing(persisted.sessionId).filter(event => (event.type === 'run.status' && event.error) || (event.type === 'notify' && event.kind === 'error'))
    assert.deepEqual(runErrors, [], 'The host emitted a runtime error after the model response')
    await assertNoRunError('completed host run')
    assert.ok(upstreamCalls.some(call => call.stream && call.hasPrompt), 'Real agent loop did not call the local model upstream')
    assert.ok(upstreamCalls.some(call => call.stream && call.hasPrompt && call.model === alternateModel.id), 'The desktop run ignored the browser-selected model')
    assert.ok(upstreamCalls.some(call => call.stream && call.hasPrompt && call.hasImage), 'Uploaded PNG bytes did not reach the real model request through the host image path fallback')
    const userRow = persisted.messages.find(message => message.role === 'user' && message.content === prompt)
    const uploaded = (typeof userRow.attachments === 'string' ? JSON.parse(userRow.attachments) : userRow.attachments).find(attachment => attachment.name === 'remote-e2e.png')
    assert.ok(uploaded?.path, 'Uploaded image path was not persisted in the user message')
    assert.equal(uploaded.dataUrl, undefined, 'Remote commands must not duplicate the uploaded image as a data URL')
    assert.ok(!path.relative(home, uploaded.path).startsWith('..'), 'Uploaded image escaped the isolated host home')
    assert.deepEqual(await fsp.readFile(uploaded.path), pngBytes, 'Uploaded image bytes changed before host execution')
    assert.equal(persisted.sessionId, fixtureSessions[1].id, 'Sending after cross-folder switching ran in another conversation')
    check('real file input uploads a PNG to the isolated host and the selected cross-folder conversation runs the selected model with identical image bytes')
    await verifyVisibleAssistant('completed reply without manual scrolling')
    await verifyHistoryImage('sent message')
    check('path-only sent image displays a decoded preview with identical uploaded PNG bytes in the actual message DOM')
    store.flush()
    const reopened = await createChatStore({ userDataDir: userData, wasmBinary: fs.readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm')) })
    const rowsOnDisk = await reopened.getMessages(persisted.sessionId)
    assert.ok(rowsOnDisk.some(message => message.role === 'assistant' && message.content.includes(reply)))
    check('browser message executes the actual desktop agent and persists reply in SQLite', { messages: rowsOnDisk.length })
    await capture('conversation', 1280)
    await capture('conversation', 390, 844)
    check('the host finishes without a runtime error and the real assistant response is visibly rendered at desktop and phone widths')

    finishStage('browser refresh and saved-device reconnect')
    window.webContents.reload()
    await waitFor('saved device entry after refresh', () => browserEval(`!!document.querySelector('.remote-known-device > button:first-child')`))
    await browserEval(`document.querySelector('.remote-known-device > button:first-child').click()`)
    await waitFor('authenticated after refresh', () => browserEval(`!!document.querySelector('.remote-connection-bar.is-connected')`))
    await waitFor('reconnected after refresh', () => browserEval(`!!document.querySelector('.remote-connection-bar.is-connected') && document.body.innerText.includes(${JSON.stringify(reply)})`), 30000)
    await verifyVisibleAssistant('refreshed history')
    await verifyHistoryImage('refreshed history')
    check('refresh restores and visibly decodes the actual path-only image attachment from desktop history')
    assert.equal(service.getStatus().pending.length, 0)
    assert.equal((await store.getMessages(persisted.sessionId)).filter(message => message.role === 'user' && message.content === prompt).length, 1, 'Refresh duplicated a submitted request')
    check('browser refresh reconnects with existing approval and preserves history without duplicate submission')

    finishStage('actual host transport interruption and recovery')
    const before = statuses.length
    // Fault injection closes the actual outbound transport; no method or result is mocked.
    service.socket.close()
    await waitFor('host reports lost transport', () => statuses.slice(before).some(status => status.state === 'reconnecting'))
    await waitFor('host and browser recover', async () => service.getStatus().state === 'online' && service.getStatus().devices.some(device => device.online) && await browserEval(`!!document.querySelector('.remote-connection-bar.is-connected')`), 35000)
    check('real host disconnect recovers through Worker peer replay and authenticated browser handshake')

    finishStage('device revocation and reconnect denial')
    const device = service.getStatus().devices[0]
    assert.ok(device?.online)
    const requestsBeforeRevocation = upstreamCalls.length
    await service.revokeDevice(device.id)
    await waitFor('browser revocation feedback', () => browserEval(`!!document.querySelector('.remote-recovery') || !!document.querySelector('.remote-error')`), 15000)
    assert.equal(service.getStatus().devices.length, 0)
    const rejection = await browserEval(`(async () => {
      const index = JSON.parse(localStorage.getItem('clerkbox:remote:v1:devices') || '[]');
      const credential = index.map(key => JSON.parse(localStorage.getItem(key) || 'null')).find(Boolean);
      if (!credential) return {missing:true};
      return new Promise(resolve => {
        const socket = new WebSocket(location.origin.replace(/^http/, 'ws') + '/relay/' + credential.roomId);
        let error = false;
        const timer = setTimeout(() => {socket.close();resolve({timeout:true,error});}, 8000);
        socket.onopen = () => socket.send(JSON.stringify({type:'auth',role:'browser',token:credential.token,deviceId:credential.deviceId}));
        socket.onmessage = event => {try {if(JSON.parse(event.data).type==='error') error=true;} catch {}};
        socket.onclose = event => {clearTimeout(timer);resolve({code:event.code,error});};
      });
    })()`)
    assert.equal(rejection.code, 4003, 'Revoked credential was not rejected by the real Worker')
    assert.equal(rejection.error, true)
    assert.equal(service.getStatus().pending.length, 0)
    assert.equal(upstreamCalls.length, requestsBeforeRevocation)
    check('revocation disconnects the live browser and rejects a fresh socket using old device credentials')

    assert.deepEqual(report.errors, [], 'The real workbench emitted browser JavaScript errors')
    report.ok = true
    report.stage = 'complete'
    report.upstreamRequests = upstreamCalls.length
    check('no document overflow at 390/1280 widths and no browser JavaScript errors')
  } catch (error) {
    report.failure = redact(error?.message || error)
    if (window && !window.isDestroyed()) {
      try {
        report.failurePage = await browserEval(`({ title:document.title, hasInput:!!document.querySelector('textarea'), bar:document.querySelector('.remote-connection-bar')?.className, alerts:[...document.querySelectorAll('[role=alert],.remote-error,.remote-recovery')].map(element=>element.textContent.slice(0,400)), composerInputs:[...document.querySelectorAll('input[type=file]')].map(input => ({ connected:input.isConnected, fileCount:input.files?.length, composer:!!input.closest('.chat-input-box') })), images:[...document.images].map(image => ({alt:image.alt, width:image.naturalWidth, height:image.naturalHeight})) })`)
        await fsp.writeFile(path.join(output, 'failure.png'), (await window.webContents.capturePage()).toPNG())
      } catch {}
    }
    report.host = service ? { state: service.getStatus().state, pending: service.getStatus().pending.length, devices: service.getStatus().devices.length } : null
    report.transport = transport.slice(-100)
    if (service) report.host.peers = [...service.peers.values()].map(peer => ({ named: !!peer.name, ready: peer.ready, paired: !!peer.deviceId }))
    report.logs = logs.slice(-20).map(redact)
  } finally {
    report.upstreamRequests = upstreamCalls.length
    await fsp.writeFile(path.join(output, 'remote-ui-report.json'), JSON.stringify(report, null, 2))
    if (service?.getStatus().enabled) await service.disable().catch(() => {})
    service?.dispose()
    store?.flush()
    inviteWindow?.destroy()
    window?.destroy()
    if (server) server.closeAllConnections()
    if (server) await new Promise(resolve => server.close(resolve))
    progress(report.ok ? 'all real transport, agent, persistence and UI checks passed' : `FAILED at ${report.stage}: ${report.failure}`)
    app.exit(report.ok ? 0 : 1)
  }
}

if (process.env.REMOTE_UI_CHILD === '1' && process.versions.electron) {
  runElectron().catch(error => {
    process.stderr.write(`[remote-ui] integration initialization failed: ${redact(error?.message || error)}\n`)
    require('electron').app.exit(1)
  })
} else {
  orchestrate().catch(error => { process.stderr.write(`${redact(error?.message || error)}\n`); process.exitCode = 1 })
}
