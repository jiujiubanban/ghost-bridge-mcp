const CONFIG = {
  wsUrl: "ws://localhost:3301",
  token: "1", // 可选：与 server 的 GHOST_BRIDGE_TOKEN 保持一致
  autoDetach: false, // 默认保持附加，便于持续捕获异常；可通过图标一键暂停
  maxErrors: 40, // 保持有限的事件窗口，避免上下文爆炸
  maxStackFrames: 5,
  maxRequestsTracked: 400,
}

let ws = null
let reconnectTimer = null
let attachedTabId = null
let scriptMap = new Map()
let scriptSourceCache = new Map()
let lastErrors = []
let lastErrorLocation = null
let requestMap = new Map()
let state = { enabled: false }

function setBadgeState(status) {
  // 统一徽章状态：connecting/ on / off / err / att(附加失败)
  const map = {
    connecting: { text: "…", color: "#999" },
    on: { text: "ON", color: "#34c759" },
    off: { text: "OFF", color: "#999" },
    err: { text: "ERR", color: "#ff3b30" },
    att: { text: "ATT", color: "#ff9f0a" }, // attach denied/失败
  }
  const cfg = map[status] || map.off
  chrome.action.setBadgeText({ text: cfg.text })
  chrome.action.setBadgeBackgroundColor({ color: cfg.color })
}

async function toggleEnabled() {
  state.enabled = !state.enabled
  if (state.enabled) {
    log("已开启 Ghost Bridge")
    setBadgeState("connecting")
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      connect()
    } else if (ws.readyState === WebSocket.OPEN) {
      ensureAttached().catch((e) => log(`attach 失败：${e.message}`))
    }
  } else {
    log("已暂停 Ghost Bridge")
    setBadgeState("off")
    if (reconnectTimer) clearTimeout(reconnectTimer)
    if (ws && ws.readyState === WebSocket.OPEN) ws.close()
    await detachAllTargets()
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function log(msg) {
  console.log(`[ghost-bridge] ${msg}`)
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId !== attachedTabId) return
  if (!state.enabled) return

  if (method === "Debugger.scriptParsed") {
    scriptMap.set(params.scriptId, { url: params.url || "(inline)" })
  }

  if (method === "Runtime.exceptionThrown") {
    const detail = params?.exceptionDetails || {}
    const topFrame = detail.stackTrace?.callFrames?.[0]
    const entry = {
      type: "exception",
      severity: "error",
      url: topFrame?.url || detail.url,
      line: topFrame?.lineNumber,
      column: topFrame?.columnNumber,
      text: detail.text,
      scriptId: topFrame?.scriptId,
      stack: compactStack(detail.stackTrace),
      timestamp: Date.now(),
    }
    lastErrorLocation = {
      url: entry.url,
      line: entry.line,
      column: entry.column,
      scriptId: entry.scriptId,
    }
    pushError(entry)
  }

  if (method === "Log.entryAdded") {
    const entry = params?.entry || {}
    pushError({
      type: entry.level || "log",
      severity: entry.level === "warning" ? "warn" : entry.level === "error" ? "error" : "info",
      url: entry.source || entry.url,
      line: entry.lineNumber,
      text: entry.text,
      stack: compactStack(entry.stackTrace),
      timestamp: Date.now(),
    })
  }

  if (method === "Runtime.consoleAPICalled") {
    const args = (params.args || []).map((a) => a.value).filter(Boolean)
    pushError({
      type: params.type || "console",
      severity: params.type === "error" ? "error" : params.type === "warning" ? "warn" : "info",
      url: params.stackTrace?.callFrames?.[0]?.url,
      line: params.stackTrace?.callFrames?.[0]?.lineNumber,
      text: args.join(" "),
      stack: compactStack(params.stackTrace),
      timestamp: Date.now(),
    })
  }

  if (method === "Network.requestWillBeSent") {
    // 记录 requestId -> url/method 以便失败时回溯
    requestMap.set(params.requestId, { url: params.request?.url, method: params.request?.method })
    // 控制映射大小
    if (requestMap.size > CONFIG.maxRequestsTracked) {
      const firstKey = requestMap.keys().next().value
      requestMap.delete(firstKey)
    }
  }

  if (method === "Network.loadingFinished") {
    requestMap.delete(params.requestId)
  }

  if (method === "Network.responseReceived") {
    const res = params.response || {}
    if (res.status >= 400) {
      const meta = requestMap.get(params.requestId) || {}
      pushError({
        type: "network",
        severity: "error",
        url: res.url || meta.url,
        status: res.status,
        statusText: res.statusText,
        mimeType: res.mimeType,
        requestId: params.requestId,
        method: meta.method,
        timestamp: Date.now(),
      })
    }
  }

  if (method === "Network.loadingFailed") {
    const meta = requestMap.get(params.requestId) || {}
    pushError({
      type: "network",
      severity: "error",
      url: params.requestId,
      requestId: params.requestId,
      method: meta.method,
      failedUrl: meta.url,
      text: params.errorText,
      timestamp: Date.now(),
    })
    requestMap.delete(params.requestId)
  }
})

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId && source.tabId === attachedTabId) {
    attachedTabId = null
    scriptMap = new Map()
    scriptSourceCache = new Map()
  }
  if (!state.enabled) return
  if (reason === "canceled_by_user") {
    log("调试被用户取消，已关闭")
    state.enabled = false
    setBadgeState("off")
  } else {
    log(`调试已断开：${reason}`)
    setBadgeState("att")
  }
})

