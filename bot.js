'use strict'

const bedrock = require('bedrock-protocol')
const { Authflow, Titles } = require('prismarine-auth')

const HOST = process.env.BOT_HOST || '127.0.0.1'
const PORT = parseIntegerEnv('BOT_PORT', 19132, 1)
const PROFILE_ID = process.env.BOT_PROFILE_ID || 'sorterbot'
const AUTH_CACHE_DIR = process.env.BOT_AUTH_CACHE_DIR || '/app/auth-cache'

const KEEPALIVE_MS = parseIntegerEnv('BOT_KEEPALIVE_MS', 240000, 1000)
const RECONNECT_INITIAL_MS = parseIntegerEnv('BOT_RECONNECT_INITIAL_MS', 5000, 1000)
const RECONNECT_MAX_MS = parseIntegerEnv('BOT_RECONNECT_MAX_MS', 60000, RECONNECT_INITIAL_MS)
const CONNECT_TIMEOUT_MS = parseIntegerEnv('BOT_CONNECT_TIMEOUT_MS', 180000, 1000)

let client = null
let keepaliveTimer = null
let reconnectTimer = null

let entityId = null
let lastPos = { x: 0, y: 64, z: 0 }
let anchorPos = null
let movementTick = 0n

let reconnectDelay = RECONNECT_INITIAL_MS
let intentionallyStopping = false
let connecting = false
let connected = false
let sessionClosing = false
let activeDeviceCode = null

function parseIntegerEnv(name, fallback, minimum) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback

  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value) || value < minimum) {
    console.warn(
      `${new Date().toISOString()} Invalid ${name}=${JSON.stringify(raw)}; ` +
      `using ${fallback}`
    )
    return fallback
  }

  return value
}

function log(...args) {
  console.log(new Date().toISOString(), ...args)
}

function safeJson(value) {
  if (value === undefined) return '(undefined)'

  try {
    return JSON.stringify(value, (_key, item) => {
      if (typeof item === 'bigint') return item.toString()
      if (item instanceof Error) {
        return {
          name: item.name,
          message: item.message,
          stack: item.stack
        }
      }
      return item
    })
  } catch (err) {
    return `[unserializable: ${err?.message || err}]`
  }
}

function clearConnectionTimers() {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer)
    keepaliveTimer = null
  }
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

function clearAllTimers() {
  clearConnectionTimers()
  clearReconnectTimer()
}

function clearSessionState() {
  entityId = null
  lastPos = { x: 0, y: 64, z: 0 }
  anchorPos = null
  movementTick = 0n
  activeDeviceCode = null
  connected = false
  connecting = false
}

function safeCloseClient(reason = 'Client restarting') {
  if (!client) return

  const currentClient = client
  client = null

  // Remove our handlers first so an intentional close cannot schedule another
  // reconnect through a late close/end event.
  try {
    currentClient.removeAllListeners()

    // Authentication or ping work may still finish after we detach this client.
    // Keep a harmless error listener so a late error event cannot terminate Node.
    currentClient.on('error', (err) => {
      log('Ignored late client error:', err?.message || err)
    })
  } catch (_) {}

  try {
    // Avoid forcing the native RakNet transport closed before it has actually
    // connected. Current bedrock-protocol versions can be unsafe in that state.
    if (currentClient.connection?.connected === true) {
      if (typeof currentClient.disconnect === 'function') {
        currentClient.disconnect(reason, true)
      } else if (typeof currentClient.close === 'function') {
        currentClient.close()
      }
    }
  } catch (err) {
    log('Client close warning:', err.message)
  }
}

function scheduleReconnect(reason = 'unknown') {
  if (intentionallyStopping || reconnectTimer) return

  const delay = reconnectDelay
  log(`Reconnect scheduled in ${delay} ms (reason: ${reason})`)

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    startBot().catch((err) => {
      log('Reconnect attempt failed:', err?.stack || err?.message || err)
      finishSession('reconnect-attempt-error')
    })
  }, delay)

  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS)
}

function resetReconnectBackoff() {
  reconnectDelay = RECONNECT_INITIAL_MS
}

function finishSession(reason) {
  if (intentionallyStopping || sessionClosing) return

  sessionClosing = true
  log(`Finishing session (reason: ${reason})`)

  clearConnectionTimers()
  clearSessionState()
  safeCloseClient(`Session ended: ${reason}`)
  scheduleReconnect(reason)
}

