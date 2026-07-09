# Bedrock AFK Bot Layer

A lightweight headless AFK bot layer for Minecraft Bedrock servers.

This layer handles bot behavior after startup, including:

- Microsoft/Xbox authenticated login flow
- automatic reconnects
- auth-cache reuse
- anti-idle behavior
- anchored position holding
- keeping chunks loaded near a chosen location

This README does not cover protocol version support.
If the server rejects the client as `outdated_client`, that is a protocol-layer problem, not an AFK bot-layer problem.

## What this layer does

The AFK bot layer handles:

- connecting to a Bedrock server
- reusing saved authentication tokens
- reconnecting after disconnects or server restarts
- staying near a fixed anchor position
- sending minimal anti-idle movement
- keeping an area loaded by remaining online in-world

Once the bot is successfully in-game, this layer is what keeps it useful.

## What this layer does not do

This layer does not:

- add support for new Minecraft Bedrock versions
- patch `bedrock-protocol`
- bypass `outdated_client`
- navigate server selection menus like BedrockConnect
- act like a full gameplay bot
- farm, mine, fight, or pathfind

This is an AFK presence bot, not a gameplay automation bot.

## Installation

This section covers only the bot and AFK layer.
It assumes you already have:

- Docker or Portainer
- a working Bedrock server IP and port
- a Microsoft account for the bot
- a `bot.js`, `package.json`, and `Dockerfile` ready in your project folder

### Option 1: Install with Docker Compose

Create a folder for the bot and place these files inside it:

- `bot.js`
- `package.json`
- `Dockerfile`
- `docker-compose.yml`

Example `docker-compose.yml`:

```yaml
services:
  bedrock-afk-bot:
    image: bedrock-afk-bot:latest
    build: .
    container_name: bedrock-afk-bot
    environment:
      - BOT_HOST=192.168.50.8
      - BOT_PORT=19132
      - BOT_PROFILE_ID=sorterbot1
      - BOT_AUTH_CACHE_DIR=/app/auth-cache
      - BOT_KEEPALIVE_MS=240000
      - BOT_RECONNECT_INITIAL_MS=5000
      - BOT_RECONNECT_MAX_MS=60000
      - BOT_CONNECT_TIMEOUT_MS=180000
      - TZ=America/Chicago
    volumes:
      - ./auth-cache:/app/auth-cache
    restart: unless-stopped
```

Build and start it:

```bash
mkdir -p auth-cache
docker compose up -d --build
```

View logs:

```bash
docker logs -f bedrock-afk-bot
```

### Option 2: Install with Portainer

1. Go to `Images`.
2. Build a new image named `bedrock-afk-bot:latest`.
3. Upload these files when building:
   - `Dockerfile`
   - `package.json`
   - `bot.js`
4. After the image is built, go to `Stacks`.
5. Create a new stack and paste this:

```yaml
services:
  bedrock-afk-bot:
    image: bedrock-afk-bot:latest
    container_name: bedrock-afk-bot
    environment:
      - BOT_HOST=192.168.50.8
      - BOT_PORT=19132
      - BOT_PROFILE_ID=sorterbot1
      - BOT_AUTH_CACHE_DIR=/app/auth-cache
      - BOT_KEEPALIVE_MS=240000
      - BOT_RECONNECT_INITIAL_MS=5000
      - BOT_RECONNECT_MAX_MS=60000
      - BOT_CONNECT_TIMEOUT_MS=180000
      - TZ=America/Chicago
    volumes:
      - /mnt/user/appdata/bedrock-afk-bot/auth-cache:/app/auth-cache
    restart: unless-stopped
```

6. Deploy the stack.
7. Open the container logs.
8. On first run, sign in with the Microsoft account when the device code prompt appears.

### First login

On first startup, the bot may show a Microsoft device-code message in the logs.

It will usually look like this:

```text
=== MICROSOFT SIGN-IN REQUIRED ===
Open this link: https://www.microsoft.com/link
Enter this code: XXXX-XXXX
```

Open the link, enter the code, and sign in with the Microsoft account you want the bot to use.

After successful sign-in, tokens are saved in the auth-cache folder so the bot can usually reconnect without signing in again.

### Updating the bot

When you change `bot.js`, `package.json`, or `Dockerfile`, rebuild the image and redeploy the container.

Docker Compose:

```bash
docker compose up -d --build
```

Portainer:

- rebuild the image
- redeploy the stack without forcing a registry pull for the local image

## Core behavior

### 1. Authenticated login

The bot uses Microsoft/Xbox authentication.

On first login, it may prompt for sign-in using a Microsoft device code flow.
After successful sign-in, tokens are saved to the auth cache directory so future restarts usually do not require signing in again.

### 2. Reconnect handling

The bot automatically retries after:

- server restart
- dropped connection
- temporary network errors
- startup failures

Reconnect delay increases over time to avoid hammering the server.

### 3. Anchor position

After joining the world, the bot stores its initial in-world position as its anchor.

Anti-idle movement is always based on this anchor so the bot does not slowly drift away over time.

### 4. Anti-idle movement

The bot sends small movement updates at intervals to avoid appearing completely idle.

These movements are intentionally tiny and return to the anchor position.