function pushError(entry) {
  lastErrors.unshift(entry)
  if (lastErrors.length > CONFIG.maxErrors) {
    // 优先丢弃低严重度，保留 error
    const dropIdx = lastErrors
      .map((e, i) => ({ sev: e.severity || "info", i }))
      .reverse()
      .find((e) => e.sev !== "error")?.i
    if (dropIdx !== undefined) lastErrors.splice(dropIdx, 1)
    else lastErrors.pop()
  }
}

function compactStack(stackTrace) {
  const frames = stackTrace?.callFrames || []
  return frames.slice(0, CONFIG.maxStackFrames).map((f) => ({
    functionName: f.functionName || "",
    url: f.url || "(inline)",
    line: f.lineNumber,
    column: f.columnNumber,
  }))
}

async function ensureAttached() {
  if (!state.enabled) throw new Error("扩展已暂停，点击图标开启后再试")
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (!tab) throw new Error("没有激活的标签页")
  if (attachedTabId !== tab.id) {
    try {
      await chrome.debugger.attach({ tabId: tab.id }, "1.3")
      setBadgeState("on")
    } catch (e) {
      setBadgeState("att")
      throw e
    }
    attachedTabId = tab.id
    scriptMap = new Map()
    scriptSourceCache = new Map()
    await chrome.debugger.sendCommand({ tabId: attachedTabId }, "Runtime.enable")
    await chrome.debugger.sendCommand({ tabId: attachedTabId }, "Log.enable")
    await chrome.debugger.sendCommand({ tabId: attachedTabId }, "Console.enable").catch(() => {})
    await chrome.debugger.sendCommand({ tabId: attachedTabId }, "Debugger.enable")
    await chrome.debugger.sendCommand({ tabId: attachedTabId }, "Profiler.enable")
    await chrome.debugger.sendCommand({ tabId: attachedTabId }, "Network.enable").catch(() => {})
  }
  return { tabId: attachedTabId }
}

async function maybeDetach(force = false) {
  if ((CONFIG.autoDetach || force) && attachedTabId) {
    try {
      await chrome.debugger.detach({ tabId: attachedTabId })
    } catch (e) {
      log(`detach 失败：${e.message}`)
    } finally {
      attachedTabId = null
    }
  }
}