function sameEntityId(left, right) {
  return left !== null && left !== undefined &&
    right !== null && right !== undefined &&
    String(left) === String(right)
}

function queueKeepaliveMove(position) {
  if (!client || entityId === null || !connected) return

  movementTick += 1n

  client.queue('move_player', {
    runtime_entity_id: entityId,
    position,
    pitch: 0,
    yaw: 0,
    head_yaw: 0,
    mode: 0,
    on_ground: true,
    ridden_runtime_entity_id: 0n,
    teleport_cause: 0,
    teleport_source_entity_type: 0,
    tick: movementTick
  })
}

function startKeepalive() {
  if (keepaliveTimer) clearInterval(keepaliveTimer)

  let movedOffAnchor = false

  keepaliveTimer = setInterval(() => {
    try {
      if (!client || entityId === null || !connected || !anchorPos) return

      movedOffAnchor = !movedOffAnchor

      const position = movedOffAnchor
        ? { x: anchorPos.x + 0.03, y: anchorPos.y, z: anchorPos.z }
        : { ...anchorPos }

      queueKeepaliveMove(position)
      log(movedOffAnchor ? 'Moved slightly off anchor' : 'Returned to anchor')
    } catch (err) {
      log('Keepalive send failed:', err?.stack || err?.message || err)
      finishSession('keepalive-error')
    }
  }, KEEPALIVE_MS)

  log(`Keepalive enabled every ${KEEPALIVE_MS} ms`)
}

function handleMsaCode(code) {
  // A new code supersedes every older code shown in the logs.
  activeDeviceCode = code?.user_code || null

  const verificationUri = code?.verification_uri || 'https://www.microsoft.com/link'
  let signInUrl = verificationUri

  if (activeDeviceCode) {
    try {
      const url = new URL(verificationUri)
      url.searchParams.set('otc', activeDeviceCode)
      signInUrl = url.toString()
    } catch (_) {
      signInUrl = `https://www.microsoft.com/link?otc=${encodeURIComponent(activeDeviceCode)}`
    }
  }

  log('=== MICROSOFT SIGN-IN REQUIRED ===')
  log(`COPY/OPEN THIS LINK: ${signInUrl}`)

  if (activeDeviceCode) {
    log(`Fallback code: ${activeDeviceCode}`)
  }

  if (Number.isFinite(code?.expires_in)) {
    log(`This code expires in about ${Math.ceil(code.expires_in / 60)} minute(s).`)
  }

  log('Use only the newest COPY/OPEN THIS LINK shown in the logs.')
  log('Do not restart the bot while Microsoft sign-in is pending.')
  log('After successful sign-in, tokens will be cached for reuse.')
  log('=================================')
}

