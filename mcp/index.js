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
        console.log(`[LOG] Registered tool via MCP SDK: ${name}`);
        return;
      }
      if (typeof MCP.createTool === 'function') {
        MCP.createTool({ name, handler, metadata });
        console.log(`[LOG] Registered tool via MCP SDK createTool: ${name}`);
        return;
      }
    } catch (e) {
      console.warn('[WARN] Failed to register tool via MCP SDK, falling back to local registry:', e.message);
    }
  }
  tools.set(name, { handler, metadata });
  console.log(`[LOG] Registered tool locally: ${name}`);
}

async function verifyAuth(bearer) {
  if (!bearer) {
    console.log('[LOG] No auth header provided');
    return null;
  }
  const parts = bearer.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    console.warn('[WARN] Invalid auth header format');
    return null;
  }
  const token = parts[1];

  // Try Google token validation
  try {
    const url = `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`;
    const resp = await fetch(url);
    if (resp.ok) {
      const data = await resp.json();
      // tokeninfo returns fields like email, user_id, aud, expires_in
      console.log(`[LOG] Authenticated Google token for user: ${data.email || data.sub}`);
      return { sub: data.user_id || data.sub || null, email: data.email, aud: data.aud };
    } else {
      console.warn('[WARN] Google tokeninfo response not ok:', resp.status);
    }
  } catch (e) {
    console.warn('[WARN] Google token verification failed:', e.message || e);
  }

  // Fallback: try verifying as a local JWT (for testing)
  try {
    const payload = jwt.verify(token, process.env.MOCK_JWT_SECRET || 'local-dev-secret');
    console.log('[LOG] Authenticated with local JWT');
    return payload;
  } catch (e) {
    console.warn('[WARN] JWT verification failed:', e.message || e);
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
  try {
    console.log(`[LOG] Gmail tool called with args:`, args, ",", `type:`, typeof args, ",", `user:`, user ? user.sub : 'unknown');

    // Handle different argument formats from various AI providers
    let query, max_results;
    console.log("delete this later, args.max_Results", args)
    if (typeof args === 'object' && args !== null) {
      if (args.query !== undefined) {
        
        query = args.query;
        max_results = args.max_results || 5;
      } else if (args.input && typeof args.input === 'object') {
        // Handle nested input format
        query = args.input.query;
        max_results = args.input.max_results || 5;
      } else {
        // Try to extract from other possible formats
        const keys = Object.keys(args);
        if (keys.length > 0) {
          query = args[keys[0]]; // Take first property as query
        }
      }
    }

    console.log(`[LOG] Extracted query: "${query}", max_results: ${max_results}`);

    if (!query || typeof query !== 'string') {
      console.log(`[LOG] No query provided, using default: 'in:inbox'`);
      query = 'in:inbox';
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
      if (parts.length === 2 && parts[0] === 'Bearer') {
        accessToken = parts[1];
      }
    }

    const emails = [];
    if (googleapis && oauth2Client) {
      console.log(`[LOG] Using Google APIs client for Gmail search: "${query}"`);
      const { google } = googleapis;
      const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
      const list = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: max_results });
      const ids = (list.data.messages || []).map(m => m.id).slice(0, max_results);
      console.log(`[LOG] Found ${ids.length} message IDs, fetching details...`);
      for (const id of ids) {
        try {
          const m = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
          const headers = {};
          for (const h of m.data.payload?.headers || []) headers[h.name.toLowerCase()] = h.value;
          emails.push({ id: m.data.id, threadId: m.data.threadId, snippet: m.data.snippet, subject: headers.subject || '', from: headers.from || '', date: headers.date || '' });
        } catch (e) {
          console.warn('[WARN] Failed to fetch message', id, e.message || e);
        }
      }
      console.log(`[LOG] Successfully fetched ${emails.length} emails via Google APIs`);
      return { emails, citations: emails.map((m, i) => ({ id: m.threadId, messageId: m.id, index: i })) };
    }

    if (accessToken) {
      console.log(`[LOG] Using REST API for Gmail search: "${query}"`);
      const q = encodeURIComponent(query);
      const listResp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=${max_results}`, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!listResp.ok) throw new Error(`Gmail list failed: ${listResp.status}`);
      const listJson = await listResp.json();
      const ids = (listJson.messages || []).map(m => m.id).slice(0, max_results);
      console.log(`[LOG] Found ${ids.length} message IDs, fetching details...`);
      for (const id of ids) {
        try {
          const msgResp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, { headers: { Authorization: `Bearer ${accessToken}` } });
          if (!msgResp.ok) { console.warn('[WARN] Failed to fetch message', id, msgResp.status); continue; }
          const msg = await msgResp.json();
          const headers = {};
          for (const h of msg.payload?.headers || []) headers[h.name.toLowerCase()] = h.value;
          emails.push({ id: msg.id, threadId: msg.threadId, snippet: msg.snippet, subject: headers.subject || '', from: headers.from || '', date: headers.date || '' });
        } catch (e) {
          console.warn('[WARN] Failed to fetch message', id, e.message || e);
        }
      }
      console.log(`[LOG] Successfully fetched ${emails.length} emails via REST API`);
      return { emails, citations: emails.map((m, i) => ({ id: m.threadId, messageId: m.id, index: i })) };
    }

    console.error('[ERROR] No valid credentials available for Gmail access');
    throw new Error('No valid credentials available for Gmail access. Provide a Google access token or complete server OAuth.');
  } catch (e) {
    console.error('[ERROR] Gmail handler error:', e.message, e.stack);
    throw e;
  }
};

registerTool('gmail', gmailSearchHandler, {
  description: 'Search the user\'s Gmail and return relevant message excerpts'
}); // alias so backend calling 'gmail' works

// Example extension point: other tools can be registered similarly
// registerTool('stripe_search', async ({ arguments: args, user }) => { ... });

// Main MCP endpoint - handles JSON-RPC 2.0 MCP protocol
app.post('/api/mcp', async (req, res) => {
  console.log('[DEBUG] Raw request body:', req.body);
  console.log('[DEBUG] Content-Type:', req.headers['content-type']);
  try {
    const message = req.body;
    console.log('[LOG] MCP request received:', JSON.stringify(message, null, 2));

    // Handle JSON-RPC 2.0 messages
    if (message.jsonrpc !== '2.0') {
      // Only respond to requests, not notifications
      if (message.id !== undefined) {
        return res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32600, message: 'Invalid Request' },
          id: message.id
        });
      }
      return; // Don't respond to invalid notifications
    }

    const { method, params, id } = message;

    // Check if this is a notification (no id) - don't respond
    if (id === undefined) {
      console.log('[LOG] Received notification for method:', method, '- not responding');
      return;
    }

    switch (method) {
      case 'initialize': {
        console.log('[LOG] Handling initialize request');
        const result = {
          protocolVersion: '2024-11-05', // Use standard MCP protocol version
          capabilities: {
            tools: {
              listChanged: true
            }
          },
          serverInfo: {
            name: 'friday-mcp-server',
            version: '1.0.0'
          }
        };
        return res.json({
          jsonrpc: '2.0',
          result,
          id
        });
      }

      case 'tools/list': {
        console.log('[LOG] Handling tools/list request');
        const toolList = Array.from(tools.keys()).map(name => {
          const toolEntry = tools.get(name);
          return {
            name,
            description: toolEntry.metadata.description || `Tool: ${name}`,
            parameters: {
              type: 'object',
              properties: {
                query: { type: 'string', description: 'Search query' },
                max_results: { type: 'number', description: 'Maximum results' }
              },
              required: ['query']
            }
          };
        });

        return res.json({
          jsonrpc: '2.0',
          result: {
            tools: toolList
          },
          id
        });
      }

      case 'tools/call': {
        console.log('[LOG] Handling tools/call request:', params);

        // Accept either Authorization: Bearer <token> (could be Google token) or
        // X-Supabase-Token: <supabase-jwt> forwarded by the backend.
        const auth = req.header('authorization') || req.header('x-supabase-token') || req.header('Authorization');

        const user = await verifyAuth(auth);
        if (!user) {
          console.warn('[WARN] Unauthorized MCP request from', req.ip);
          return res.status(401).json({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Unauthorized' },
            id
          });
        }

        const { name, arguments: args } = params;

        if (!name || !tools.has(name)) {
          console.warn(`[WARN] Unknown tool requested: ${name}`);
          return res.json({
            jsonrpc: '2.0',
            error: { code: -32601, message: 'Method not found' },
            id
          });
        }

        const toolEntry = tools.get(name);
        try {
          const result = await toolEntry.handler({ arguments: args, user, auth });
          console.log(`[LOG] Tool ${name} executed successfully`);

          return res.json({
            jsonrpc: '2.0',
            result: {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result)
                }
              ]
            },
            id
          });
        } catch (toolErr) {
          console.error(`[ERROR] Tool ${name} execution failed:`, toolErr.message || toolErr);
          return res.json({
            jsonrpc: '2.0',
            error: { code: -32000, message: toolErr.message || 'Tool execution failed' },
            id
          });
        }
      }

      default:
        console.warn(`[WARN] Unknown method: ${method}`);
        return res.json({
          jsonrpc: '2.0',
          error: { code: -32601, message: 'Method not found' },
          id
        });
    }
  } catch (err) {
    console.error('[ERROR] MCP server error:', err.message);
    // Only respond to requests, not notifications
    if (req.body?.id !== undefined) {
      return res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal error' },
        id: req.body.id
      });
    }
  }
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// Debug route
app.post('/debug', (req, res) => {
  console.log('[DEBUG] Debug route hit');
  res.json({ message: 'Debug route works' });
});

app.listen(port, () => {
  console.log(`[LOG] MCP server listening at http://localhost:${port}`);
  console.log(`[LOG] Registered tools: ${Array.from(tools.keys()).join(', ')}`);
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
Example curl to call the MCP server:

curl -X POST http://localhost:4000/api/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <your-google-access-token>" \
  -d '{"requestId":"r1","tool":"gmail_search","arguments":{"query":"from:\"John Smith\" meeting","max_results":2}}'

The server will return a JSON MCP-compliant response containing `content` with emails and optional `error`.
*/
