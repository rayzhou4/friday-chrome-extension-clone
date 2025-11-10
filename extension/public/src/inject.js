/**
 * Friday content script (adapted from friday-content.js)
 * Converted from ES module to a self-contained content script.
 * Note: module imports were removed; this script expects helper functions
 * (getUserEmail, createButtons, modifyGeminiChatHeader, etc.) to be provided
 * elsewhere in the extension bundle or the page context.
 */

/* Configuration - set AI_API_HOST to your deployed AI endpoint that accepts
     POST /chat with { message, context } and returns { reply }.
     During development you can set this to a local server or your Vercel endpoint.
*/
const AI_API_HOST = 'http://localhost:3001';

// Prediction store stub (if real PredictionStore is available it will be used)
const predictionStore = (typeof PredictionStore !== 'undefined') ? new PredictionStore() : {
    ready: async () => { },
    hasPrediction: () => false,
    hasCurrentPrediction: () => false,
    getPrediction: () => null,
    savePrediction: async () => { },
    removePrediction: async () => { },
    removeFirstActionType: async () => [],
    switchActionType: async () => [],
};

// Cache to track pending prediction requests
const pendingPredictionRequests = new Map();
// Timeout for pending requests (in milliseconds)
const PREDICTION_REQUEST_TIMEOUT = 30000; // 30 seconds

// Friday chat instance
let fridayChat = null;

// Global storage for chat instances by container
const chatInstances = new Map();

// Reference to the top-level main container created by createButtons()
let fridayMainContainer = null;

let DEBUG_MODE = (chrome && chrome.runtime && chrome.runtime.id === "lacdpddobmgjkoajccodjhpdlbgahmbj") || false;
console.log("DEBUG_MODE:", DEBUG_MODE);

// Chat mode flag - default to true, can be overridden by storage
let CHAT_MODE = true;

// Initialize DEBUG_MODE from storage (best-effort)
(async function initDebugMode() {
    try {
        if (chrome && chrome.storage && chrome.storage.local) {
            const { friday_debug_mode } = await chrome.storage.local.get("friday_debug_mode");
            if (friday_debug_mode !== undefined) {
                DEBUG_MODE = friday_debug_mode;
                customLog(`[LOG] Debug mode initialized to: ${DEBUG_MODE}`);
            } else {
                await chrome.storage.local.set({ friday_debug_mode: DEBUG_MODE });
            }
        }
    } catch (error) {
        customLog("[ERROR] Error initializing debug mode:", error);
    }
})();

// Initialize CHAT_MODE from storage (best-effort)
(async function initChatMode() {
    try {
        if (chrome && chrome.storage && chrome.storage.local) {
            const { friday_chat_mode } = await chrome.storage.local.get("friday_chat_mode");
            if (friday_chat_mode !== undefined) {
                CHAT_MODE = friday_chat_mode;
                customLog(`[LOG] Chat mode initialized to: ${CHAT_MODE}`);
            } else {
                await chrome.storage.local.set({ friday_chat_mode: CHAT_MODE });
            }
        }
    } catch (error) {
        customLog("[ERROR] Error initializing chat mode:", error);
    }
})();

if (chrome && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, namespace) => {
        if (namespace === "local" && changes.friday_debug_mode) {
            DEBUG_MODE = changes.friday_debug_mode.newValue;
            customLog(`[LOG] Debug mode updated to: ${DEBUG_MODE}`);
        }
        if (namespace === "local" && changes.friday_chat_mode) {
            CHAT_MODE = changes.friday_chat_mode.newValue;
            customLog(`[LOG] Chat mode updated to: ${CHAT_MODE}`);
        }
    });
}

if (chrome && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === "getEmail") {
            const email = (typeof getUserEmail === 'function') ? getUserEmail() : null;
            customLog("Sending email back to popup:", email);
            sendResponse({ email });
            return true; // Keep channel open for async response
        }
        return false;
    });
}

function customLog(...args) {
    if (DEBUG_MODE) console.log(...args);
}

