// src/modules/auth.js
// SessionManager moved into bundled source so popup can call sign-in directly.
import { supabase } from '../lib/supabaseClient.js';

export class SessionManager {
  constructor() {
    this.currentSession = null;
    this.signInPromise = null;
    this.signInResolve = null;
  }

  async signInWithGoogleIdentity(reason = "Google Identity API sign-in") {
    if (this.signInPromise) return this.signInPromise;

    this.signInPromise = (async () => {
      try {
        const redirectTo = chrome.identity.getRedirectURL();

        // If supabase client is present, use its OAuth initiation to get a URL
        let authUrl = null;
        if (supabase && supabase.auth && supabase.auth.signInWithOAuth) {
          const { data, error } = await supabase.auth.signInWithOAuth({
            provider: 'google',
            options: { redirectTo, skipBrowserRedirect: true }
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

        // Create session from the response URL using Supabase SDK
        // Different Supabase SDK versions return either a URL with an access_token fragment
        // or a code that needs to be exchanged. Diagnose first and then handle both cases.
        // Log the response URL for debugging in the popup console
        try {
          console.log('[LOG] OAuth response URL:', responseUrl);
        } catch (e) {}

        // If SDK exposes getSessionFromUrl, prefer it (some helper builds provide this)
        if (supabase && supabase.auth) {
          if (typeof supabase.auth.getSessionFromUrl === 'function') {
            const { data, error } = await supabase.auth.getSessionFromUrl({ url: responseUrl });
            if (error) throw new Error(error.message || 'Failed to create session from URL');
            const session = data.session || null;
            if (!session) throw new Error('No session returned from Supabase');
            await chrome.storage.local.set({ googleAccessToken: session.access_token, tokenExpiry: Date.now() + (session.expires_in || 3600) * 1000, googleUser: session.user });
            this.currentSession = session;
            return session;
          }

          // Some SDKs expose an exchange method for code flows
          if (typeof supabase.auth.exchangeCodeForSession === 'function') {
            // If responseUrl contains a `code` param, extract it and exchange
            const urlObj = new URL(responseUrl);
            const code = urlObj.searchParams.get('code') || null;
            if (code) {
              const { data, error } = await supabase.auth.exchangeCodeForSession(code);
              if (error) throw new Error(error.message || 'Failed to exchange code for session');
              const session = data.session || null;
              if (!session) throw new Error('No session returned from Supabase after exchange');
              await chrome.storage.local.set({ googleAccessToken: session.access_token, tokenExpiry: Date.now() + (session.expires_in || 3600) * 1000, googleUser: session.user });
              this.currentSession = session;
              return session;
            }
          }
        }

        // Fallback: parse tokens from fragment. Note: when using Supabase as the OAuth broker
        // the `access_token` in the fragment is often the Supabase JWT (not a Google token).
        // Supabase also returns `provider_token` (the upstream Google access token) which
        // is the one you must use with Google APIs (userinfo, Gmail). Prefer provider_token.
        try {
          const hash = new URL(responseUrl).hash.substring(1);
          const params = new URLSearchParams(hash);
          // Supabase may return both a Supabase access_token and a provider_token (Google token)
          const supabaseAccessToken = params.get('access_token');
          const providerToken = params.get('provider_token') || params.get('google_access_token') || null;
          const refreshToken = params.get('refresh_token') || null;
          const expiresIn = parseInt(params.get('expires_in') || '3600', 10);

          // The token to use for Google APIs is the providerToken when available.
          const tokenForGoogle = providerToken || supabaseAccessToken;

          if (!tokenForGoogle) throw new Error('No usable access token in response (provider_token or access_token)');

          // Call Google userinfo with the provider token (if present). If providerToken is missing
          // and we only have a Supabase JWT, that token will be rejected by Google (401).
          const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: `Bearer ${tokenForGoogle}` } });
          if (!res.ok) {
            // include response body for easier debugging
            const body = await res.text().catch(() => '<no-body>');
            throw new Error(`Google userinfo failed: ${res.status} ${res.statusText} - ${body}`);
          }
          const user = await res.json();

          // Persist both tokens if available (so you can call Supabase or Google APIs later)
          const toStore = {
            googleAccessToken: providerToken || null,
            supabaseAccessToken: supabaseAccessToken || null,
            refreshToken: refreshToken || null,
            tokenExpiry: Date.now() + expiresIn * 1000,
            googleUser: user
          };

          await chrome.storage.local.set(toStore);

          const session = { access_token: supabaseAccessToken || tokenForGoogle, expires_in: expiresIn, user, provider_token: providerToken };
          this.currentSession = session;
          return session;
        } catch (err) {
          throw err;
        }
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
      chrome.storage.local.remove(['googleAccessToken', 'tokenExpiry', 'googleUser'], () => {
        this.currentSession = null;
        resolve(true);
      });
    });
  }
}

export default SessionManager;