async function detachAllTargets() {
  try {
    const targets = await chrome.debugger.getTargets()
    for (const t of targets) {
      if (!t.attached) continue
      try {
        if (t.tabId !== undefined) {
          await chrome.debugger.detach({ tabId: t.tabId })
        } else {
          await chrome.debugger.detach({ targetId: t.id })
        }
      } catch (e) {
        log(`detach target ${t.id} 失败：${e.message}`)
      }
    }
    // 兜底：尝试对所有标签页 detach，避免 service worker 重启后状态丢失
    const tabs = await chrome.tabs.query({})
    for (const tab of tabs) {
      if (!tab.id) continue
      try {
        await chrome.debugger.detach({ tabId: tab.id })
      } catch {
        // ignore
      }
    }
  } catch (e) {
    log(`getTargets 失败：${e.message}`)
  } finally {
    attachedTabId = null
  }
}

async function handleGetLastError() {
  // 确保已附加，否则收不到异常事件
  await ensureAttached()
  const events = lastErrors.slice(0, CONFIG.maxErrors)
  const counts = events.reduce(
    (acc, e) => {
      acc.total++
      acc[e.severity || "info"] = (acc[e.severity || "info"] || 0) + 1
      return acc
    },
    { total: 0 }
  )
  return {
    lastErrorLocation,
    summary: {
      count: events.length,
      severityCount: counts,
      lastTimestamp: events[0]?.timestamp,
    },
    recent: events,
  }
}

async function pickScriptId(preferUrlContains) {
  if (preferUrlContains) {
    for (const [id, meta] of scriptMap.entries()) {
      if (meta.url && meta.url.includes(preferUrlContains)) return { id, url: meta.url }
    }
  }
  if (lastErrorLocation?.scriptId && scriptMap.has(lastErrorLocation.scriptId)) {
    const meta = scriptMap.get(lastErrorLocation.scriptId)
    return { id: lastErrorLocation.scriptId, url: meta.url }
  }
  const first = scriptMap.entries().next().value
  if (first) {
    return { id: first[0], url: first[1].url }
  }
  throw new Error("未找到可用脚本，确认页面已加载脚本")
}

async function handleGetScriptSource(params = {}) {
  const target = await ensureAttached()
  const chosen = await pickScriptId(params.scriptUrlContains)
  const { scriptSource } = await chrome.debugger.sendCommand(target, "Debugger.getScriptSource", {
    scriptId: chosen.id,
  })
  scriptSourceCache.set(chosen.id, scriptSource)
  const location = {
    line: params.line ?? lastErrorLocation?.line ?? null,
    column: params.column ?? lastErrorLocation?.column ?? null,
  }
  return {
    url: chosen.url,
    scriptId: chosen.id,
    location,
    source: scriptSource,
    note: "若为单行压缩脚本，可结合 column 提取片段",
  }
}

async function handleCoverageSnapshot(params = {}) {
  const target = await ensureAttached()
  const durationMs = params.durationMs || 1500
  await chrome.debugger.sendCommand(target, "Profiler.startPreciseCoverage", {
    callCount: true,
    detailed: true,
  })
  await sleep(durationMs)
  const { result } = await chrome.debugger.sendCommand(target, "Profiler.takePreciseCoverage")
  await chrome.debugger.sendCommand(target, "Profiler.stopPreciseCoverage")

  const simplified = result
    .map((item) => {
      const totalCount = item.functions.reduce((sum, f) => sum + (f.callCount || 0), 0)
      return { url: item.url || "(inline)", scriptId: item.scriptId, totalCount }
    })
    .sort((a, b) => b.totalCount - a.totalCount)
    .slice(0, 20)

  return { topScripts: simplified, rawCount: result.length }
}

function findContexts(source, query, maxMatches) {
  const lower = source.toLowerCase()
  const q = query.toLowerCase()
  const matches = []
  let idx = lower.indexOf(q)
  while (idx !== -1 && matches.length < maxMatches) {
    const start = Math.max(0, idx - 200)
    const end = Math.min(source.length, idx + q.length + 200)
    matches.push({
      start,
      end,
      context: source.slice(start, end),
    })
    idx = lower.indexOf(q, idx + q.length)
  }
  return matches
}