/**
 * Create or return a floating, fixed-position container for the Friday chat.
 * The container is placed on the right side and sized based on the viewport.
 */
function createFloatingContainer() {
    try {
        let el = document.getElementById('friday-floating-container');
        if (el) return el;
        el = document.createElement('div');
        el.id = 'friday-floating-container';
        el.className = 'friday-extension-container';
        el.style.position = 'fixed';
        el.style.right = '20px';
        el.style.top = '8vh';
        el.style.zIndex = String(2147483646);
        el.style.background = '#000000';
        el.style.boxShadow = '0 10px 30px rgba(2,6,23,0.8)';
        el.style.borderRadius = '12px';
        el.style.border = '1px solid rgba(255,255,255,0.03)';
        el.style.backdropFilter = 'blur(6px)';
        el.style.overflow = 'hidden';
        el.style.display = 'block';

        function applySize() {
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            const width = Math.min(480, Math.max(320, Math.floor(vw * 0.32)));
            const height = Math.min(Math.floor(vh * 0.9), Math.max(300, Math.floor(vh * 0.7)));
            el.style.width = width + 'px';
            el.style.height = height + 'px';
        }

        applySize();
        window.addEventListener('resize', applySize);

        // Ensure body exists and append floating container
        if (!document.body) document.documentElement.appendChild(el);
        else document.body.appendChild(el);

        // Create a minimal chat UI inside the floating container if one
        // doesn't already exist. This gives a quick Cursors-like chat
        // interface: header, message area, and footer with input + send.
        try {
            let main = window.fridayMainContainer || el.querySelector('.friday-main-container') || document.querySelector('.friday-main-container');
            if (!main) {
                main = document.createElement('div');
                main.className = 'friday-main-container';
                Object.assign(main.style, {
                    display: 'flex',
                    flexDirection: 'column',
                    width: '100%',
                    height: '100%',
                    background: 'transparent',
                    boxSizing: 'border-box',
                    padding: '0',
                    color: '#e6eef8'
                });

                const header = document.createElement('div');
                header.className = 'friday-header';
                header.textContent = 'Friday Chat';
                Object.assign(header.style, {
                    fontWeight: '700',
                    padding: '12px 16px',
                    color: '#ffffff',
                    fontSize: '15px',
                    background: 'linear-gradient(90deg,#0b1220 0%, #0f1724 100%)',
                    borderRadius: '8px 8px 0 0',
                    boxShadow: 'inset 0 -1px 0 rgba(255,255,255,0.02)'
                });

                const messageArea = document.createElement('div');
                messageArea.className = 'friday-message-area';
                Object.assign(messageArea.style, { flex: '1 1 auto', overflowY: 'auto', padding: '12px', background: 'transparent', color: '#dbeafe' });
                messageArea.innerHTML = '<div style="color:#9ca3af">Friday is ready — type a message below.</div>';

                const footer = document.createElement('div');
                Object.assign(footer.style, { display: 'flex', gap: '8px', padding: '12px', borderTop: '1px solid rgba(15,23,42,0.04)', alignItems: 'center' });

                const input = document.createElement('textarea');
                input.className = 'friday-prompt-box';
                input.placeholder = 'Ask Friday something...';
                Object.assign(input.style, { flex: '1 1 auto', resize: 'none', minHeight: '48px', maxHeight: '140px', padding: '10px 12px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.04)', background: '#0b1220', color: '#e6eef8' });

                const sendButton = document.createElement('button');
                sendButton.innerText = '➤';
                Object.assign(sendButton.style, { width: '44px', height: '44px', padding: '0', background: 'linear-gradient(90deg,#111827,#0b1220)', color: '#fff', border: 'none', borderRadius: '10px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 6px 14px rgba(2,6,23,0.6)' });

                sendButton.addEventListener('click', async () => {
                    const text = input.value.trim();
                    if (!text) return;

                    // Clear input textarea and disable sendButton while processing
                    input.value = '';
                    sendButton.disabled = true;

                    // Append a simple user bubble
                    const userBubble = document.createElement('div');
                    userBubble.textContent = text;
                    Object.assign(userBubble.style, { alignSelf: 'flex-end', background: '#111827', color: '#e6eef8', padding: '10px 12px', borderRadius: '14px', marginBottom: '8px', maxWidth: '80%', boxShadow: '0 6px 18px rgba(2,6,23,0.6)' });
                    messageArea.appendChild(userBubble);
                    messageArea.scrollTop = messageArea.scrollHeight;

                    // Create assistant bubble where tokens will stream into
                    const assistantBubble = document.createElement('div');
                    assistantBubble.textContent = '';
                    Object.assign(assistantBubble.style, { alignSelf: 'flex-start', background: '#021024', color: '#dbeafe', padding: '10px 12px', borderRadius: '14px', marginBottom: '8px', maxWidth: '85%', wordWrap: 'break-word', overflowWrap: 'break-word', whiteSpace: 'pre-line' });
                    messageArea.appendChild(assistantBubble);
                    messageArea.scrollTop = messageArea.scrollHeight;

                    // Try to send to backend (demo path). The backend streams SSE-like chunks.
                    try {
                        await streamToBackend(text, assistantBubble, messageArea);
                    } catch (e) {
                        console.error('Chat backend error', e);
                        assistantBubble.textContent = 'Error: ' + (e.message || String(e));
                    }

                    // Also forward to any existing FridayChat implementation for compatibility
                    try {
                        const emailAddress = (typeof getUserEmail === 'function') ? getUserEmail() : null;
                        if (emailAddress) {
                            const chat = initializeFridayChat(messageArea, emailAddress);
                            if (chat && typeof chat.sendMessage === 'function') chat.sendMessage(text);
                        }
                    } catch (e) { customLog('chat send error', e); }

                    sendButton.disabled = false;
                });

                footer.appendChild(input);
                footer.appendChild(sendButton);

                main.appendChild(header);
                main.appendChild(messageArea);
                main.appendChild(footer);
            }

            // Move main into floating container if needed
            try {
                const existingMain = el.querySelector('.friday-main-container');
                if (!existingMain) el.appendChild(main);
                window.fridayMainContainer = main;
            } catch (e) { /* ignore */ }
        } catch (e) {
            customLog('createFloatingContainer UI init error', e);
        }

        return el;
    } catch (e) {
        customLog('createFloatingContainer error', e);
        return null;
    }
}

