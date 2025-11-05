// background.js
// Basic background service worker to handle Google OAuth (chrome.identity) and Gmail API helper
// Replace CLIENT_ID with your Google OAuth client ID. Ensure the OAuth client has a redirect URI
// matching chrome.identity.getRedirectURL() (e.g. https://<EXT_ID>.chromiumapp.org/)

import { SessionManager } from "./modules/auth.js";

const sessionManager = new SessionManager();

// Quick startup log so devtools can confirm the module-loaded service worker
console.log('Extension background (module) loaded — sessionManager initialized');

const CLIENT_ID = '992334442706-g3hst0j0ijiqaj3c4ga2tcfrabhek95r.apps.googleusercontent.com';
const SCOPES = [
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://mail.google.com/',
    'https://www.googleapis.com/auth/contacts.other.readonly'
];

function buildAuthUrl(redirectUri) {
    const params = new URLSearchParams({
        client_id: CLIENT_ID,
        response_type: 'token',
        redirect_uri: redirectUri,
        scope: SCOPES.join(' '),
        include_granted_scopes: 'true',
        prompt: 'consent'
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

// Handle messages from popup/content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message) return;

    // Simple PING handler for debugging from popup
    if (message.type === 'PING') {
        sendResponse({ pong: true });
        return;
    }

    // Popup requests sign-in
    if (message.action === 'signInWithGoogleIdentity') {
        (async () => {
            try {
                const session = await sessionManager.signInWithGoogleIdentity("manual Google sign-in from popup");
                sendResponse({ session: session, error: null });
            } catch (err) {
                sendResponse({ session: null, error: err && err.message ? err.message : String(err) });
            }
        })();
        // Indicate we'll respond asynchronously
        return true;
    }

    // Popup asks for current user
    if (message.action === 'getCurrentUser') {
        chrome.storage.local.get(['currentUser'], (items) => {
            sendResponse({ data: items.currentUser || null });
        });
        return true;
    }

    // Sign out (clear stored tokens/profile)
    if (message.action === 'signOut') {
        chrome.storage.local.remove(['googleAccessToken', 'tokenExpiry', 'currentUser'], () => {
            sendResponse({ ok: true });
        });
        return true;
    }

    if (message.type === 'GET_TOKEN') {
        chrome.storage.local.get(['googleAccessToken', 'tokenExpiry'], (items) => {
            sendResponse(items);
        });
        return true;
    }

    if (message.type === 'GET_GMAIL_LABELS') {
        chrome.storage.local.get(['googleAccessToken', 'tokenExpiry'], async (items) => {
            const token = items.googleAccessToken;
            if (!token) {
                sendResponse({ success: false, error: 'No access token' });
                return;
            }

            try {
                const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/labels', {
                    headers: { Authorization: `Bearer ${token}` }
                });
                if (!res.ok) throw new Error('Gmail API error: ' + res.status);
                const json = await res.json();
                sendResponse({ success: true, labels: json.labels });
            } catch (err) {
                sendResponse({ success: false, error: err.message });
            }
        });
        return true;
    }
});

// Optional: onInstalled for debugging
chrome.runtime.onInstalled.addListener(() => {
    console.log('Background service worker installed');
});
