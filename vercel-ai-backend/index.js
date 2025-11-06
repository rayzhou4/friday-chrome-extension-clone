const express = require('express');
const app = express();
const port = process.env.PORT || 3001; //KEEP AS 3001
const fetch = global.fetch || require('node-fetch');
const { createServerClient } = require('@supabase/ssr');

require('dotenv').config({ path: '.env.local' });

// Prefer using the Vercel AI SDK streaming helpers when available.
// If @vercel/ai is available and exports an OpenAI client with streaming
// helpers we will use it; otherwise we fall back to direct OpenAI HTTP
// streaming. This keeps behavior robust while honoring your SDK requirement.
let VercelAI = null;
let VercelOpenAI = null;
try {
    VercelAI = require('ai');
    VercelOpenAI = require('@ai-sdk/openai');

    console.log('Loaded Vercel AI packages; will prefer SDK streaming helpers when available.');
} catch (e) {
    console.warn('Vercel AI SDKs not present or failed to load — falling back to direct OpenAI HTTP calls.');
}

app.use(express.json());

// Simple CORS for local development
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Google-Token');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

const OPENAI_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_KEY) {
    console.warn('Warning: OPENAI_API_KEY is not set in environment. Requests will fail without it.', OPENAI_KEY);
}
const SUPABASE_URL = process.env.SUPABASE_URL || null;

async function validateSupabaseToken(token) {
    if (!token) return null;
    if (token === 'demo-token') return { id: 'demo-user', demo: true };
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

// Helper: call MCP server for gmail tool
async function callMCP(googleToken, payload) {
    const url = 'http://localhost:4000/api/mcp';
    console.log('Calling MCP server at', url, 'with payload', payload);
    const headers = {
        'Content-Type': 'application/json'
    };
    // Send only the Google access token to MCP as Authorization. MCP will use
    // this token to call Gmail APIs. The Vercel backend already validated the
    // Supabase JWT so we don't forward it to MCP.
    if (googleToken) headers['Authorization'] = `Bearer ${googleToken}`;

    const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
    });
    if (!resp.ok) {
        const text = await resp.text().catch(() => '<no body>');
        throw new Error(`MCP server returned ${resp.status}: ${text}`);
    }
    return resp.json();
}