function createFridayChatButton() {
    try {
        if (typeof document === 'undefined') return;
        if (document.getElementById('friday-toggle-btn')) return;

        // If body isn't ready yet, try again shortly
        if (!document.body) {
            setTimeout(createFridayChatButton, 250);
            return;
        }

        // Create minimal button that delegates to the main toggle logic when available
        const btn = document.createElement('button');
        btn.id = 'friday-toggle-btn';
        btn.type = 'button';
        btn.title = 'Toggle Friday Chat';
        btn.setAttribute('aria-label', 'Toggle Friday Chat');
        btn.innerText = 'Friday Chat';
        Object.assign(btn.style, {
            position: 'fixed',
            bottom: '20px',
            right: '20px',
            zIndex: String(2147483647),
            width: '56px',
            height: '56px',
            borderRadius: '8px',
            border: 'none',
            background: '#000000',
            color: '#fff',
            boxShadow: '0 6px 18px rgba(0,0,0,0.2)',
            cursor: 'pointer',
            fontSize: '12px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'auto'
        });

        const floatingContainer = document.getElementById('friday-floating-container');
        if (!floatingContainer) { customLog('Floating container not found for toggle button'); return; }
        btn.addEventListener('click', function () {
            if (floatingContainer.style.display === 'none') {
                floatingContainer.style.display = 'flex';
            } else {
                floatingContainer.style.display = 'none';
            }
        });

        document.body.appendChild(btn);
    } catch (err) {
        // silent
    }
}

// Create floating container and toggle button early.
// Previously this used an `ensureFloatingMainNow` helper that retried until the
// document body existed. The individual creators handle body availability as
// needed, so call them directly now.
try { createFloatingContainer(); } catch (e) { customLog('createFloatingContainer launch failed', e); }
try { createFridayChatButton(); } catch (e) { customLog('createFridayChatButton launch failed', e); }