### 5. Chunk loading use

Because the bot remains connected as a player, nearby chunks continue to tick according to the server's `tick-distance`.

This makes the bot useful for:

- autosorters
- hopper systems
- redstone machines
- other nearby ticking systems

## Recommended use case

This bot layer is best for:

- keeping an autosorter alive
- keeping a redstone area active
- remaining logged in to a private server
- reconnecting automatically after server restarts

It is not meant to replace commands like `/tickingarea`, nor is it meant to function as an advanced AI player.

## Required server conditions

For best results:

- the server must allow the account to join
- the bot must connect directly to the real Bedrock server
- `player-idle-timeout=0` is recommended
- the bot should stand close to the area you want loaded
- the server version must be supported by the protocol layer

Recommended server setting:

```properties
player-idle-timeout=0
tick-distance=4
```

## Environment variables

Typical bot-layer environment variables:

```yaml
BOT_HOST=192.168.50.8
BOT_PORT=19132
BOT_PROFILE_ID=sorterbot1
BOT_AUTH_CACHE_DIR=/app/auth-cache
BOT_KEEPALIVE_MS=240000
BOT_RECONNECT_INITIAL_MS=5000
BOT_RECONNECT_MAX_MS=60000
BOT_CONNECT_TIMEOUT_MS=180000
TZ=America/Chicago
```

### Variable meanings

- `BOT_HOST`: Bedrock server IP or hostname
- `BOT_PORT`: Bedrock server port
- `BOT_PROFILE_ID`: Local auth profile ID used to separate cached Microsoft sessions
- `BOT_AUTH_CACHE_DIR`: Persistent directory where auth tokens are stored
- `BOT_KEEPALIVE_MS`: Interval between anti-idle movement packets
- `BOT_RECONNECT_INITIAL_MS`: Initial reconnect delay
- `BOT_RECONNECT_MAX_MS`: Maximum reconnect delay after repeated failures
- `BOT_CONNECT_TIMEOUT_MS`: Maximum time allowed for login/auth connection before retrying
- `TZ`: Container timezone for readable logs

## Auth cache

The auth cache is important.

Without a persistent mounted auth cache directory, the bot may ask for Microsoft sign-in again after rebuilds or restarts.

Example volume:

```yaml
/mnt/user/appdata/bedrock-afk-bot/auth-cache:/app/auth-cache
```

This allows the bot to reuse saved authentication data.

## Reconnect strategy

The bot uses:

- automatic reconnect
- backoff between retries
- connection timeout protection
- graceful cleanup before retrying

This helps with:

- rebooted servers
- temporary outages
- failed startup attempts
- unstable local networks

If the server is down temporarily, the bot keeps retrying until it comes back.

## Anti-drift behavior

The bot uses an anchor position.

Instead of moving relative to its current position forever, it moves relative to the saved anchor and then returns to it.

This prevents the bot from slowly walking away over time.

Example pattern:

- small move off anchor
- return to anchor
- small move off anchor
- return to anchor

This keeps the player active while staying in place.

## Logging

Useful log messages include:

- connecting to server
- using auth cache
- sign-in required
- authenticated successfully
- joined server
- received start_game
- spawned
- reconnect scheduled
- kicked or disconnected reason
- moved slightly off anchor
- returned to anchor

These logs make it easier to tell whether the issue is:

- auth-related
- network-related
- server-related
- protocol-related

## Expected successful startup flow

A healthy join usually looks like:

```text
Connecting to <host>:<port> with Microsoft/Xbox auth
Using auth cache: /app/auth-cache
Using local auth profile ID: sorterbot1
Joined server
Anchor position set to ...
Received start_game
Spawned
```

## Common failure categories

### Auth issues

Examples:

- repeated Microsoft sign-in prompts
- login never finishing
- auth cache not persisting

Usually caused by:

- missing volume mount
- short connect timeout
- expired or invalid tokens

### Connection issues

Examples:

- reconnect loops
- server unavailable
- DNS or IP errors

Usually caused by:

- wrong host or port
- server offline
- BedrockConnect instead of direct server target

### Server-side issues

Examples:

- server kicks the bot
- watchdog errors
- special server menus or scripted behavior

Usually caused by:

- add-ons
- non-standard server flows
- menu-based entry systems

### Protocol issues

Examples:

- `outdated_client`

This is outside the AFK bot layer.

## Best practices

- use a dedicated Microsoft account for the bot
- mount the auth cache to persistent storage
- connect directly to the real Bedrock server
- place the bot in a safe box near the machine you want loaded
- keep `player-idle-timeout=0`
- raise connect timeout for first-time auth
- use clear logs so reconnect causes are easy to identify

## Suggested safe placement

Put the bot:

- close to the autosorter
- inside a safe enclosed box
- away from hostile mob damage
- away from water flow or piston movement
- somewhere it will not be bumped off position

Since ticking only happens around the player, positioning matters.

## Summary

The Bot / AFK layer is the part that:

- logs in
- stays online
- reconnects
- avoids idle status
- holds position
- keeps nearby chunks active

If the server version changes and the bot starts showing `outdated_client`, the AFK layer is still fine. The protocol layer simply needs updating.
