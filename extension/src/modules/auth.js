// src/modules/auth.js
// SessionManager moved into bundled source so popup can call sign-in directly.
import { AuthInvalidTokenResponseError } from '@supabase/supabase-js';
import { supabase } from '../lib/supabaseClient.js';

export class SessionManager {
  constructor() {
    this.currentSession = null;
    this.signInPromise = null;
    this.signInResolve = null;
    this.manifest = chrome.runtime.getManifest();
  }

  async signInWithGoogleIdentity(reason = "Google Identity API sign-in") {
    if (this.signInPromise) return this.signInPromise;

    this.signInPromise = (async () => {
      try {
        const redirectTo = chrome.identity.getRedirectURL(); //"http://localhost:3001/auth/callback";

        // If supabase client is present, use its OAuth initiation to get a URL
        let authUrl = null;
        if (supabase && supabase.auth && supabase.auth.signInWithOAuth) {
          const { data, error } = await supabase.auth.signInWithOAuth({
            provider: 'google',
            options: {
              redirectTo,
              scopes: "https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email https://mail.google.com/ https://www.googleapis.com/auth/contacts.other.readonly",
              skipBrowserRedirect: true,
              queryParams: {
                access_type: 'offline',
                prompt: 'consent',
              },
            },
          });

          if (error) throw new Error(`Supabase OAuth initiation failed: ${error.message}`);
          if (!data?.url) throw new Error('No OAuth URL received from Supabase');
          authUrl = data.url;
        } else {
          throw new Error('Supabase client not available or does not support signInWithOAuth');
        }

        // Launch Chrome identity flow
        const responseUrl = await new Promise((resolve, reject) => {
          chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, (response) => {
            if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
            if (!response) return reject(new Error('No response URL received from OAuth flow'));
            resolve(response);
          });
        });

        if (!responseUrl) {
          throw new Error('No response URL received from OAuth flow');
        }

        const fragment = responseUrl.split('#')[1];
        const params = new URLSearchParams(fragment);
        const code = params.get('access_token');
        const refresh_token = params.get('refresh_token');
        const provider_token = params.get('provider_token');

        // Call Google userinfo with the provider token
        const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: `Bearer ${provider_token}` } });
        if (!res.ok) {
          // include response body for easier debugging
          const body = await res.text().catch(() => '<no-body>');
          throw new Error(`Google userinfo failed: ${res.status} ${res.statusText} - ${body}`);
        }
        const user = await res.json();

        // Persist both tokens if available (so you can call Supabase or Google APIs later)
        const session = {
          access_token: code,
          refresh_token: refresh_token,
          provider_token: provider_token,
          user: user,
        }

        this.currentSession = session;
        return session;
      } finally {
        this.signInPromise = null;
      }
    })();

    return this.signInPromise;
  }

  async getCurrentUser() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['googleUser'], (items) => resolve(items.googleUser || null));
    });
  }

  async signOut() {
    return new Promise((resolve) => {
      supabase.auth.signOut().catch(() => { /* ignore errors */ });

      chrome.storage.local.remove(['googleAccessToken', 'tokenExpiry', 'googleUser'], () => {
        this.currentSession = null;
        resolve(true);
      });
    });
  }

  async getSession() {
    return this.currentSession;
  }

  // Returns a provider (Google) access token when available. This will first
  // check local storage for a cached `googleAccessToken` and expiry, then
  // attempt to extract a provider token from the Supabase session if present.
  // The token returned is suitable for calling Google APIs (Gmail) and can be
  // forwarded to your backend/MCP server for server-side Gmail calls.
  async getProviderToken() {
    // Read from chrome storage first
    const items = await new Promise((resolve) => {
      try {
        chrome.storage.local.get(['googleAccessToken', 'tokenExpiry'], (it) => resolve(it || {}));
      } catch (e) {
        resolve({});
      }
    });

    const { googleAccessToken, tokenExpiry } = items || {};
    if (googleAccessToken && tokenExpiry && tokenExpiry > Date.now() + 60000) {
      return googleAccessToken;
    }

    // Fallback: try to get provider token from Supabase session (some SDKs
    // expose `provider_token` or similar). This is best-effort for client-side
    // flows where Supabase handled OAuth.
    try {
      const { data } = await supabase.auth.getSession();
      const providerToken = data?.session?.provider_token || data?.session?.access_token || null;
      const expiresIn = data?.session?.expires_in || 3600;
      if (providerToken) {
        // cache into chrome storage for subsequent requests
        try {
          await new Promise((resolve) => chrome.storage.local.set({ googleAccessToken: providerToken, tokenExpiry: Date.now() + expiresIn * 1000 }, resolve));
        } catch (e) { /* ignore storage errors */ }
        return providerToken;
      }
    } catch (e) {
      // ignore and return null below
    }

    return null;
  }
}

export default SessionManager;
