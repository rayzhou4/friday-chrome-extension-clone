/**
 * Minimal local MCP-compatible server
 * - Listens on localhost:4000
 * - Exposes POST /api/mcp
 * - Registers tools (gmail_search) and returns mock results for demo
 *
 * Notes:
 * - Uses ES module imports
 * - Validates Bearer token (mock verification) and rejects unauthenticated requests
 * - Designed to be extended with additional tools
 */

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
// Attempt to import MCP SDK if available; we'll still work without it for demo
let MCP = null;
try {
  MCP = await import('@modelcontextprotocol/sdk');
  console.log('Loaded @modelcontextprotocol/sdk for MCP conventions.');
} catch (e) {
  console.warn('@modelcontextprotocol/sdk not available — running lightweight MCP-compatible server (demo).');
}

// If the MCP SDK exposes a direct tool registration API, prefer that so this
// server follows the SDK conventions. Otherwise fall back to an internal map.
const sdkToolRegistrarAvailable = MCP && (typeof MCP.registerTool === 'function' || typeof MCP.createTool === 'function');
if (sdkToolRegistrarAvailable) console.log('MCP SDK tool registrar detected; will register tools via SDK when possible.');

dotenv.config({ path: '.env.local' });

// Optional dynamic imports: prefer installed libraries but fall back gracefully
let jwt = null;
let googleapis = null;
try {
  jwt = (await import('jsonwebtoken')).default || (await import('jsonwebtoken'));
} catch (e) {
  console.warn('jsonwebtoken not installed — JWT fallback disabled.');
}
try {
  googleapis = await import('googleapis');
} catch (e) {
  console.warn('googleapis not installed — Gmail client fallback to raw REST fetch.');
}

const app = express();
const port = process.env.PORT || 4000;

// In-memory store for refresh tokens (demo). In production persist securely.
const refreshTokensByUser = new Map();

