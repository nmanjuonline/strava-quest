/**
 * Strava Challenge Tracker - Cloudflare Worker
 * 
 * Tracks new challenges on Strava by monitoring challenge IDs.
 * Sends notifications via Telegram when new challenges are found.
 */

// Configuration - START_CHALLENGE_ID can be overridden via environment variable
const DEFAULT_START_CHALLENGE_ID = 6000;
const DEFAULT_BATCH_SIZE = 40; // Check max 40 IDs per scan to stay under subrequest limit (50-100)
const MAX_CONSECUTIVE_MISSING = 4;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Main scheduled event handler - runs twice daily
 */
export default {
  async scheduled(event, env, ctx) {
    console.log('Starting Strava challenge scan...');
    
    try {
      // Get configuration from environment or use defaults
      const startId = env.START_CHALLENGE_ID ? parseInt(env.START_CHALLENGE_ID) : DEFAULT_START_CHALLENGE_ID;
      const batchSize = env.BATCH_SIZE ? parseInt(env.BATCH_SIZE) : DEFAULT_BATCH_SIZE;
      
      // Get the last tracked challenge ID from KV storage
      const lastTrackedIdText = await env.CHALLENGE_STORE.get('lastTrackedId');
      const lastTrackedId = lastTrackedIdText ? parseInt(lastTrackedIdText) : null;
      let knownIds = JSON.parse(await env.CHALLENGE_STORE.get('knownIds') || '[]');
      let failedIds = JSON.parse(await env.CHALLENGE_STORE.get('failedIds') || '[]');
      
      let currentId = lastTrackedId || startId;
      let consecutiveMissing = 0;
      let newChallengesFound = [];
      let idsToRetry = [...failedIds];
      
      // First, retry previously failed IDs
      console.log(`Retrying ${idsToRetry.length} previously failed IDs...`);
      for (const failedId of idsToRetry) {
        const result = await fetchChallenge(failedId);
        
        if (result.exists) {
          console.log(`Previously failed ID ${failedId} now exists!`);
          newChallengesFound.push(result.data);
          knownIds.push(failedId);
          consecutiveMissing = 0;
        } else {
          console.log(`ID ${failedId} still not accessible, will retry later`);
        }
        
        // Small delay between requests to avoid rate limiting
        await delay(500);
      }
      
      // Clear failed IDs that were successfully retrieved
      failedIds = failedIds.filter(id => !knownIds.includes(id));
      
      // Now scan for new challenges starting from last tracked ID (limited by batch size)
      console.log(`Scanning from challenge ID: ${currentId} (max ${batchSize} per scan)`);
      
      let scannedCount = 0;
      while (consecutiveMissing < MAX_CONSECUTIVE_MISSING && scannedCount < batchSize) {
        const result = await fetchChallenge(currentId);
        scannedCount++;
        
        if (result.exists) {
          console.log(`Found challenge: ${currentId}`);
          
          // Check if this is a known challenge
          if (!knownIds.includes(currentId)) {
            newChallengesFound.push(result.data);
            knownIds.push(currentId);
          }
          
          consecutiveMissing = 0;
          currentId++;
        } else if (result.error) {
          // Temporary error or rate limit - add to retry list
          console.log(`ID ${currentId} encountered error, will retry later`);
          if (!failedIds.includes(currentId)) {
            failedIds.push(currentId);
          }
          currentId++;
          consecutiveMissing = 0; // Don't count errors as missing
        } else {
          // Challenge doesn't exist
          console.log(`Challenge ${currentId} does not exist`);
          consecutiveMissing++;
          currentId++;
        }
        
        // Delay between requests to be respectful to Strava's servers
        await delay(1000);
      }
      
      if (scannedCount >= batchSize) {
        console.log(`Reached batch limit of ${batchSize} challenges. Will continue in next scan.`);
      } else {
        console.log(`Stopped after ${MAX_CONSECUTIVE_MISSING} consecutive missing challenges.`);
      }
      
      // Send notifications for new challenges
      if (newChallengesFound.length > 0) {
        for (const challenge of newChallengesFound) {
          await sendTelegramNotification(env, challenge);
        }
        console.log(`Sent ${newChallengesFound.length} notification(s)`);
      } else {
        console.log('No new challenges found');
      }
      
      // Update storage
      await env.CHALLENGE_STORE.put('lastTrackedId', currentId.toString());
      await env.CHALLENGE_STORE.put('knownIds', JSON.stringify(knownIds));
      await env.CHALLENGE_STORE.put('failedIds', JSON.stringify(failedIds));
      
      return new Response('Scan completed successfully', { status: 200 });
      
    } catch (error) {
      console.error('Error during scan:', error);
      return new Response('Scan failed: ' + error.message, { status: 500 });
    }
  },

  // Optional: Manual trigger via HTTP request
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // Challenge details by ID endpoint: /challenge/:id
    const challengeMatch = url.pathname.match(/^\/challenge\/(\d+)$/);
    if (challengeMatch) {
      const challengeId = parseInt(challengeMatch[1]);
      return handleChallengeDetails(challengeId);
    }
    
    // Manual trigger endpoint
    if (url.pathname === '/scan') {
      // Simulate a scheduled event
      return this.scheduled({ scheduledTime: Date.now() }, env, ctx);
    }
    
    // Health check endpoint
    if (url.pathname === '/health') {
      return new Response('OK', { status: 200 });
    }
    
    return new Response('Strava Challenge Tracker\n\nEndpoints:\n- /scan - Trigger manual scan\n- /health - Health check\n- /challenge/:id - Get details of a specific challenge by ID', { 
      status: 200,
      headers: { 'Content-Type': 'text/plain' }
    });
  }
};

