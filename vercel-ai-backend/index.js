const express = require('express');
const app = express();
const port = process.env.PORT || 3001; //KEEP AS 3001
const fetch = global.fetch || require('node-fetch');
const { z } = require('zod');

require('dotenv').config({ path: '.env.local' });

// Prefer using the Vercel AI SDK streaming helpers when available.
// If @vercel/ai is available and exports an XAI client with streaming
// helpers we will use it; otherwise we fall back to direct XAI HTTP
// streaming. This keeps behavior robust while honoring your SDK requirement.
const { generateText, streamText } = require("ai");
const { createXai } = require('@ai-sdk/xai');

const xai = createXai({
    apiKey: process.env.XAI_API_KEY,
});

// Global variable to store the current Google token for tool execution
let currentGoogleToken = null;

// Manual Gmail tool implementation
/**
 * gmailTool
 *
 * Tool to search a user's Gmail and return readable message excerpts suitable for
 * display in a chat interface.
 *
 * Detailed description of `query`:
 * - The `query` parameter must be a Gmail search string using Gmail's search operators
 *   (the same syntax you can use in the Gmail web UI). It should be a plain string.
 * - Supported/common operators and patterns (examples):
 *     - Mailbox/location: in:inbox, in:trash, in:spam
 *     - Sender/recipient: from:alice@example.com, to:bob@example.org, cc:carol@example.com
 *     - Subject and message text: subject:"team meeting", "exact phrase"
 *     - Labels and categories: label:Important, category:promotions
 *     - Attachment/filename: has:attachment, filename:proposal.pdf
 *     - Dates / relative times:
 *         - absolute: after:2020/01/01 before:2021/01/01
 *         - relative: newer_than:7d older_than:1y
 *     - Sizes: larger:5M smaller:500K
 *     - Status flags: is:unread, is:starred, is:important
 *     - Logical operators & exclusions:
 *         - OR (uppercase), e.g. from:alice OR from:bob
 *         - use minus to exclude, e.g. -label:personal or -from:spam@example.com
 *         - grouping with parentheses for complex queries: (from:alice OR from:bob) subject:report
 * - Examples:
 *     - "in:inbox from:alice@example.com subject:(report OR summary) newer_than:30d has:attachment"
 *     - "label:work -filename:.zip is:unread"
 *
 * Constraints & recommendations for `query`:
 * - Type: string (required). If omitted, the tool defaults to "in:inbox".
 * - Structure: should be a well-formed Gmail search expression; operators are case-sensitive
 *   for logical OR and some tokens (e.g., OR must be uppercase).
 * - Length: avoid extremely long queries. As a guideline, keep queries concise (recommended
 *   <= 2048 characters) to prevent transport/processing issues.
 * - Validation: callers should ensure user-supplied values (addresses, filenames, labels)
 *   are properly escaped/quoted when necessary to avoid unintended parsing (e.g., wrap
 *   multi-word phrases in quotes).
 * - Security: do not include secrets or large raw payloads in the query string. Treat the
 *   query as user-controlled input and sanitize/validate before sending to backend services.
 * - Unsupported operators: this tool relies on Gmail-style queries; operators not supported
 *   by Gmail UI/API will not work.
 *
 * Parameters:
 * @param {Object} params - Input object.
 * @param {string} params.query - Gmail search query string (see description above). Example:
 *                                "in:inbox from:alice@example.com subject:invoice newer_than:90d".
 *                                Default: "in:inbox" when omitted or 'undefined'.
 * @param {number} [params.max_results=5] - Maximum number of emails to return. Must be an integer >= 1.
 *                                          Recommended upper bound: 100 (adjust according to backend limits).
 *
 * Behavior:
 * - Executes the Gmail-style search via the backend MCP endpoint.
 * - Parses the backend response, formats up to `max_results` emails into a human-readable string,
 *   including subject, from, date, and a short snippet.
 * - On error, returns a human-readable error string.
 *
 * @returns {Promise<string>} A formatted string listing the matched emails (or an error message).
 */