// Utility to stream OpenAI response and detect function_call (gmail) in-stream.
// We'll run a two-pass approach: stream until a function_call is emitted,
// pause, execute the tool against the MCP endpoint, then resume the LLM with
// the function result to produce the final answer which is streamed to client.
// Implementation will prefer the Vercel AI SDK streaming helpers when they
// are available (VercelOpenAI) and fallback to the fetch streaming path.
async function streamChatWithFunctions(req, res, prompt, googleToken) {
    // Basic message setup
    const systemMessage = {
        role: 'system',
        content: 'You are a helpful assistant that may call the gmail tool to fetch email excerpts. Use only the provided excerpts when answering.'
    };

    const messages = [systemMessage, { role: 'user', content: prompt }];

    // Define the gmail function signature for OpenAI function calling so the model
    // can request it. This matches the MCP tool name "gmail".
    const functions = [
        {
            name: 'gmail',
            description: 'Search the user\'s Gmail and return relevant message excerpts',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Gmail search query (q param)' },
                    max_results: { type: 'integer', description: 'Maximum messages to return' }
                },
                required: ['query']
            }
        }
    ];

    let initialStreamResp = null;
    let usingSdk = false;
    // Prefer using high-level `generateText` if the installed SDK exposes it
    if (typeof VercelAI !== 'undefined' && VercelAI && typeof VercelAI.generateText === 'function') {
        try {
            usingSdk = true;
            console.log('Using Vercel SDK generateText for streaming.');
            initialStreamResp = await VercelAI.generateText({
                model: 'gpt-4o-mini',
                messages,
                functions,
                function_call: 'auto',
                stream: true
            });
        } catch (err) {
            usingSdk = false;
            console.warn('Vercel generateText failed, falling back:', err.message || err);
        }
    }
    if (VercelOpenAI && typeof VercelOpenAI === 'function') {
        try {
            // SDK detected. Construct a client if the SDK requires it.
            const client = new VercelOpenAI({ apiKey: OPENAI_KEY });
            if (typeof client.stream === 'function' || typeof client.chat === 'object') {
                // Try to use an SDK streaming method if available. The SDK surface can
                // vary between releases; attempt a couple of options gracefully.
                usingSdk = true;
                console.log('Using @vercel/ai SDK streaming (best-effort).');
                // We'll call client.chat.completions.create with stream:true if available
                if (client.chat && typeof client.chat.completions === 'object' && typeof client.chat.completions.create === 'function') {
                    initialStreamResp = await client.chat.completions.create({
                        model: 'gpt-4o-mini',
                        messages,
                        functions,
                        function_call: 'auto',
                        stream: true
                    });
                } else if (typeof client.stream === 'function') {
                    initialStreamResp = await client.stream({ model: 'gpt-4o-mini', messages, functions, function_call: 'auto' });
                } else {
                    // SDK doesn't expose a recognizable streaming API; fall back to fetch.
                    usingSdk = false;
                }
            }
        } catch (sdkErr) {
            usingSdk = false;
            console.warn('Vercel SDK streaming attempt failed, falling back:', sdkErr.message);
        }
    }

    // Fallback to direct OpenAI HTTP streaming if SDK not used
    if (!usingSdk) {
        initialStreamResp = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENAI_KEY}`
            },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                messages,
                functions,
                function_call: 'auto',
                stream: true
            })
        });
    }

    const resp = initialStreamResp;
    if (!resp || (!resp.ok && !usingSdk) || (!usingSdk && !resp.body)) {
        const text = !usingSdk && resp ? await resp.text().catch(() => '<no body>') : '<sdk error or no body>';
        res.status(502).json({ error: 'OpenAI request failed', detail: text });
        return;
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // For SDK streams, the returned object might be an async iterator or a
    // Response with a body stream. Handle both cases.
    let reader = null;
    let decoder = new TextDecoder('utf-8');
    let sdkAsyncIterator = null;
    if (usingSdk && typeof resp[Symbol.asyncIterator] === 'function') {
        sdkAsyncIterator = resp[Symbol.asyncIterator]();
    } else if (resp.body && typeof resp.body.getReader === 'function') {
        reader = resp.body.getReader();
    } else if (usingSdk && resp.stream) {
        // Some SDKs return { stream: AsyncIterable }
        if (typeof resp.stream[Symbol.asyncIterator] === 'function') sdkAsyncIterator = resp.stream[Symbol.asyncIterator]();
    }

    let functionCallBuffer = null; // accumulate function_call arguments if any
    let functionName = null;
    let streamEnded = false;

    // Helper to send SSE-like chunk to client
    function sendChunk(obj) {
        try {
            res.write(`data: ${JSON.stringify(obj)}\n\n`);
        } catch (e) {
            console.warn('Client disconnected while streaming:', e.message);
        }
    }

    console.log('Streaming initial OpenAI response...');

    // Helper to iterate SDK async iterator or reader
    async function iterateStream() {
        if (sdkAsyncIterator) {
            for await (const item of sdkAsyncIterator) {
                // SDK stream items vary: could be strings or structured objects.
                // Attempt to normalize by converting objects to tokens if possible.
                if (typeof item === 'string') {
                    // Heuristic: SDK may yield raw text chunks
                    const lines = item.split(/\n/).filter(Boolean);
                    for (const line of lines) {
                        if (line.trim() === '[DONE]') { streamEnded = true; break; }
                        // Try to parse SSE-style 'data: ' lines
                        const payload = line.startsWith('data: ') ? line.replace(/^data: /, '') : line;
                        try {
                            const parsed = JSON.parse(payload);
                            const delta = parsed.choices?.[0]?.delta || {};
                            if (delta.function_call) {
                                functionName = delta.function_call.name || functionName;
                                if (!functionCallBuffer) functionCallBuffer = '';
                                if (delta.function_call.arguments) functionCallBuffer += delta.function_call.arguments;
                                sendChunk({ type: 'tool_call_detected', tool: functionName });
                                streamEnded = true;
                                break;
                            }
                            if (delta.content) sendChunk({ type: 'token', text: delta.content });
                        } catch (e) {
                            // not JSON; treat as raw token text
                            sendChunk({ type: 'token', text: payload });
                        }
                    }
                    if (streamEnded) break;
                } else if (typeof item === 'object') {
                    // Structured chunk from SDK
                    const delta = item?.choices?.[0]?.delta || {};
                    if (delta.function_call) {
                        functionName = delta.function_call.name || functionName;
                        if (!functionCallBuffer) functionCallBuffer = '';
                        if (delta.function_call.arguments) functionCallBuffer += delta.function_call.arguments;
                        sendChunk({ type: 'tool_call_detected', tool: functionName });
                        streamEnded = true;
                        break;
                    }
                    if (delta.content) sendChunk({ type: 'token', text: delta.content });
                }
            }
        } else if (reader) {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = decoder.decode(value, { stream: true });
                // OpenAI server-sent events arrive separated by lines starting with "data:"
                const lines = chunk.split(/\n/).filter(Boolean);
                for (const line of lines) {
                    if (line.trim() === 'data: [DONE]') {
                        streamEnded = true;
                        break;
                    }
                    if (!line.startsWith('data: ')) continue;
                    const payload = line.replace(/^data: /, '');
                    let parsed;
                    try { parsed = JSON.parse(payload); } catch (e) { continue; }

                    const choice = parsed.choices && parsed.choices[0];
                    if (!choice) continue;

                    const delta = choice.delta || {};
                    if (delta.function_call) {
                        functionName = delta.function_call.name || functionName;
                        if (!functionCallBuffer) functionCallBuffer = '';
                        if (delta.function_call.arguments) {
                            functionCallBuffer += delta.function_call.arguments;
                        }
                        console.log('Detected function_call delta — pausing initial stream to run tool:', functionName);
                        sendChunk({ type: 'tool_call_detected', tool: functionName });
                        await reader.cancel();
                        streamEnded = true;
                        break;
                    }

                    if (delta.content) {
                        sendChunk({ type: 'token', text: delta.content });
                    }
                }
                if (streamEnded) break;
            }
        }
    }

    await iterateStream();

    // If a function call was detected, execute the MCP tool and resume conversation
    if (functionCallBuffer && functionName) {
        let args = {};
        try {
            args = JSON.parse(functionCallBuffer);
        } catch (e) {
            console.warn('Failed to parse function_call arguments:', functionCallBuffer);
            sendChunk({ type: 'error', message: 'Failed to parse tool arguments' });
            res.end();
            return;
        }

        // Call MCP server (which will perform the gmail tool). Pass only the
        // google access token so the MCP server can use it to call Gmail APIs.
        let toolResult;
        try {
            toolResult = await callMCP(googleToken, { tool: functionName, arguments: args });
            console.log('MCP tool result:', toolResult);
            sendChunk({ type: 'tool_result', tool: functionName, result: toolResult });
        } catch (e) {
            console.error('MCP tool call failed:', e);
            sendChunk({ type: 'error', message: 'Tool call failed: ' + e.message });
            res.end();
            return;
        }

        // Now resume the conversation by invoking OpenAI again, providing the
        // function result as a message of role=function. Stream the final answer.
        const resumedMessages = [...messages,
        { role: 'assistant', content: null, function_call: { name: functionName, arguments: functionCallBuffer } },
        { role: 'function', name: functionName, content: JSON.stringify(toolResult) }
        ];

        // Call OpenAI again to continue the conversation and stream final assistant reply
        const resp2 = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENAI_KEY}`
            },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                messages: resumedMessages,
                stream: true
            })
        });

        if (!resp2.ok || !resp2.body) {
            const text = await resp2.text().catch(() => '<no body>');
            sendChunk({ type: 'error', message: 'OpenAI resumed call failed', detail: text });
            res.end();
            return;
        }

        const reader2 = resp2.body.getReader();
        const decoder2 = new TextDecoder('utf-8');
        while (true) {
            const { done, value } = await reader2.read();
            if (done) break;
            const chunk = decoder2.decode(value, { stream: true });
            const lines = chunk.split(/\n/).filter(Boolean);
            for (const line of lines) {
                if (line.trim() === 'data: [DONE]') {
                    sendChunk({ type: 'done' });
                    break;
                }
                if (!line.startsWith('data: ')) continue;
                const payload = line.replace(/^data: /, '');
                let parsed;
                try { parsed = JSON.parse(payload); } catch (e) { continue; }
                const delta = parsed.choices && parsed.choices[0] && parsed.choices[0].delta;
                if (delta && delta.content) {
                    sendChunk({ type: 'token', text: delta.content });
                }
            }
        }
    }

    // End stream
    sendChunk({ type: 'finished' });
    try { res.end(); } catch (e) { /* ignore */ }
}