// Stream helper to call backend and stream tokens into assistant bubble
async function streamToBackend(prompt, assistantBubble, messageArea) {
    // Backend URL — adapt if your backend runs on a different port
    const url = `${AI_API_HOST}/api/chat`;

    // Get real tokens from background script
    let supabaseToken = '';
    let googleToken = '';

    try {
        // Get session from background script
        // const sessionResponse = await chrome.runtime.sendMessage({ action: 'getFreshSession' });
        // if (sessionResponse && sessionResponse.session) {
        //     supabaseToken = sessionResponse.session.access_token || '';
        // }
        // Get Google token from chrome storage
        const items = await new Promise(resolve => chrome.storage.local.get(['providerToken'], resolve));
        googleToken = items.providerToken || '';

    } catch (e) {
        console.warn('[WARN] Failed to get auth tokens:', e.message);
    }

    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supabaseToken}`,
        'x-google-token': googleToken
    };

    const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ prompt })
    });
    if (!resp.ok) {
        const body = await resp.text().catch(() => '<no body>');
        throw new Error(`Backend returned ${resp.status}: ${body}`);
    }

    // Stream response body
    const reader = resp.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    // Append helper
    function appendToAssistant(text) {
        assistantBubble.textContent += text;
        messageArea.scrollTop = messageArea.scrollHeight;
    }

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Process SSE-like "data: {...}\n\n" chunks
        const parts = buffer.split(/\n\n/);
        buffer = parts.pop(); // remainder
        for (const part of parts) {
            const line = part.trim();
            if (!line) continue;
            // lines may contain multiple data: entries; handle each
            const dataLines = line.split(/\n/).map(l => l.replace(/^data:\s*/, ''));
            for (const dl of dataLines) {
                if (!dl) continue;
                let obj = null;
                try { obj = JSON.parse(dl); } catch (e) { continue; }
                if (!obj || !obj.type) continue;
                switch (obj.type) {
                    case 'token':
                        appendToAssistant(obj.text || '');
                        break;
                    case 'tool_call_detected':
                        appendToAssistant('\n[Fetching from Gmail...]\n');
                        break;
                    case 'tool_result':
                        // show tool result as structured JSON excerpt
                        try {
                            const pretty = typeof obj.result === 'object' ? JSON.stringify(obj.result, null, 2) : String(obj.result);
                            appendToAssistant('\n[Tool result]\n' + pretty + '\n');
                        } catch (e) {
                            appendToAssistant('\n[Tool result received]\n');
                        }
                        break;
                    case 'error':
                        appendToAssistant('\n[Error] ' + (obj.message || JSON.stringify(obj)) + '\n');
                        break;
                    case 'finished':
                        console.log('Stream finished');
                        // noop; stream ending soon
                        break;
                    default:
                        // unknown types — ignore or log
                        console.debug('Unknown stream type', obj.type, obj);
                }
            }
        }
    }
}

// Function to send chat messages to the vercel-ai-backend
async function sendChatMessageToBackend(message) {
    try {
        const sessionManager = new SessionManager();
        const session = await sessionManager.getSession();

        if (!session || !session.provider_token) {
            throw new Error('User is not authenticated or provider token is missing');
        }

        const context = { googleToken: session.provider_token };

        const response = await fetch(`${AI_API_HOST}/chat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ message, context }),
        });

        if (!response.ok) {
            throw new Error(`Error from backend: ${response.statusText}`);
        }

        const data = await response.json();
        return data.reply;
    } catch (error) {
        customLog('[ERROR] Failed to send chat message to backend:', error);
        throw error;
    }
}

// Example usage of the function
if (CHAT_MODE) {
    const exampleMessage = "Hello, how can I assist you?";

    sendChatMessageToBackend(exampleMessage)
        .then(reply => customLog('[LOG] Reply from backend:', reply))
        .catch(error => customLog('[ERROR] Chat message failed:', error));
}