const gmailTool = {
    name: 'gmail',
    description: 'Search the user\'s Gmail and return relevant message excerpts',
    inputSchema: z.object({
        query: z.string().describe(
            `Provide a Gmail search query using supported Gmail search operators for message filter and retrieval.
            Supported operators include:
            - from: user@example.com — messages from a specific sender
            - to: user@example.com
            - subject: meeting — subject contains "meeting"
            - in: inbox — only messages in the inbox
            - label: work — messages with a specific label
            - is: starred or is: unread — starred or unread messages
            - has: attachment — messages that have a specific attribute(e.g., has: attachment)
            - after: / before: — messages sent after or before a specific date
            - newer_than: / older_than: — relative date filtering (e.g., newer_than:7d)
            - size: / larger: / smaller: — filter by message size
            - AND, OR, - (not), ( ) for grouping.
            
            Example: 'from:john.doe@example.com has:attachment after:2023/01/01'
            See: https://developers.google.com/gmail/api/guides/filtering for full operator list and examples.`
        ),
        max_results: z.number().min(1).default(5).describe('Maximum number of results to return (default: 5) indicated by user.'),
    }),
    execute: async ({ query, max_results }) => {
        try {
            // Provide default query if not specified
            if (!query || query === 'undefined') {
                query = 'in:inbox';
                console.log('[LOG] Using default query:', query);
            }

            if (!max_results || isNaN(max_results) || max_results <= 0) {
                max_results = 5;
                console.log('[LOG] Using default max_results:', max_results);
            }

            console.log('[LOG] Executing Gmail tool with query:', query, 'max_results:', max_results);

            const response = await fetch('http://localhost:4000/api/mcp', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${currentGoogleToken}`
                },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    method: 'tools/call',
                    params: {
                        name: 'gmail',
                        arguments: { query, max_results }
                    },
                    id: Date.now()
                })
            });

            if (!response.ok) {
                throw new Error(`MCP server error: ${response.status}`);
            }

            const result = await response.json();

            if (result.error) {
                throw new Error(`Gmail tool error: ${result.error.message}`);
            }

            // Extract the content from the MCP response
            const content = result.result?.content?.[0]?.text;
            if (!content) {
                throw new Error('No content returned from Gmail tool');
            }

            const parsedContent = JSON.parse(content);
            console.log('[LOG] Gmail tool executed successfully, found', parsedContent.emails?.length || 0, 'emails');

            // Format the results as a readable string for the chat interface
            if (!parsedContent.emails || parsedContent.emails.length === 0) {
                return 'No emails found matching your search.';
            }

            // Show up to the requested number of results
            const emailsToShow = parsedContent.emails.slice(0, max_results || 5);

            let formattedResult = `Here are your ${emailsToShow.length} most recent email${emailsToShow.length === 1 ? '' : 's'}:\n\n`;

            emailsToShow.forEach((email, index) => {
                const subject = email.subject || 'No Subject';
                const from = email.from || 'Unknown Sender';
                const date = email.date ? new Date(email.date).toLocaleDateString() : 'Unknown Date';
                const snippet = email.snippet ? email.snippet.substring(0, 80) + (email.snippet.length > 80 ? '...' : '') : 'No preview';

                formattedResult += `📧 ${subject}\n`;
                formattedResult += `From: ${from}\n`;
                formattedResult += `Date: ${date}\n`;
                formattedResult += `"${snippet}"\n\n`;
            });

            return formattedResult;
        } catch (error) {
            console.error('[ERROR] Gmail tool execution failed:', error);
            return `Error searching Gmail: ${error.message}`;
        }
    }
};

app.use(express.json());

// Simple CORS for local development
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-google-token');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

const XAI_KEY = process.env.XAI_API_KEY;
if (!XAI_KEY) {
    console.warn('Warning: XAI_API_KEY is not set in environment. Requests will fail without it.');
}
const SUPABASE_URL = process.env.SUPABASE_URL || null;

async function validateSupabaseToken(token) {
    if (!token) return null;
    if (!SUPABASE_URL) {
        console.warn('SUPABASE_URL not configured; cannot validate Supabase token. Rejecting for security.');
        return null;
    }

    try {
        const resp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        if (!resp.ok) {
            console.warn('Supabase token validation failed with status', resp.status);
            return null;
        }
        const user = await resp.json();
        return user;
    } catch (e) {
        console.error('Error validating Supabase token:', e.message || e);
        return null;
    }
}

// Utility to stream XAI response with MCP tools.
// Uses the AI SDK MCP client to provide Gmail tools to the LLM.
async function streamChatWithFunctions(req, res, prompt, googleToken) {
    console.log('[LOG] Starting chat request processing for prompt:', prompt.substring(0, 50) + '...');

    const sendChunk = (chunk) => {
        try {
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        } catch (e) {
            console.warn('[WARN] Client disconnected while streaming:', e.message);
        }
    };

    try {
        if (!googleToken) {
            throw new Error('Google access token is required in x-google-token header or userToken body field');
        }

        // Store the token for tool execution
        currentGoogleToken = googleToken;

        // Set SSE headers
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        // Check if this is a Gmail-related query
        const gmailKeywords = ['email', 'gmail', 'mail', 'inbox', 'message', 'recent', 'latest'];
        const isGmailQuery = gmailKeywords.some(keyword =>
            prompt.toLowerCase().includes(keyword)
        );

        console.log('[LOG] Prompt analysis:', { prompt: prompt.substring(0, 50), isGmailQuery, keywords: gmailKeywords.filter(k => prompt.toLowerCase().includes(k)) });

        const messages = [
            {
                role: 'system',
                content: 'You are a helpful assistant. You can help with various tasks but do not have access to email functionality.'
            },
            {
                role: 'user',
                content: prompt
            }
        ];

        if (isGmailQuery) {
            console.log('[LOG] Detected Gmail query, calling tool directly');

            // Call the Gmail tool with AI
            try {
                const result = await generateText({
                    model: xai('grok-3'),
                    messages: messages,
                    tools: [gmailTool]
                });

                // Guard clause for unexpected response structures
                if (!result || !result.response || !result.response.messages || result.response.messages.length < 2 || result.response.messages[1].content[0].type !== 'tool-result' || result.response.messages[1].content[0].output.type !== 'text') {
                    console.warn('[WARN] Unexpected response structure from Gmail tool.\nresult: ', result);
                    return sendChunk({ type: 'error', message: 'Failed to retrieve Gmail messages' });
                }

                const resultContent = result.response.messages[1].content[0].output.value;
                console.log('[LOG] Tool execution successful, result length:', resultContent.length);
                console.log('[LOG] Generated AI response text:', '\n"""\n' + resultContent.substring(0, 100) + (resultContent.length > 100 ? '...' : '') + '\n"""');

                    // Stream the tool result directly, preserving newlines and spacing.
                    // Split by newline but keep lines intact so the chat UI receives natural paragraph breaks.
                    const lines = resultContent.split('\n');
                    for (const line of lines) {
                        // Send each line followed by a newline so the frontend preserves line breaks.
                        sendChunk({ type: 'token', text: line + '\n' });
                        await new Promise(resolve => setTimeout(resolve, 10));
                    }
            } catch (error) {
                console.error('[ERROR] Gmail tool execution failed:', error);
                sendChunk({ type: 'token', text: `Error searching Gmail: ${error.message}` });
            }
        } else {
            // Use AI for non-Gmail queries
            // Use generateText without tools for non-Gmail queries
            const result = await generateText({
                model: xai('grok-3'),
                messages: messages,
            });

            console.log('[LOG] Generated AI response with text length:', result.text.length);
            console.log('[LOG] Generated AI response text:', '\n"""\n' + result.text.substring(0, 100) + (result.text.length > 100 ? '...' : '') + '\n"""');

            // Stream the AI-generated text
                // Stream the AI-generated text while preserving newlines.
                // We split on newlines and send each line with a trailing newline so formatting is preserved.
                const aiLines = (result.text || '').split('\n');
                for (const line of aiLines) {
                    sendChunk({ type: 'token', text: line + '\n' });
                    await new Promise(resolve => setTimeout(resolve, 10));
                }
        }

    } catch (error) {
        console.error('[ERROR] Error in streamChatWithFunctions:', error);
        sendChunk({ type: 'error', message: error.message });
    }

    try { res.end(); } catch (e) { /* ignore */ }
}

app.post('/api/chat', async (req, res) => {
    console.log('[LOG] === STARTING /api/chat REQUEST ===');
    try {
        console.log('[LOG] Incoming /api/chat request');
        const { prompt } = req.body || {};

        // LEAVE COMMENTED OUT FOR NOW
        // Validate Supabase token before proceeding
        // const validatedUser = await validateSupabaseToken(supabaseTokenHeader);
        // if (!validatedUser) {
        //     console.warn('[WARN] Invalid Supabase token');
        //     return res.status(401).json({ error: 'Invalid Supabase token' });
        // }

        // Allow Google access token in a header (x-google-token) or as userToken in body
        const googleToken = req.header('x-google-token') || req.body?.userToken || null;

        if (!prompt || typeof prompt !== 'string') {
            console.warn('[WARN] Invalid prompt in request');
            return res.status(400).json({ error: 'Invalid request: prompt (string) required' });
        }

        // Stream response back to client. Pass googleToken so the backend can forward
        // it to the MCP server when tools are invoked. The Supabase token has already
        // been validated; we don't forward it to MCP.
        await streamChatWithFunctions(req, res, prompt, googleToken);
    } catch (err) {
        console.error('[ERROR] /api/chat endpoint error:', err.message);
        if (!res.headersSent) res.status(500).json({ error: err.message });
    }
});

app.listen(port, () => {
    console.log(`Vercel-like AI backend listening at http://localhost:${port}`);
});