// Small helper to build an OAuth2 client when googleapis is present
function createOAuth2Client() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${port}/auth/google/callback`;
  if (!googleapis) return null;
  const { google } = googleapis;
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

app.use(express.json({ limit: '1mb' }));
app.use(cors());

// Simple tool registry for extensibility
const tools = new Map();

function registerTool(name, handler, metadata = {}) {
  if (sdkToolRegistrarAvailable) {
    try {
      if (typeof MCP.registerTool === 'function') {
        MCP.registerTool(name, handler, metadata);
        console.log(`Registered tool via MCP SDK: ${name}`);
        return;
      }
      if (typeof MCP.createTool === 'function') {
        MCP.createTool({ name, handler, metadata });
        console.log(`Registered tool via MCP SDK createTool: ${name}`);
        return;
      }
    } catch (e) {
      console.warn('Failed to register tool via MCP SDK, falling back to local registry:', e.message);
    }
  }
  tools.set(name, { handler, metadata });
  console.log(`Registered tool: ${name}`);
}

// Auth verification — for MCP we expect a Google access token (Authorization: Bearer <google_token>)
// For local dev we also accept 'demo-token'. This function will:
// 1) accept demo-token
// 2) try to validate Google access tokens via Google's tokeninfo endpoint
// 3) fallback to local JWT verification (useful for testing)
async function verifyAuth(bearer) {
  if (!bearer) return null;
  const parts = bearer.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return null;
  const token = parts[1];

  // Accept demo-token for local development
  if (token === 'demo-token') return { sub: 'demo-user', demo: true };

  // Try Google token validation
  try {
    const url = `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`;
    const resp = await fetch(url);
    if (resp.ok) {
      const data = await resp.json();
      // tokeninfo returns fields like email, user_id, aud, expires_in
      return { sub: data.user_id || data.sub || null, email: data.email, aud: data.aud };
    } else {
      console.warn('Google tokeninfo response not ok:', resp.status);
    }
  } catch (e) {
    console.warn('Google token verification failed:', e.message || e);
  }

  // Fallback: try verifying as a local JWT (for testing)
  try {
    const payload = jwt.verify(token, process.env.MOCK_JWT_SECRET || 'local-dev-secret');
    return payload;
  } catch (e) {
    console.warn('JWT verification failed:', e.message || e);
    return null;
  }
}

// MCP-compatible response helper
function makeToolResponse(requestId, toolName, result, error = null) {
  return {
    requestId,
    tool: toolName,
    success: error ? false : true,
    error: error ? { message: String(error) } : null,
    // `content` is the main data the LLM/backend will consume.
    content: result
  };
}

// Register a gmail_search tool (and alias 'gmail') backed by googleapis when available.
const gmailSearchHandler = async ({ arguments: args, user, auth }) => {
  console.log('gmail_search called with args:', args, 'user:', user);
  const { query, max_results = 5 } = args || {};
  if (!query || typeof query !== 'string') throw new Error('gmail_search requires a `query` string parameter');

  // Demo user shortcut
  if (user && user.demo) {
    const mockEmails = [
      {
        threadId: 'thread-123',
        messageId: 'msg-1',
        from: 'John Smith <john@example.com>',
        to: 'you@example.com',
        date: new Date().toISOString(),
        subject: "Re: Today's meeting",
        snippet: 'We discussed timeline and next steps. I will follow up with notes.',
        body_excerpt: 'Thanks for the meeting today. The key points were...'
      }
    ].slice(0, max_results);
    return { emails: mockEmails, citations: mockEmails.map((m, i) => ({ id: m.threadId, messageId: m.messageId, index: i })) };
  }

  // Determine access method: prefer stored refresh_token, else use forwarded access token
  let oauth2Client = null;
  let accessToken = null;
  if (user && user.sub && refreshTokensByUser.has(user.sub) && googleapis) {
    oauth2Client = createOAuth2Client();
    const refreshToken = refreshTokensByUser.get(user.sub);
    oauth2Client.setCredentials({ refresh_token: refreshToken });
  } else if (auth && typeof auth === 'string') {
    const parts = auth.split(' ');
    if (parts.length === 2 && parts[0] === 'Bearer' && parts[1] !== 'demo-token') {
      accessToken = parts[1];
    }
  }

  const emails = [];
  if (googleapis && oauth2Client) {
    const { google } = googleapis;
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const list = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: max_results });
    const ids = (list.data.messages || []).map(m => m.id).slice(0, max_results);
    for (const id of ids) {
      try {
        const m = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
        const headers = {};
        for (const h of m.data.payload?.headers || []) headers[h.name.toLowerCase()] = h.value;
        emails.push({ id: m.data.id, threadId: m.data.threadId, snippet: m.data.snippet, subject: headers.subject || '', from: headers.from || '', date: headers.date || '' });
      } catch (e) {
        console.warn('Failed to fetch message', id, e.message || e);
      }
    }
    return { emails, citations: emails.map((m, i) => ({ id: m.threadId, messageId: m.id, index: i })) };
  }

  if (accessToken) {
    const q = encodeURIComponent(query);
    const listResp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=${max_results}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!listResp.ok) throw new Error(`Gmail list failed: ${listResp.status}`);
    const listJson = await listResp.json();
    const ids = (listJson.messages || []).map(m => m.id).slice(0, max_results);
    for (const id of ids) {
      try {
        const msgResp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, { headers: { Authorization: `Bearer ${accessToken}` } });
        if (!msgResp.ok) { console.warn('Failed to fetch message', id, msgResp.status); continue; }
        const msg = await msgResp.json();
        const headers = {};
        for (const h of msg.payload?.headers || []) headers[h.name.toLowerCase()] = h.value;
        emails.push({ id: msg.id, threadId: msg.threadId, snippet: msg.snippet, subject: headers.subject || '', from: headers.from || '', date: headers.date || '' });
      } catch (e) {
        console.warn('Failed to fetch message', id, e.message || e);
      }
    }
    return { emails, citations: emails.map((m, i) => ({ id: m.threadId, messageId: m.id, index: i })) };
  }

  throw new Error('No valid credentials available for Gmail access. Provide a Google access token or complete server OAuth.');
};

registerTool('gmail_search', gmailSearchHandler);
registerTool('gmail', gmailSearchHandler); // alias so backend calling 'gmail' works

// Example extension point: other tools can be registered similarly
// registerTool('stripe_search', async ({ arguments: args, user }) => { ... });

// Main MCP endpoint
app.post('/api/mcp', async (req, res) => {
  try {
  // Accept either Authorization: Bearer <token> (could be Google token) or
  // X-Supabase-Token: <supabase-jwt> forwarded by the backend.
  const auth = req.header('authorization') || req.header('x-supabase-token') || req.header('Authorization');
  const user = await verifyAuth(auth);
    if (!user) {
      console.warn('Unauthorized MCP request from', req.ip);
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { tool, arguments: args, requestId } = req.body || {};
    console.log('/api/mcp request:', { tool, args, requestId, user });

    if (!tool || !tools.has(tool)) {
      return res.status(400).json({ error: 'Unknown or missing tool name' });
    }

    const toolEntry = tools.get(tool);
    try {
      // pass along the raw Authorization header so tools can use forwarded access tokens
      const result = await toolEntry.handler({ arguments: args, user, auth });
      const response = makeToolResponse(requestId || `req-${Date.now()}`, tool, result, null);
      console.log('Tool response:', response);
      return res.json(response);
    } catch (toolErr) {
      console.error('Tool execution error:', toolErr);
      const response = makeToolResponse(requestId || `req-${Date.now()}`, tool, null, toolErr.message || 'tool error');
      return res.json(response);
    }
  } catch (err) {
    console.error('/api/mcp server error', err);
    return res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.listen(port, () => {
  console.log(`MCP mock server listening at http://localhost:${port}`);
  console.log('Registered tools:', Array.from(tools.keys()));
});


/*
OAuth / Gmail integration notes (where to replace mock logic):

1) OAuth flow and storing refresh tokens
   - Implement an OAuth 2.0 flow (server-side recommended) that directs the user to
     Google's consent screen and requests the scope: https://www.googleapis.com/auth/gmail.readonly
   - After redirect, exchange the code for access_token and refresh_token and store the
     refresh_token securely (encrypted) associated with the user account.

2) Gmail API usage
   - Use the stored refresh_token to obtain a fresh access_token when needed.
   - Use Gmail REST API endpoints:
       GET https://gmail.googleapis.com/gmail/v1/users/me/messages?q={query}&maxResults={N}
       GET https://gmail.googleapis.com/gmail/v1/users/me/messages/{id}?format=full
   - Parse message payloads, decode base64 body parts, and extract text/plain or convert HTML->text.

3) Implement the real gmail_search handler
   - Replace the mock handler above with one that:
       a) looks up the user's stored refresh_token
       b) fetches message ids using Gmail search
       c) fetches each message body and extracts text
       d) returns structured results like the mock (threadId, messageId, from, date, subject, snippet, body_excerpt)

4) Security & consent
   - Ensure explicit user consent UI in the extension before requesting OAuth.
   - Allow the user to revoke access and delete stored refresh_tokens.

*/

/*
Example curl to call the MCP server (mock JWT 'demo-token'):

curl -X POST http://localhost:4000/api/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer demo-token" \
  -d '{"requestId":"r1","tool":"gmail_search","arguments":{"query":"from:\"John Smith\" meeting","max_results":2}}'

The server will return a JSON MCP-compliant response containing `content` with mock emails and optional `error`.
*/
