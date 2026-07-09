const bedrock = require('bedrock-protocol')
const { Authflow, Titles } = require('prismarine-auth')

const HOST = process.env.BOT_HOST || '127.0.0.1'
const PORT = parseInt(process.env.BOT_PORT || '19132', 10)
const PROFILE_ID = process.env.BOT_PROFILE_ID || 'sorterbot'
const AUTH_CACHE_DIR = process.env.BOT_AUTH_CACHE_DIR || '/app/auth-cache'

const KEEPALIVE_MS = parseInt(process.env.BOT_KEEPALIVE_MS || '240000', 10)
const RECONNECT_INITIAL_MS = parseInt(process.env.BOT_RECONNECT_INITIAL_MS || '5000', 10)
const RECONNECT_MAX_MS = parseInt(process.env.BOT_RECONNECT_MAX_MS || '60000', 10)
const CONNECT_TIMEOUT_MS = parseInt(process.env.BOT_CONNECT_TIMEOUT_MS || '30000', 10)

let client = null
let keepaliveTimer = null
let reconnectTimer = null
let connectTimeoutTimer = null

let entityId = null
let lastPos = { x: 0, y: 64, z: 0 }
let anchorPos = null

let reconnectDelay = RECONNECT_INITIAL_MS
let intentionallyStopping = false
let connecting = false
let connected = false

function log(...args) {
  console.log(new Date().toISOString(), ...args)
}

function clearTimers() {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer)
    keepaliveTimer = null
  }

  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  if (connectTimeoutTimer) {
    clearTimeout(connectTimeoutTimer)
    connectTimeoutTimer = null
  }
}

function clearSessionState() {
  entityId = null
  connected = false
  connecting = false
  anchorPos = null
}

function safeCloseClient() {
  if (!client) return

  try {
    client.removeAllListeners()
  } catch (_) {}

  try {
    if (typeof client.disconnect === 'function') {
      client.disconnect()
    }
  } catch (_) {}

  client = null
}

function scheduleReconnect(reason = 'unknown') {
  if (intentionallyStopping) return
  if (reconnectTimer) return

  const delay = reconnectDelay
  log(`Reconnect scheduled in ${delay} ms (reason: ${reason})`)

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    startBot()
  }, delay)

  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS)
}

function resetReconnectBackoff() {
  reconnectDelay = RECONNECT_INITIAL_MS
}

function startKeepalive() {
  if (keepaliveTimer) clearInterval(keepaliveTimer)

  let toggle = false

  keepaliveTimer = setInterval(() => {
    try {
      if (!client || !entityId || !connected || !anchorPos) return

      toggle = !toggle

      const pos = toggle
        ? { x: anchorPos.x + 0.03, y: anchorPos.y, z: anchorPos.z }
        : { x: anchorPos.x, y: anchorPos.y, z: anchorPos.z }

      client.queue('move_player', {
        runtime_entity_id: entityId,
        position: pos,
        pitch: 0,
        yaw: 0,
        head_yaw: 0,
        mode: 0,
        on_ground: true,
        ridden_runtime_entity_id: 0,
        teleport_cause: 0,
        teleport_source_entity_type: 0,
        tick: 0
      })

      log(toggle ? 'Moved slightly off anchor' : 'Returned to anchor')
    } catch (err) {
      log('Keepalive send failed:', err.message)
    }
  }, KEEPALIVE_MS)
}

