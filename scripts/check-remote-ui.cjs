/*
 * Real remote transport/workbench integration. Only the upstream model is a local
 * OpenAI SSE fixture; the SQLite store, agent loop, connector, relay and UI are real.
 * All profiles, credentials, workspace files, relay state and evidence stay in temp.
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
  const userData = path.join(output, 'electron-profile')
  const home = path.join(output, 'home')
  for (const directory of [workspace, userData, home]) fs.mkdirSync(directory, { recursive: true })
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
  const pngBytes = nativeImage.createFromBitmap(Buffer.from([0, 0, 255, 255, 255, 90, 0, 255, 80, 180, 40, 255, 150, 60, 180, 255]), { width: 2, height: 2 }).toPNG()
  const pngBase64 = pngBytes.toString('base64')
  const pngDataUrl = `data:image/png;base64,${pngBase64}`
  const finishStage = stage => { report.stage = stage; progress(stage) }
  const check = (name, detail = {}) => { report.checks.push({ name, ok: true, ...detail }) }

  async function browserEval(code) { return window.webContents.executeJavaScript(code, true) }
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
    const dimensions = await browserEval(`(() => {
      const input = document.querySelector('textarea');
      const send = document.querySelector('.chat-toolbar-send');
      const box = element => { if (!element) return null; const r = element.getBoundingClientRect(); return { x:r.x, right:r.right, width:r.width, bottom:r.bottom }; };
      return { viewport:innerWidth, page:document.documentElement.scrollWidth, body:document.body.scrollWidth, input:box(input), send:box(send) };
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
    const originalHandle = ipcMain.handle.bind(ipcMain)
    ipcMain.handle = (channel, handler) => { handlerRegistry.set(channel, handler); return originalHandle(channel, handler) }
    store = await createChatStore({ userDataDir: userData, wasmBinary: fs.readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm')) })
    assert.equal(store.kind, 'sqlite', 'This integration must exercise the real SQLite engine')
    report.database = store.kind
    registerDbIpcHandlers(store)
    installAgentHostBridge()
    // Trusted desktop-only configuration. The remote browser receives a redacted projection.
    const model = { id: 'local-vision-integration-test', label: '本地集成测试模型', maxTokens: 1000, maxInputTokens: 184000, supportsThinking: false, supportsImages: true }
    const provider = { id: 'local-fixture', name: 'Local integration fixture', baseUrl: modelBase, apiKey: 'local-test-key-not-a-real-credential', apiCompat: 'openai', models: [model] }
    const settings = { model: model.id, activeModelId: model.id, activeProviderId: provider.id, apiCompat: 'openai', providers: [provider], baseUrl: modelBase, apiKey: provider.apiKey, temperature: 0.2, maxTokens: 1000, maxInputTokens: 184000, enableThinking: false, directFetch: false, approvalMode: 'manual', browserUseEnabled: false, computerUseEnabled: false, agentsMdEnabled: false, claudeMdCompat: false, permissionRules: [] }
    handlerRegistry.set('kvGet', (_event, key) => key === 'clerkbox-settings' ? JSON.stringify({ state: { theme: 'dark', language: 'zh-CN', interfaceMode: 'coding', hasCompletedOnboarding: true, ...settings }, version: 0 }) : null)
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
    const enabled = await service.enable({ workspace, approve: true, files: true })
    service.socket.addEventListener('message', event => { try { const frame = JSON.parse(event.data); transport.push({ source: 'host', type: frame.type, invited: frame.invited, authorized: frame.authorized, payloadKeys: frame.payload ? Object.keys(frame.payload) : undefined }) } catch {} })
    assert.equal(enabled.state, 'online')
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
    await waitFor('authenticated real workbench', () => browserEval(`!!document.querySelector('.remote-connection-bar.is-connected') && !!document.querySelector('textarea')`), 45000)
    assert.equal(await browserEval(`Object.values(localStorage).some(value => value.includes('local-test-key-not-a-real-credential') || value.includes(${JSON.stringify(modelBase)}))`), false, 'Desktop model secrets leaked into browser storage')
    check('real invitation, matching code, desktop approval and redacted bootstrap')

    finishStage('paired browser reopening an invitation')
    const pairedInvite = await service.createInvite()
    await window.loadURL(pairedInvite.url)
    await waitFor('paired browser enters with persistent credential', () => browserEval(`!!document.querySelector('.remote-connection-bar.is-connected') && !!document.querySelector('textarea')`), 45000)
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
    assert.ok(upstreamCalls.some(call => call.stream && call.hasPrompt), 'Real agent loop did not call the local model upstream')
    assert.ok(upstreamCalls.some(call => call.stream && call.hasPrompt && call.hasImage), 'Uploaded PNG bytes did not reach the real model request through the host image path fallback')
    const userRow = persisted.messages.find(message => message.role === 'user' && message.content === prompt)
    const uploaded = (typeof userRow.attachments === 'string' ? JSON.parse(userRow.attachments) : userRow.attachments).find(attachment => attachment.name === 'remote-e2e.png')
    assert.ok(uploaded?.path, 'Uploaded image path was not persisted in the user message')
    assert.equal(uploaded.dataUrl, undefined, 'Remote commands must not duplicate the uploaded image as a data URL')
    assert.ok(!path.relative(workspace, uploaded.path).startsWith('..'), 'Uploaded image escaped the isolated workspace')
    assert.deepEqual(await fsp.readFile(uploaded.path), pngBytes, 'Uploaded image bytes changed before host execution')
    check('real file input uploads a PNG into the isolated workspace and host image path fallback sends identical bytes to the model')
    await waitFor('streamed reply visible', () => browserEval(`document.body.innerText.includes(${JSON.stringify(reply)})`))
    await verifyHistoryImage('sent message')
    check('path-only sent image displays a decoded preview with identical uploaded PNG bytes in the actual message DOM')
    store.flush()
    const reopened = await createChatStore({ userDataDir: userData, wasmBinary: fs.readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm')) })
    const rowsOnDisk = await reopened.getMessages(persisted.sessionId)
    assert.ok(rowsOnDisk.some(message => message.role === 'assistant' && message.content.includes(reply)))
    check('browser message executes the actual desktop agent and persists reply in SQLite', { messages: rowsOnDisk.length })
    await capture('conversation', 1280)
    await capture('conversation', 390, 844)

    finishStage('browser refresh and saved-device reconnect')
    window.webContents.reload()
    await waitFor('saved device entry after refresh', () => browserEval(`!!document.querySelector('.remote-known-device > button:first-child')`))
    await browserEval(`document.querySelector('.remote-known-device > button:first-child').click()`)
    await waitFor('authenticated after refresh', () => browserEval(`!!document.querySelector('.remote-connection-bar.is-connected')`))
    await waitFor('reconnected after refresh', () => browserEval(`!!document.querySelector('.remote-connection-bar.is-connected') && document.body.innerText.includes(${JSON.stringify(reply)})`), 30000)
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
        report.failurePage = await browserEval(`({ title:document.title, hasInput:!!document.querySelector('textarea'), bar:document.querySelector('.remote-connection-bar')?.className, alerts:[...document.querySelectorAll('[role=alert],.remote-error,.remote-recovery')].map(element=>element.textContent.slice(0,400)) })`)
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