function attachClientHandlers(newClient) {
  newClient.on('connect', () => {
    log('RakNet connection established')
  })

  newClient.on('session', (profile) => {
    activeDeviceCode = null
    log(`Microsoft/Xbox authentication completed as ${profile?.name || 'unknown player'}`)
  })

  newClient.on('login', () => {
    log('Server login handshake completed')
  })

  newClient.on('join', () => {
    log('Joined server')

    connected = true
    connecting = false
    sessionClosing = false

    clearReconnectTimer()
    resetReconnectBackoff()
  })

  newClient.on('start_game', (packet) => {
    if (packet?.runtime_entity_id !== null && packet?.runtime_entity_id !== undefined) {
      entityId = packet.runtime_entity_id
      log(`Runtime entity ID set to ${String(entityId)}`)
    } else if (newClient.entityId !== null && newClient.entityId !== undefined) {
      entityId = newClient.entityId
      log(`Runtime entity ID set to ${String(entityId)}`)
    }

    if (packet?.player_position) {
      lastPos = {
        x: packet.player_position.x,
        y: packet.player_position.y,
        z: packet.player_position.z
      }

      anchorPos = { ...lastPos }
      log(`Anchor position set to ${anchorPos.x}, ${anchorPos.y}, ${anchorPos.z}`)
    }

    log('Received start_game')
  })

  newClient.on('spawn', () => {
    log('Spawned')
    startKeepalive()
  })

  // Only accept movement updates that belong to this bot. The old version
  // could accidentally replace entityId with another player or mob's ID.
  newClient.on('move_player', (packet) => {
    if (!sameEntityId(packet?.runtime_entity_id, entityId)) return
    if (!packet?.position) return

    lastPos = {
      x: packet.position.x,
      y: packet.position.y,
      z: packet.position.z
    }
  })

  newClient.on('play_status', (packet) => {
    log('PLAY STATUS:', safeJson(packet))
  })

  newClient.on('text', (packet) => {
    const source = packet?.source_name || 'server'
    const message = packet?.message || ''
    const parameters = Array.isArray(packet?.parameters) && packet.parameters.length > 0
      ? ` | parameters=${safeJson(packet.parameters)}`
      : ''

    log(`[CHAT] ${source}: ${message}${parameters}`)
  })

  newClient.on('disconnect', (packet) => {
    log('SERVER DISCONNECT PACKET:', safeJson(packet))
  })

  newClient.on('kick', (reason) => {
    log('KICK EVENT:', safeJson(reason))
  })

  newClient.on('error', (err) => {
    log('Error:', err?.stack || err?.message || err)

    // Before join, errors such as failed authentication or ping failure leave
    // no usable session, so reconnect. Once joined, bedrock-protocol documents
    // error events as potentially recoverable; wait for close/kick instead of
    // tearing down a healthy connection for every parser or transport warning.
    if (!connected) {
      finishSession('client-error')
    }
  })

  // "close" is the documented terminal event. "end" is retained for
  // compatibility with older transports/releases. finishSession is idempotent.
  newClient.on('end', (...args) => {
    const detail = args.length > 0 ? safeJson(args.length === 1 ? args[0] : args) : '(no reason supplied)'
    log(`Connection ended. Detail: ${detail}`)
    finishSession('end')
  })

  newClient.on('close', (...args) => {
    const detail = args.length > 0 ? safeJson(args.length === 1 ? args[0] : args) : '(no reason supplied)'
    log(`Connection closed. Reason: ${detail}`)
    finishSession('close')
  })
}

async function startBot() {
  if (intentionallyStopping) return

  if (connecting || connected) {
    log('Connect attempt skipped because a session is already active')
    return
  }

  clearAllTimers()
  safeCloseClient()
  clearSessionState()

  connecting = true
  sessionClosing = false

  log(`Connecting to ${HOST}:${PORT} with Microsoft/Xbox authentication`)
  log(`Using auth cache: ${AUTH_CACHE_DIR}`)
  log(`Using local auth profile ID: ${PROFILE_ID}`)
  log(`Post-authentication network timeout: ${CONNECT_TIMEOUT_MS} ms`)
  log('Microsoft device-code authentication is allowed to run until Microsoft expires the code.')

  try {
    const authFlow = new Authflow(
      PROFILE_ID,
      AUTH_CACHE_DIR,
      {
        flow: 'live',
        authTitle: Titles.MinecraftNintendoSwitch,
        deviceType: 'Nintendo'
      },
      handleMsaCode
    )

    client = bedrock.createClient({
      host: HOST,
      port: PORT,
      authflow: authFlow,
      connectTimeout: CONNECT_TIMEOUT_MS
    })

    attachClientHandlers(client)
  } catch (err) {
    log('Startup failed:', err?.stack || err?.message || err)
    finishSession('startup-error')
  }
}

function shutdown(signal) {
  if (intentionallyStopping) return

  intentionallyStopping = true
  log(`Received ${signal}, shutting down gracefully...`)

  clearAllTimers()
  clearSessionState()
  safeCloseClient('Bot shutting down')
  process.exit(0)
}

process.once('SIGINT', () => shutdown('SIGINT'))
process.once('SIGTERM', () => shutdown('SIGTERM'))

process.on('uncaughtException', (err) => {
  log('Uncaught exception:', err?.stack || err?.message || err)
  finishSession('uncaught-exception')
})

process.on('unhandledRejection', (reason) => {
  log('Unhandled rejection:', reason?.stack || reason?.message || reason)
  finishSession('unhandled-rejection')
})

startBot().catch((err) => {
  log('Fatal startup error:', err?.stack || err?.message || err)
  finishSession('fatal-startup')
})
