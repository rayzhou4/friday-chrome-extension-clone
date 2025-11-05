import { getUserCredits } from "./modules/api.js";
import { customLog } from "./content.js";
import { SessionManager } from "./modules/auth.js";

// Create the single source of truth instance in the background script
const sessionManager = new SessionManager();

// Test Google Sign-in (Now correctly uses the background's sessionManager)
async function supabaseAuth() {
  customLog("[LOG] Entered supabaseAuth()");
  try {
    const { session, error } = await sessionManager.getFreshSession();
    if (error) throw error;
    customLog("[LOG] Returned session:", session);

    // Use the shared implementation that takes a session directly
    //TODO: why are we calling getUserCredits here? Can we evaluate auth status based on the credits instead of the session?
    const credits = await getUserCredits(session);
    customLog("Credits:", credits);

    // Only allow login if subscription is active or trialing
    if (session) {
      customLog("Valid session found, login successful");
      return true;
    } else {
      customLog("No active subscription found, rejecting login");
      throw new Error("No active subscription. Please subscribe or start a trial to use Friday.");
    }
  } catch (error) {
    throw error;
  }
}

// Helper function to format error responses consistently
const formatErrorResponse = (action, error) => {
  customLog(`[ERROR] ${action} background script failed:`, error);
  return {
    success: false, // Explicitly indicate failure for actions like supabaseAuth/signOut
    data: null, // Standardize presence of data field
    session: null, // Standardize presence of session field
    error: { message: error.message || "An unknown error occurred", name: error.name || "UnknownError" },
  };
};

// Map action strings to their handler functions
const actionHandlers = {
  supabaseAuth: async () => {
    // Note: supabaseAuth already throws on error, so we don't need explicit catch here
    // It also checks for active subscription internally now
    await supabaseAuth(); // Assuming it throws on failure / no subscription
    return { success: true }; // Return success payload
  },
  // fridayOAuthSignIn: async () => {
  //   const session = await sessionManager.fridayOAuthSignIn("popup sign in");
  //   return { session: session, error: null };
  // },
  signInWithGoogleIdentity: async () => {
    const session = await sessionManager.signInWithGoogleIdentity("manual Google sign-in from popup");
    return { session: session, error: null };
  },
  getFreshSession: async () => {
    const { session, error } = await sessionManager.getFreshSession();
    // Propagate potential errors from getFreshSession
    if (error) throw error;
    return { session: session, error: null };
  },
  getCurrentUser: async () => {
    const user = await sessionManager.getCurrentUser();
    return { data: user, error: null };
  },
  signOut: async () => {
    await sessionManager.signOut();
    return { success: true, error: null };
  },
  // checkBlockingRules: async () => {
  //   try {
  //     const rules = await chrome.declarativeNetRequest.getDynamicRules();
  //     customLog("[DEBUG] Current blocking rules:", rules);
  //     return { rules, error: null };
  //   } catch (error) {
  //     customLog("[ERROR] Failed to get blocking rules:", error);
  //     return { rules: null, error };
  //   }
  // },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = actionHandlers[message.action];

  if (handler) {
    customLog(`[LOG] Handling action: ${message.action}`);
    // Always pass (data, sender) to keep a simple interface; handlers may ignore args
    handler()
      .then(sendResponse) // Send the success payload from the handler
      .catch(error => {
        // Use the helper to format and log the error before sending
        sendResponse(formatErrorResponse(message.action, error));
      });
    return true; // Indicate asynchronous response
  }

  // If the action is not in our map, log it (optional) and return false
  customLog(`[WARN] Unhandled action: ${message.action}`);
  return false; // No handler found, sync response (or none)
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  customLog("Extension installed:", reason);

  if (reason === "install") {
    sessionManager.fridayOAuthSignIn("Extension installed");
  }
});

// // Add debugging listener to see when rules are matched
// chrome.declarativeNetRequest.onRuleMatchedDebug.addListener(details => {
//   customLog("[DEBUG] Rule matched:", details);
// });

// // Auto-authenticate on extension install using Google Identity API
// chrome.runtime.onInstalled.addListener(async details => {
//   if (details.reason === "install") {
//     customLog("[LOG] Extension installed, attempting automatic Google OAuth sign-in");
//     try {
//       const session = await sessionManager.signInWithGoogleIdentity("auto sign-in on install");
//       customLog("[LOG] Auto sign-in successful on install");
//     } catch (error) {
//       customLog("[LOG] Auto sign-in failed on install, user can sign in manually:", error.message);
//       // Don't throw error - just log it, user can sign in manually later
//     }
//   }
// });

chrome.runtime.onMessageExternal.addListener(async (message, sender, sendResponse) => {
  customLog("Received external message:", message);

  if (message.type === "SUPABASE_SESSION") {
    try {
      let session = message.session;
      let response = await sessionManager.setInitialSession(session);

      // Directly resolve any waiting sign-in promise (service worker compatible)
      const resolved = sessionManager.resolveSignIn(response);
      customLog(`[LOG] Sign-in resolution result: ${resolved ? "success" : "no active sign-in"}`);

      // Send response back to the external caller
      sendResponse({ success: true, session: response });
    } catch (error) {
      customLog("[ERROR] Error in onMessageExternal:", error);
      sendResponse({ success: false, error: error.message });
    }

    return true; // Indicate we will respond asynchronously
  }

  // For non-SUPABASE_SESSION messages, don't indicate async response
  return false;
});
