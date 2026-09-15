# Strava Challenge Tracker

A Cloudflare Worker application that tracks new challenges on Strava and sends notifications via Telegram.

## Features

- **Automated Scanning**: Runs twice daily (configurable cron schedule)
- **Smart Detection**: Stops after finding 4 consecutive missing challenge IDs
- **Retry Mechanism**: Re-checks failed/temporarily unavailable challenge IDs in subsequent scans
- **Telegram Notifications**: Sends formatted messages when new challenges are found
- **Persistent Storage**: Uses Cloudflare KV to track progress across executions
- **Rate Limiting Friendly**: Includes delays between requests to avoid being blocked

## Prerequisites

1. **Cloudflare Account** (free tier is sufficient)
2. **Telegram Bot Token** - Get from [@BotFather](https://t.me/BotFather)
3. **Telegram Chat ID** - Your chat ID or channel ID where notifications will be sent

## Setup Instructions

### 1. Create a Telegram Bot

1. Open Telegram and search for `@BotFather`
2. Send `/newbot` command
3. Follow the prompts to create your bot
4. Save the **Bot Token** (looks like: `1234567890:ABCdefGHIjklMNOpqrsTUVwxyz`)

### 2. Get Your Chat ID

**For personal chat:**
1. Search for `@userinfobot` on Telegram
2. Start a chat and send any message
3. It will reply with your user ID

**For a channel:**
1. Create a channel and add your bot as an admin
2. Send a message to the channel
3. Forward that message to `@JsonDumpBot` or similar
4. Look for `chat.id` in the JSON (it will be negative for channels, e.g., `-1001234567890`)

### 3. Install Dependencies

```bash
npm install
```

### 4. Configure Environment Variables

Edit `wrangler.toml` and update:

```toml
[vars]
TELEGRAM_BOT_TOKEN = "your_actual_bot_token_here"
TELEGRAM_CHAT_ID = "your_chat_id_here"
```

### 5. Create KV Namespace

```bash
npm run init-kv
```

This will output a namespace ID. Update `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "CHALLENGE_STORE"
id = "YOUR_NAMESPACE_ID_HERE"
```

### 6. Deploy to Cloudflare

```bash
npm run deploy
```

### 7. Set Up Cron Triggers

The cron schedule is already defined in `wrangler.toml` (twice daily at 8 AM and 8 PM UTC). After deployment, verify the cron triggers:

```bash
wrangler cron list
```

If needed, manually add cron triggers via Cloudflare Dashboard:
1. Go to Workers & Pages → Your Worker → Settings → Triggers
2. Add cron triggers: `0 8 * * *` and `0 20 * * *`

## Manual Testing

You can manually trigger a scan:

```bash
curl https://your-worker.your-subdomain.workers.dev/scan
```

Or check health:

```bash
curl https://your-worker.your-subdomain.workers.dev/health
```

### Get Challenge Details by ID

Fetch details of a specific challenge by providing its ID:

```bash
curl https://your-worker.your-subdomain.workers.dev/challenge/6386
```

**Example Response:**

```json
{
  "success": true,
  "data": {
    "id": 6386,
    "title": "Google Fun Run",
    "description": "Complete 2 km",
    "dateInterval": "Sep 1, 2026 to Sep 30, 2026",
    "qualifyingActivities": "Run, Trail Run, Virtual Run, Walk",
    "url": "https://www.strava.com/challenges/6386"
  }
}
```

**Error Response (Challenge Not Found):**

```json
{
  "success": false,
  "error": "Challenge not found",
  "message": "Challenge with ID 9999 does not exist or is not accessible"
}
```

## Configuration Options

### Starting Challenge ID

Edit `src/index.js` to change where scanning starts:

```javascript
const START_CHALLENGE_ID = 6000; // Change this value
```

### Consecutive Missing Threshold

Edit `src/index.js` to change how many missing IDs before stopping:

```javascript
const MAX_CONSECUTIVE_MISSING = 4; // Change this value
```

### Scan Frequency

Edit `wrangler.toml` to change cron schedule:

```toml
[triggers]
crons = ["0 8 * * *", "0 20 * * *"] # Custom cron expressions
```

## How It Works

1. **Scheduled Execution**: The worker runs twice daily based on cron schedule
2. **Load State**: Retrieves last tracked ID, known challenges, and failed IDs from KV storage
3. **Retry Failed IDs**: First attempts to re-fetch previously failed challenge IDs
4. **Scan New IDs**: Sequentially checks challenge IDs starting from last tracked position
5. **Stop Condition**: Stops after finding 4 consecutive non-existent challenges
6. **Send Notifications**: For each new challenge found, sends a formatted message to Telegram
7. **Update State**: Saves progress back to KV storage for next execution

## Notification Format

```
🏆 New Challenge Detected!

Title: Google Fun Run is coming

Description: Complete 2 km

Date Interval: Sep 1, 2026 to Sep 30, 2026

Qualifying Activities: Run, Trail Run, Virtual Run, Walk

🔗 View Challenge
```

## Troubleshooting

### Rate Limiting

If you're getting rate-limited by Strava:
- Increase the delay between requests in `src/index.js`
- Reduce scan frequency in `wrangler.toml`

### No Notifications Received

Check:
1. Bot token is correct in `wrangler.toml`
2. Chat ID is correct (negative for channels)
3. Bot has permission to send messages to the chat/channel
4. Check worker logs: `wrangler tail`

### Challenges Not Detected

- Verify the starting ID is set correctly
- Check if Strava changed their HTML structure (may need to update parsing logic)
- Review worker logs for parsing errors

## Costs

This application runs entirely on Cloudflare's free tier:
- **Workers**: 100,000 requests/day free
- **KV Storage**: 100,000 reads/day, 1,000 writes/day free
- **Cron Triggers**: Free

Typical usage: ~200-500 requests per scan (twice daily) = well within free limits

## License

MIT