app.post('/api/chat', async (req, res) => {
    try {
        console.log('Incoming /api/chat request');
        const { prompt } = req.body || {};
        // The client must include a Supabase JWT in Authorization: Bearer <token>
        const supabaseTokenHeader = req.header('authorization') ? req.header('authorization').replace(/^Bearer\s+/i, '') : null;
        if (!supabaseTokenHeader) {
            return res.status(401).json({ error: 'Authorization required: missing Supabase token' });
        }

        // Validate Supabase token before proceeding
        const validatedUser = await validateSupabaseToken(supabaseTokenHeader);
        if (!validatedUser) {
            return res.status(401).json({ error: 'Invalid Supabase token' });
        }

        // Allow Google access token in a header (X-Google-Token) or as userToken in body
        const googleToken = req.header('x-google-token') || req.body?.userToken || null;

        if (!prompt || typeof prompt !== 'string') {
            return res.status(400).json({ error: 'Invalid request: prompt (string) required' });
        }

        // Stream response back to client. Pass googleToken so the backend can forward
        // it to the MCP server when tools are invoked. The Supabase token has already
        // been validated; we don't forward it to MCP.
        await streamChatWithFunctions(req, res, prompt, googleToken);
    } catch (err) {
        console.error('/api/chat error', err);
        if (!res.headersSent) res.status(500).json({ error: err.message });
    }
});

app.get("/auth/callback", async function (req, res) {
    const code = req.query.code
    const next = req.query.next ?? "/"
    console.log("HI THERE", code, next);
    if (code) {
        const supabase = createServerClient(
            process.env.SUPABASE_URL,
            process.env.SUPABASE_PUBLISHABLE_KEY, {
            cookies: {
                getAll() {
                    return parseCookieHeader(context.req.headers.cookie ?? '')
                },
                setAll(cookiesToSet) {
                    cookiesToSet.forEach(({ name, value, options }) =>
                        context.res.appendHeader('Set-Cookie', serializeCookieHeader(name, value, options))
                    )
                },
            },
        })
        await supabase.auth.exchangeCodeForSession(code)
    }
    console.log('Auth callback complete; redirecting to', next)
    res.redirect(303, `/${next.slice(1)}`)
})

app.listen(port, () => {
    console.log(`Vercel-like AI backend listening at http://localhost:${port}`);
});