async function main() {
    customLog('[LOG] Starting extension');

    try {
        customLog('[LOG] Getting email address...');
        let emailAddress = (typeof getUserEmail === 'function') ? getUserEmail() : null;
        for (let retryCount = 0; !emailAddress && retryCount < 1000; retryCount++) {
            customLog('[LOG] No email address found, waiting to retry...');
            await new Promise(resolve => setTimeout(resolve, 1000));
            emailAddress = (typeof getUserEmail === 'function') ? getUserEmail() : null;
        }

        if (!emailAddress) {
            customLog('[ERROR] Failed to get email address after multiple attempts');
            return;
        }

        customLog('[LOG] Found email address:', emailAddress);
        customLog('[LOG] Starting auth process');
        const response = (chrome && chrome.runtime) ? await chrome.runtime.sendMessage({ action: 'supabaseAuth' }) : { success: true };

        if (!response.success) {
            customLog('[ERROR] Failed to initialize Supabase Sign-in:', response.error);
            await chrome.storage.local.set({ friday_auth_error: response.error.message });
            chrome.runtime.sendMessage({ action: 'refresh' });
            throw new Error(response.error.message);
        }

        customLog('[LOG] Supabase Sign-in initialized (see background worker for logs)');
        if (chrome && chrome.storage && chrome.storage.local) await chrome.storage.local.remove('friday_auth_error');
        if (chrome && chrome.runtime) chrome.runtime.sendMessage({ action: 'refresh' });
    } catch (error) {
        customLog('[ERROR] Failed to initialize Supabase Sign-in (see background worker for logs):', error.message);
        if (chrome && chrome.storage && chrome.storage.local) await chrome.storage.local.set({ friday_auth_error: error.message });
        if (chrome && chrome.runtime) chrome.runtime.sendMessage({ action: 'refresh' });
        return;
    }

    await predictionStore.ready();

    const buttons = (typeof createButtons === 'function') ? createButtons(DEBUG_MODE) : null;
    const mainContainer = buttons ? buttons.mainContainer : document.createElement('div');
    // expose main container for the toggle button
    fridayMainContainer = mainContainer;

    // Create floating container and move the main container into it so the chat is a sticky overlay
    try {
        const floating = createFloatingContainer();
        if (floating) {
            if (mainContainer.parentNode !== floating) {
                // reset styles on main to fill floating container
                mainContainer.style.width = '100%';
                mainContainer.style.height = '100%';
                mainContainer.style.overflow = 'auto';
                floating.appendChild(mainContainer);
            }
        }
    } catch (e) { customLog('failed to move main into floating container', e); }
    const predictButton = buttons ? buttons.predictButton : document.createElement('button');
    const predictionText = buttons ? buttons.predictionText : document.createElement('div');
    const reasoningText = buttons ? buttons.reasoningText : document.createElement('div');
    const actionContainer = buttons ? buttons.actionContainer : document.createElement('div');

    if (predictButton && typeof predictButton.addEventListener === 'function') {
        predictButton.addEventListener('click', () => onPredictButtonClick(predictionText, reasoningText, actionContainer, true));
    }

    document.addEventListener('friday-send-message', () => submitPrompt());

    setupMutationObserver(mainContainer, predictionText, reasoningText, actionContainer);

    // Ensure a bottom-right toggle is available to show/hide the Friday chat UI
    try { createFridayChatButton(); } catch (e) { customLog('Failed to add toggle button', e); }

    if (typeof isInListView === 'function' && isInListView()) addPredictButtonToRows();

    if (CHAT_MODE && typeof isGeminiButtonVisible === 'function' && isGeminiButtonVisible()) if (typeof addFridayChatButton === 'function') addFridayChatButton();

    if (CHAT_MODE && typeof isGeminiChatOpen === 'function' && isGeminiChatOpen()) initializeGeminiChat();
}

// Auto-run main to initialize chat UI
try { main().catch(e => console.warn('friday main error', e)); } catch (e) { console.warn('friday main launch failed', e); }