async function handleFindByString(params = {}) {
  const target = await ensureAttached()
  const query = params.query
  const maxMatches = params.maxMatches || 5
  const preferred = params.scriptUrlContains

  const results = []
  const entries = [...scriptMap.entries()]
  for (const [id, meta] of entries) {
    if (preferred && (!meta.url || !meta.url.includes(preferred))) continue
    if (!scriptSourceCache.has(id)) {
      const { scriptSource } = await chrome.debugger.sendCommand(target, "Debugger.getScriptSource", { scriptId: id })
      scriptSourceCache.set(id, scriptSource)
    }
    const source = scriptSourceCache.get(id)
    const matches = findContexts(source, query, maxMatches - results.length)
    if (matches.length) {
      results.push({
        url: meta.url,
        scriptId: id,
        matches,
      })
    }
    if (results.length >= maxMatches) break
  }

  return { query, results }
}

async function handleSymbolicHints() {
  const target = await ensureAttached()
  const expression = `(function(){
    try {
      const resources = performance.getEntriesByType('resource').slice(-20).map(e => ({
        name: e.name,
        type: e.initiatorType || '',
        size: e.transferSize || 0
      }));
      const globals = Object.keys(window).filter(k => k.length < 30).slice(0, 60);
      const ls = Object.keys(localStorage || {}).slice(0, 20);
      return {
        location: window.location.href,
        ua: navigator.userAgent,
        resources,
        globals,
        localStorageKeys: ls
      };
    } catch (e) {
      return { error: e.message };
    }
  })()`
  const { result } = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
    expression,
    returnByValue: true,
  })
  return result?.value
}

async function handleEval(params = {}) {
  const target = await ensureAttached()
  const { result } = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
    expression: params.code,
    returnByValue: true,
  })
  return result?.value
}

async function handleCommand(message) {
  const { id, command, params, token } = message
  if (!id || !command) return
  if (!state.enabled) {
    ws?.send(JSON.stringify({ id, error: "扩展已暂停，点击图标重新开启" }))
    return
  }
  if (CONFIG.token && CONFIG.token !== token) {
    ws?.send(JSON.stringify({ id, error: "token 校验失败" }))
    return
  }
  try {
    let result
    if (command === "getLastError") result = await handleGetLastError()
    else if (command === "getScriptSource") result = await handleGetScriptSource(params)
    else if (command === "coverageSnapshot") result = await handleCoverageSnapshot(params)
    else if (command === "findByString") result = await handleFindByString(params)
    else if (command === "symbolicHints") result = await handleSymbolicHints()
    else if (command === "eval") result = await handleEval(params)
    else throw new Error(`未知指令 ${command}`)

    ws?.send(JSON.stringify({ id, result }))
  } catch (e) {
    ws?.send(JSON.stringify({ id, error: e.message }))
  } finally {
    await maybeDetach()
  }
}

function connect() {
  if (!state.enabled) return
  const url = new URL(CONFIG.wsUrl)
  if (CONFIG.token) url.searchParams.set("token", CONFIG.token)
  ws = new WebSocket(url.toString())
  setBadgeState("connecting")
  ws.onopen = () => {
    log("WebSocket 已连接")
    setBadgeState("on")
    // 自动附加当前活动标签，确保能立即捕获异常/console
    ensureAttached().catch((e) => log(`attach 失败：${e.message}`))
  }
  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data)
      handleCommand(msg)
    } catch (e) {
      log(`解析消息失败：${e.message}`)
    }
  }
  ws.onclose = () => {
    log("WebSocket 断开，1s 后重连")
    setBadgeState("off")
    if (reconnectTimer) clearTimeout(reconnectTimer)
    if (state.enabled) reconnectTimer = setTimeout(connect, 1000)
  }
  ws.onerror = (err) => {
    log(`WebSocket 错误 ${err.message || err}`)
    setBadgeState("err")
  }
}

chrome.action.onClicked.addListener(() => {
  toggleEnabled().catch((e) => log(`切换失败：${e.message}`))
})

// 默认暂停：设置徽章为 OFF
setBadgeState("off")

connect()