function attachClientHandlers(newClient) {
  newClient.on('login', () => {
    log('Authenticated successfully')
  })

  newClient.on('join', () => {
    log('Joined server')
    connected = true
    connecting = false
    resetReconnectBackoff()

    if (connectTimeoutTimer) {
      clearTimeout(connectTimeoutTimer)
      connectTimeoutTimer = null
    }
  })

  newClient.on('start_game', (packet) => {
    if (packet?.player_position) {
      lastPos = {
        x: packet.player_position.x,
        y: packet.player_position.y,
        z: packet.player_position.z
      }

      if (!anchorPos) {
        anchorPos = { ...lastPos }
        log(`Anchor position set to ${anchorPos.x}, ${anchorPos.y}, ${anchorPos.z}`)
      }
    }

    log('Received start_game')
  })

  newClient.on('spawn', () => {
    log('Spawned')
    startKeepalive()
  })

  newClient.on('move_player', (packet) => {
    if (packet?.runtime_entity_id) entityId = packet.runtime_entity_id

    if (packet?.position) {
      lastPos = {
        x: packet.position.x,
        y: packet.position.y,
        z: packet.position.z
      }
    }
  })

  newClient.on('set_entity_data', (packet) => {
    if (packet?.runtime_entity_id && !entityId) {
      entityId = packet.runtime_entity_id
    }
  })

  newClient.on('text', (packet) => {
    log(`[CHAT] ${packet.source_name || 'server'}: ${packet.message || ''}`)
  })

  newClient.on('disconnect', (packet) => {
    log('Disconnected:', JSON.stringify(packet))
  })

  newClient.on('kick', (reason) => {
    log('Kicked:', JSON.stringify(reason))
  })

  newClient.on('error', (err) => {
    log('Error:', err.message)
  })

  newClient.on('end', () => {
    log('Connection ended')
    clearTimers()
    clearSessionState()
    safeCloseClient()
    scheduleReconnect('end')
  })

  newClient.on('close', () => {
    log('Connection closed')
    clearTimers()
    clearSessionState()
    safeCloseClient()
    scheduleReconnect('close')
  })
}

async function startBot() {
  if (connecting) {
    log('Connect attempt skipped because another attempt is already in progress')
    return
  }

  clearTimers()
  clearSessionState()
  safeCloseClient()

  connecting = true

  log(`Connecting to ${HOST}:${PORT} with Microsoft/Xbox auth`)
  log(`Using auth cache: ${AUTH_CACHE_DIR}`)
  log(`Using local auth profile ID: ${PROFILE_ID}`)

  try {
    const authFlow = new Authflow(PROFILE_ID, AUTH_CACHE_DIR, {
      flow: 'msal',
      authTitle: Titles.MinecraftNintendoSwitch,
      onMsaCode: (code) => {
        log('=== MICROSOFT SIGN-IN REQUIRED ===')
        if (code.verification_uri_complete) {
          log(`Open this link: ${code.verification_uri_complete}`)
        } else if (code.verification_uri) {
          log(`Open this link: ${code.verification_uri}`)
        }
        if (code.user_code) {
          log(`Enter this code: ${code.user_code}`)
        }
        log('Sign in with the Microsoft account you want this bot to use.')
        log('After successful sign-in, tokens will be cached for reuse.')
        log('=================================')
      }
    })

    client = bedrock.createClient({
      host: HOST,
      port: PORT,
      authFlow
    })

    attachClientHandlers(client)

    connectTimeoutTimer = setTimeout(() => {
      if (!connected) {
        log(`Connect timeout after ${CONNECT_TIMEOUT_MS} ms`)
        clearSessionState()
        safeCloseClient()
        scheduleReconnect('connect-timeout')
      }
    }, CONNECT_TIMEOUT_MS)
  } catch (err) {
    log('Startup failed:', err.message)
    clearTimers()
    clearSessionState()
    safeCloseClient()
    scheduleReconnect('startup-error')
  }
}

function shutdown(signal) {
  log(`Received ${signal}, shutting down gracefully...`)
  intentionallyStopping = true
  clearTimers()
  clearSessionState()
  safeCloseClient()
  process.exit(0)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

process.on('uncaughtException', (err) => {
  log('Uncaught exception:', err?.stack || err?.message || err)
  clearTimers()
  clearSessionState()
  safeCloseClient()
  scheduleReconnect('uncaught-exception')
})

process.on('unhandledRejection', (reason) => {
  log('Unhandled rejection:', reason)
  clearTimers()
  clearSessionState()
  safeCloseClient()
  scheduleReconnect('unhandled-rejection')
})

startBot().catch((err) => {
  log('Fatal startup error:', err.message)
  clearTimers()
  clearSessionState()
  safeCloseClient()
  scheduleReconnect('fatal-startup')
})