/**
 * Fetch and parse a Strava challenge page
 */
async function fetchChallenge(challengeId) {
  const url = `https://www.strava.com/challenges/${challengeId}`;
  
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Connection': 'keep-alive',
      },
    });
    
    if (response.status === 429) {
      // Rate limited
      return { exists: false, error: 'rate_limited' };
    }
    
    if (response.status === 404 || response.status === 403) {
      // Challenge doesn't exist
      return { exists: false };
    }
    
    if (!response.ok) {
      // Other error - might be temporary
      return { exists: false, error: `http_${response.status}` };
    }
    
    const html = await response.text();
    const data = parseChallengeData(html, challengeId);
    
    if (!data) {
      // Page exists but couldn't parse - might be invalid
      return { exists: false, error: 'parse_error' };
    }
    
    return { exists: true, data };
    
  } catch (error) {
    console.error(`Error fetching challenge ${challengeId}:`, error.message);
    return { exists: false, error: error.message };
  }
}

/**
 * Parse challenge data from HTML
 */
function parseChallengeData(html, challengeId) {
  // Extract title
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  let title = titleMatch ? titleMatch[1].trim() : 'Unknown Challenge';
  title = title.replace(' | Strava', '').trim();
  
  // Extract description - look for common patterns in Strava challenge pages
  let description = 'Complete the challenge';
  const descPatterns = [
    /["']description["']\s*[:=]\s*["']([^"']+)["']/i,
    /<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i,
    /og:description["'][^>]*content=["']([^"']+)["']/i,
  ];
  
  for (const pattern of descPatterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      description = match[1].trim();
      break;
    }
  }
  
  // Extract date interval
  let dateInterval = 'Date not specified';
  const datePatterns = [
    /(\w{3}\s+\d{1,2},?\s+\d{4})\s+(?:to|-)\s+(\w{3}\s+\d{1,2},?\s+\d{4})/,
    /(\d{1,2}\/\d{1,2}\/\d{4})\s+(?:to|-)\s+(\d{1,2}\/\d{1,2}\/\d{4})/,
  ];
  
  for (const pattern of datePatterns) {
    const match = html.match(pattern);
    if (match && match[1] && match[2]) {
      dateInterval = `${match[1]} to ${match[2]}`;
      break;
    }
  }
  
  // Extract qualifying activities
  let qualifyingActivities = 'Run, Trail Run, Virtual Run, Walk';
  const activityPatterns = [
    /qualifying\s*activities?[:\s]+([^<\n]+)/i,
    /activity\s*types?[:\s]+([^<\n]+)/i,
  ];
  
  for (const pattern of activityPatterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      qualifyingActivities = match[1].trim();
      break;
    }
  }
  
  // Try to extract more structured data if available (JSON-LD)
  const jsonLdMatch = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
  if (jsonLdMatch) {
    try {
      const jsonData = JSON.parse(jsonLdMatch[1]);
      if (jsonData.name) title = jsonData.name;
      if (jsonData.description) description = jsonData.description;
      if (jsonData.startDate && jsonData.endDate) {
        const start = new Date(jsonData.startDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        const end = new Date(jsonData.endDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        dateInterval = `${start} to ${end}`;
      }
    } catch (e) {
      // JSON parsing failed, continue with regex-extracted data
    }
  }
  
  return {
    id: challengeId,
    title,
    description,
    dateInterval,
    qualifyingActivities,
    url: `https://www.strava.com/challenges/${challengeId}`
  };
}

/**
 * Send notification to Telegram
 */
async function sendTelegramNotification(env, challenge) {
  const message = `
🏆 *New Challenge Detected!*

*Title:* ${escapeMarkdown(challenge.title)}

*Description:* ${escapeMarkdown(challenge.description)}

*Date Interval:* ${challenge.dateInterval}

*Qualifying Activities:* ${challenge.qualifyingActivities}

🔗 [View Challenge](${challenge.url})
`.trim();

  const telegramUrl = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  
  try {
    const response = await fetch(telegramUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'Markdown',
      }),
    });
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(`Telegram API error: ${response.status} - ${JSON.stringify(errorData)}`);
    }
    
    console.log(`Telegram notification sent for challenge ${challenge.id}`);
    return true;
    
  } catch (error) {
    console.error('Failed to send Telegram notification:', error);
    throw error;
  }
}

/**
 * Escape special characters for Markdown
 */
function escapeMarkdown(text) {
  if (!text) return '';
  // Escape special markdown characters
  return text
    .replace(/_/g, '\\_')
    .replace(/\*/g, '\\*')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/~/g, '\\~')
    .replace(/`/g, '\\`')
    .replace(/>/g, '\\>')
    .replace(/#/g, '\\#')
    .replace(/\+/g, '\\+')
    .replace(/-/g, '\\-')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\|/g, '\\|')
    .replace(/!/g, '\\!');
}

/**
 * Simple delay function
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Handle request to get challenge details by ID
 */
async function handleChallengeDetails(challengeId) {
  console.log(`Fetching details for challenge ID: ${challengeId}`);
  
  try {
    const result = await fetchChallenge(challengeId);
    
    if (!result.exists) {
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: result.error || 'Challenge not found',
          message: `Challenge with ID ${challengeId} does not exist or is not accessible`
        }), 
        { 
          status: result.error ? 503 : 404,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }
    
    return new Response(
      JSON.stringify({ 
        success: true, 
        data: result.data 
      }, null, 2), 
      { 
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }
    );
    
  } catch (error) {
    console.error('Error fetching challenge details:', error);
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: error.message 
      }), 
      { 
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
}
