// modules/auth.js
// Minimal SessionManager for prototype use in popup/content/background.
// Uses chrome.runtime.sendMessage to trigger the START_GOOGLE_AUTH flow implemented in background.js

export class SessionManager {
  constructor() {
    this.currentSession = null; // { accessToken, tokenExpiry, user }
    this._signInResolver = null;
  }

  async signInWithGoogleIdentity(reason = "Google Identity API sign-in") {
    if (this.signInPromise) {
      console.log(`[LOG] SessionManager - Sign-in process already active. Returning existing promise for reason:`, reason);
      return this.signInPromise;
    }

    console.log(`[LOG] SessionManager - Starting Google Identity API sign-in, reason:`, reason);
    this.signInPromise = (async () => {
      try {
        // Get the redirect URL for this extension
        const redirectTo = chrome.identity.getRedirectURL();
        console.log("[LOG] Extension redirect URL:", redirectTo);

        // Start the OAuth flow with Supabase
        console.log("[LOG] Initiating Supabase OAuth flow");
        const { data, error } = await this.supabase.auth.signInWithOAuth({
          provider: "google",
          options: {
            redirectTo,
            skipBrowserRedirect: true,
          },
        });

        if (error) {
          throw new Error(`Supabase OAuth initiation failed: ${error.message}`);
        }

        if (!data?.url) {
          throw new Error("No OAuth URL received from Supabase");
        }

        customLog("[LOG] OAuth URL received, launching web auth flow");

        // Launch the web auth flow using Chrome Identity API
        const responseUrl = await new Promise((resolve, reject) => {
          chrome.identity.launchWebAuthFlow(
            {
              url: data.url,
              interactive: true,
            },
            responseUrl => {
              if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
              } else if (!responseUrl) {
                reject(new Error("No response URL received from OAuth flow"));
              } else {
                resolve(responseUrl);
              }
            }
          );
        });

        console.log("[LOG] OAuth response URL received:", responseUrl);

        // Create session from the response URL
        const session = await this.createSessionFromUrl(responseUrl);

        if (!session) {
          throw new Error("Failed to create session from OAuth response");
        }

        console.log("[LOG] Successfully created session from OAuth response");

        // Store the session
        await chrome.storage.local.set({ supabase_session: session });
        console.log("[LOG] Session stored in Chrome storage");

        // Set up auto-refresh listener
        this.setupAutoRefreshListener();

        return session;
      } catch (error) {
        console.error("[ERROR] Google Identity API sign-in failed:", error.message);
        throw error;
      } finally {
        // Clear the promise when done (success or failure)
        this.signInPromise = null;
        this.signInResolve = null;
      }
    })();

    return this.signInPromise;
  }

  async _fetchUserInfo(accessToken) {
    const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!res.ok) throw new Error('Failed to fetch userinfo');
    return await res.json();
  }

  async getFreshSession() {
    // Return stored session and a null error if present
    return new Promise((resolve) => {
      chrome.storage.local.get(['googleAccessToken', 'tokenExpiry', 'googleUser'], (items) => {
        if (items.googleAccessToken) {
          const session = { accessToken: items.googleAccessToken, tokenExpiry: items.tokenExpiry, user: items.googleUser };
          resolve({ session, error: null });
        } else {
          resolve({ session: null, error: new Error('No session') });
        }
      });
    });
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

  async fridayOAuthSignIn(reason = 'friday oauth') {
    // alias to signInWithGoogleIdentity for prototype
    return this.signInWithGoogleIdentity(reason);
  }

  async setInitialSession(session) {
    // session: { accessToken, tokenExpiry, user }
    return new Promise((resolve) => {
      chrome.storage.local.set({ googleAccessToken: session.accessToken, tokenExpiry: session.tokenExpiry, googleUser: session.user }, () => {
        this.currentSession = session;
        resolve(session);
      });
    });
  }

  resolveSignIn(response) {
    // For compatibility with existing code, simply return true if response provided
    return !!response;
  }
}

export default SessionManager;
