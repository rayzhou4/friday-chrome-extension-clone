/**
 * Main entry point of the content script.
 * Sets up the UI, prediction button, mutation observer, and event listeners.
 * Modeled after the function organization style used in friday.py.
 */

import { predictAction, getDraft, sendChatMessage } from "./modules/api.js";
import {
  getThreadIdFromPage,
  isInListView,
  isGeminiButtonVisible,
  isInInbox,
  isInLabels,
  getThreadIdFromRow,
  archiveEmail,
  archiveFromRowView,
  replyToEmail,
  forwardEmail,
  getEmailRows,
  getUserEmail,
  getUnsubscribeButton,
  findUnsubscribeLink,
  replyBoxIsOpen,
  inputReply,
  getMessageBody,
  removeOriginalDraft,
  unsubscribe,
  isGeminiChatOpen,
} from "./modules/gmail.js";
import {
  createButtons,
  createActionButton,
  addPromptBox,
  getPromptFromBox,
  clearPromptBox,
  applyRowButtonBaseStyle,
  applyRowButtonActionStyle,
  applyRowButtonInteractiveEffects,
  applyPrimaryActionStyle,
  applySecondaryActionStyle,
  applyPredictionButtonStyle,
  createShortcutIndicator,
  addFridayChatButton,
  modifyGeminiChatHeader,
  modifyGeminiChat,
  modifyGeminiChatFooter,
} from "./modules/ui.js";
import { PredictionStore } from "./modules/storage.js";

const predictionStore = new PredictionStore();

// Cache to track pending prediction requests
const pendingPredictionRequests = new Map();
// Timeout for pending requests (in milliseconds)
const PREDICTION_REQUEST_TIMEOUT = 30000; // 30 seconds

// Friday chat instance
let fridayChat = null;

// Global storage for chat instances by container
const chatInstances = new Map();

// Debug mode flag - default based on extension ID, can be overridden by storage
let DEBUG_MODE = chrome.runtime.id === "lacdpddobmgjkoajccodjhpdlbgahmbj";
console.log("DEBUG_MODE:", DEBUG_MODE);

// Chat mode flag - default to true, can be overridden by storage
let CHAT_MODE = chrome.runtime.id === "lacdpddobmgjkoajccodjhpdlbgahmbj";

// Initialize DEBUG_MODE from storage
(async function initDebugMode() {
  try {
    const { friday_debug_mode } = await chrome.storage.local.get("friday_debug_mode");
    if (friday_debug_mode !== undefined) {
      DEBUG_MODE = friday_debug_mode;
      customLog(`[LOG] Debug mode initialized to: ${DEBUG_MODE}`);
    } else {
      // Set initial value in storage
      await chrome.storage.local.set({ friday_debug_mode: DEBUG_MODE });
    }
  } catch (error) {
    customLog("[ERROR] Error initializing debug mode:", error);
  }
})();

// Initialize CHAT_MODE from storage
(async function initChatMode() {
  try {
    const { friday_chat_mode } = await chrome.storage.local.get("friday_chat_mode");
    // If friday_chat_mode exists in storage, use it; otherwise keep the default
    if (friday_chat_mode !== undefined) {
      CHAT_MODE = friday_chat_mode;
      customLog(`[LOG] Chat mode initialized to: ${CHAT_MODE}`);
    } else {
      // Set initial value in storage
      await chrome.storage.local.set({ friday_chat_mode: CHAT_MODE });
    }
  } catch (error) {
    customLog("[ERROR] Error initializing chat mode:", error);
  }
})();

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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // customLog("Received message in content.js:", message);
  if (message.action === "getEmail") {
    const email = getUserEmail();
    customLog("Sending email back to popup:", email);
    sendResponse({ email });
    return true; // Keep channel open for async response
  }
  return false;
});

export function customLog(...args) {
  if (DEBUG_MODE) {
    console.log(...args);
  }
}

/**
 * Retrieves or fetches a prediction for the given thread ID.
 * @param {string} threadId - The hex string representing the Gmail thread ID.
 * @returns {Promise<{
 *   result: {
 *     similar_emails: string[],
 *     prediction: {
 *       types: string[],
 *       confidence: number,
 *       reasoning: string,
 *       suggested_response?: string
 *     }
 *   },
 *   error: any
 * }>} - The prediction object from the API or cache.
 */
async function getPredictionForThread(threadId, forceRecompute = false, row = null) {
  // Skip cache if forcing recompute
  if (forceRecompute) {
    customLog("[LOG] Forcing recomputation for thread", threadId);
    return fetchPrediction(threadId, forceRecompute, row);
  }

  let threadData = row ? getThreadIdFromRow(row) : getThreadIdFromPage();
  let lastMessageId = threadData?.legacyLastNonDraftMessageId;

  if (!threadData) {
    customLog("[LOG] No thread data found for thread", threadId);

    if (predictionStore.hasPrediction(threadId)) {
      const storedPrediction = predictionStore.getPrediction(threadId);
      return { result: storedPrediction.prediction, error: null };
    }

    customLog("[LOG] No prediction found for thread", threadId);
  } else {
    if (predictionStore.hasCurrentPrediction(threadId, lastMessageId)) {
      const storedPrediction = predictionStore.getPrediction(threadId);
      return { result: storedPrediction.prediction, error: null }; //TODO: can simplify this
    }

    customLog("[LOG] No current prediction found for thread", threadId, "with the last message ID:", lastMessageId);
    if (!lastMessageId) {
      customLog("[ERROR] No current last message ID found for thread", threadId, "thread data:", threadData);
    }
  }

  const cacheKey = threadId;

  if (pendingPredictionRequests.has(cacheKey)) {
    customLog("[LOG] Returning pending prediction request for", cacheKey);
    return pendingPredictionRequests.get(cacheKey);
  }

  customLog("[LOG] Creating new prediction request for", cacheKey);

  // If no pending request exists, create a new one with timeout protection
  const predictionPromise = fetchPrediction(threadId, forceRecompute, row);

  // Create a promise that will reject after the timeout
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(`Prediction request for ${cacheKey} timed out after ${PREDICTION_REQUEST_TIMEOUT}ms`));
    }, PREDICTION_REQUEST_TIMEOUT);
  });

  // Race between the actual prediction and the timeout
  const resultPromise = Promise.race([predictionPromise, timeoutPromise])
    .then(result => {
      // If the prediction request completed first, the then block will execute
      customLog("[LOG] Prediction request completed first for", cacheKey);
      return result;
    })
    .catch(error => {
      // If the timeout occurred first, the catch block will execute
      if (error.message.includes("timed out")) customLog("[LOG] Timeout occurred first for", cacheKey, ":", error.message);
      else customLog("[ERROR] Prediction request failed for", cacheKey, ":", error);
      throw error;
    })
    .finally(() => {
      customLog("[LOG] Clearing pending prediction request for", cacheKey);
      pendingPredictionRequests.delete(cacheKey);
    });

  // Store the promise in the cache
  pendingPredictionRequests.set(cacheKey, resultPromise);
  customLog("[LOG] Added new pending prediction request for", cacheKey);

  return resultPromise;
}

/**
 * Fetches a prediction from API or storage.
 * @param {string} threadId - The hex string representing the Gmail thread ID.
 * @param {boolean} forceRecompute - Whether to force a recompute of the prediction.
 * @param {HTMLElement} row - The row element from a Gmail row.
 * @returns {Promise<{ result: any, error: any }>} An object containing the prediction result (or null) and error (or null)
 */
async function fetchPrediction(threadId, forceRecompute = false, row = null) {
  let threadData;

  customLog(forceRecompute ? "[LOG] Forcing recomputation for thread" : "[LOG] Getting new prediction for thread", threadId);

  let lastMessageId;
  if (row) {
    threadData = getThreadIdFromRow(row);
    lastMessageId = threadData?.legacyLastNonDraftMessageId;
  } else {
    threadData = getThreadIdFromPage();
    lastMessageId = threadData?.legacyLastNonDraftMessageId;
  }

  const emailAddress = getUserEmail();

  if (!lastMessageId) {
    customLog("[LOG] No last message ID found for thread, using thread-based prediction API instead", threadId);
    const { result, error } = await predictAction(threadId, emailAddress, forceRecompute, true);

    if (result && !error) {
      customLog("Saving prediction for thread", threadId, "with response:", result);
      await predictionStore.savePrediction(threadId, "thread-based-prediction", result);
    }

    return { result, error };
  }

  // Use message-based prediction API when lastMessageId is available, it's faster as we skip the backend API lookup using the thread ID
  const { result, error } = await predictAction(lastMessageId, emailAddress, forceRecompute, false);
  if (result && !error) {
    customLog("Saving prediction for thread", threadId, "with response:", result);
    await predictionStore.savePrediction(threadId, lastMessageId, result);
  }

  return { result, error };
}

/**
 * Updates the row prediction button style based on the predicted action.
 * @param {HTMLButtonElement} button - The prediction button in the row.
 * @param {string} threadId - The hex string representing the Gmail thread ID.
 */
async function updateRowButtonStyle(button, threadId, row) {
  if (!row) {
    customLog("[ERROR] No row provided to updateRowButtonStyle", button, threadId, row);
    return;
  }

  const { result, error } = await getPredictionForThread(threadId, false, row);
  if (!result || error) {
    customLog("[ERROR] No result provided to updateRowButtonStyle for thread", threadId, "with error:", error);
    return;
  }

  if (!result.prediction) {
    customLog("[ERROR] No prediction provided to updateRowButtonStyle for thread", threadId, result);
    return;
  }

  const actions = result.prediction.types;
  const confidence = result.prediction.confidence;
  const action = result.prediction.types.length > 0 ? actions[0].toLowerCase() : "archive";

  // Apply base styles
  applyRowButtonBaseStyle(button);

  // Apply action-specific styles
  applyRowButtonActionStyle(button, action);

  // Apply interactive effects
  applyRowButtonInteractiveEffects(button);

  // Add tooltip with confidence
  if (confidence) {
    button.title = `${actions.join(", ")} (${Math.round(confidence * 100)}% confidence)`;
  }

  button.setAttribute("data-loading", "false");
}

/**
 * Creates and attaches a single prediction button to a Gmail row.
 * @param {HTMLElement} nameCell - The "name cell" (td.yX) element from a Gmail row.
 */
function addRowPredictButton(row) {
  if (!row) {
    customLog("[ERROR] No row provided to addRowPredictButton");
    return;
  }

  // Find the name cell (td with class yX)
  const nameCell = row.querySelector("td.yX");
  if (!nameCell || nameCell.getElementsByClassName("friday-predict-button").length > 0) {
    return;
  }

  const threadId = getThreadIdFromRow(row).legacyThreadId;

  if (!threadId) {
    customLog("[ERROR] No thread ID found for row:", row);
    return;
  }

  const rowPredictButton = document.createElement("button");
  rowPredictButton.className = "friday-predict-button";
  applyPredictionButtonStyle(rowPredictButton);
  rowPredictButton.setAttribute("data-loading", "true"); // Add loading state

  if (!row) {
    customLog("[ERROR] No row provided to addRowPredictButton");
  }
  // Here we set the predictions automatically on the main page
  updateRowButtonStyle(rowPredictButton, threadId, row);

  rowPredictButton.addEventListener("click", async event => {
    // Don't process clicks while loading
    if (rowPredictButton.getAttribute("data-loading") === "true") {
      customLog("rowPredictButton clicked while loading, skipping");
      return;
    }

    const { result, error } = await getPredictionForThread(threadId, false, row);
    if (!result || error) {
      customLog("[ERROR] No result provided to addRowPredictButton for thread", threadId, "with error:", error);
      return;
    }

    const actions = result.prediction.types;
    const action = actions.length > 0 ? actions[0].toLowerCase() : "archive";

    // Stop propagation immediately for archive actions
    if (action === "archive" || actions.length === 0) {
      event.stopPropagation();
      customLog("stopping propagation");
    }

    setTimeout(() => {
      switch (action) {
        case "archive":
          customLog("archiving email");
          archiveFromRowView(row);
          break;
        case "reply":
          const messageId = threadIds?.legacyLastNonDraftMessageId || threadIds?.legacyLastMessageId || null;
          replyToEmail(result.prediction.suggested_response, messageId);
          break;
        case "forward":
          forwardEmail(result.prediction.suggested_response);
          break;
        default:
          customLog("Unknown action type:", action);
          break;
      }
    }, 100);

    updateRowButtonStyle(rowPredictButton, threadId, row);
  });

  const nameContent = nameCell.querySelector(".afn");
  if (nameContent) {
    nameCell.insertBefore(rowPredictButton, nameContent);
  }
}

/**
 * Finds all email rows in the current inbox view and adds prediction buttons to each.
 */
function addPredictButtonToRows() {
  const emailRows = getEmailRows();

  emailRows.forEach(row => {
    addRowPredictButton(row);
  });
}

/**
 * Initialize Friday chat for Gemini replacement
 * @param {HTMLElement} chatContent - The chat content container
 * @param {string} emailAddress - User's email address
 */
function initializeFridayChat(chatContent, emailAddress) {
  // Check if we already have a chat instance for this container
  const containerKey = `${emailAddress}-${chatContent.tagName}`;
  let chatInstance = chatInstances.get(containerKey);

  if (!chatInstance) {
    if (window.FridayChat) {
      customLog("[FRIDAY] Creating new FridayChat instance");
      chatInstance = new window.FridayChat(chatContent, emailAddress);
    }

    // Store the chat instance
    chatInstances.set(containerKey, chatInstance);
    fridayChat = chatInstance; // Keep legacy reference
  } else {
    // If reusing an existing instance, make sure it's pointing to the current container and reload history if the container is empty
    if (chatInstance.chatContainer !== chatContent) {
      chatInstance.chatContainer = chatContent;
    }

    // If the container is empty but we have conversation history, reload the UI
    if (chatContent.children.length === 0 && chatInstance.conversationHistory.length > 0) {
      chatInstance.loadConversationHistory();
    }
  }

  return chatInstance;
}

function handleSend(fridayInput, geminiChatContainer) {
  const message = fridayInput.value.trim();
  if (message) {
    customLog("[FRIDAY] User message:", message);

    // Find the chat content area
    const chatContent = geminiChatContainer.querySelector('div[jsname="v2aOce"]');
    if (chatContent) {
      // Ensure the chat container has proper vertical layout and scrolling
      chatContent.style.display = "flex";
      chatContent.style.flexDirection = "column";
      chatContent.style.justifyContent = "flex-start"; // Align items to top
      chatContent.style.gap = "0";
      chatContent.style.overflowY = "auto"; // Enable vertical scrolling
      chatContent.style.maxHeight = "100%"; // Respect parent height constraints
      chatContent.style.height = "100%"; // Take full available height

      // Clear Gemini suggestions on first message
      if (!chatContent.querySelector(".friday-chat-bubble")) {
        chatContent.innerHTML = "";
      }

      // Get user email and initialize/use Friday chat
      const emailAddress = getUserEmail();
      if (emailAddress) {
        const chat = initializeFridayChat(chatContent, emailAddress);
        chat.sendMessage(message);
      } else {
        customLog("[ERROR] No email address found for Friday chat");
      }
    }

    fridayInput.value = "";
  }
}

async function initializeGeminiChat() {
  // Find the main Gemini chat container
  const geminiChatContainer = document.querySelector('div[jsname="y8x7oe"].ccYpFf');
  if (!geminiChatContainer) {
    return;
  }

  // Get the chat content area where Friday chat will be initialized
  const chatContent = geminiChatContainer.querySelector('div[jsname="v2aOce"]');
  const emailAddress = getUserEmail();

  // First modify the header and footer
  modifyGeminiChatHeader(geminiChatContainer);
  modifyGeminiChatFooter(geminiChatContainer, handleSend);

  // Clear Gemini content
  modifyGeminiChat(geminiChatContainer);

  // Setup proper styling for the chat content area
  if (chatContent) {
    chatContent.style.display = "flex";
    chatContent.style.flexDirection = "column";
    chatContent.style.justifyContent = "flex-start";
    chatContent.style.gap = "0";
    chatContent.style.overflowY = "auto";
    chatContent.style.maxHeight = "100%";
    chatContent.style.height = "100%";
  }

  // Now initialize Friday chat and load history
  let fridayChatInstance = null;
  if (emailAddress && chatContent) {
    fridayChatInstance = initializeFridayChat(chatContent, emailAddress);

    // Update header with the Friday chat instance for the clear button
    modifyGeminiChatHeader(geminiChatContainer, fridayChatInstance);
  }
}

export async function submitPrompt() {
  customLog("Prompt box enter key pressed");
  const prompt = getPromptFromBox();
  const messageBody = getMessageBody();

  if (prompt) {
    customLog("Prompt submitted:", prompt);
    customLog("Message body:", messageBody);

    // Emit event to indicate processing has started
    document.dispatchEvent(new CustomEvent("friday-draft-processing", { detail: { status: "start" } }));

    try {
      const emailAddress = getUserEmail();
      const threadData = getThreadIdFromPage();
      if (threadData && emailAddress) {
        customLog("getting draft");
        const draft = await getDraft(threadData.legacyLastNonDraftMessageId, emailAddress, prompt, messageBody);
        customLog("Draft for message", threadData.legacyLastNonDraftMessageId, ":", draft);
        // clearPromptBox();
        removeOriginalDraft();
        inputReply(draft.suggestedResponse);
        document.dispatchEvent(new CustomEvent("friday-draft-processing", { detail: { status: "complete" } }));
      } else {
        document.dispatchEvent(
          new CustomEvent("friday-draft-processing", {
            detail: { status: "error", error: "No thread data or email address found" },
          })
        );
      }
    } catch (error) {
      customLog("Error submitting prompt:", error);
      // Emit event to indicate processing failed
      document.dispatchEvent(new CustomEvent("friday-draft-processing", { detail: { status: "error", error } }));
    }
  } else {
    customLog("No prompt in box");
  }
}

/**
 * Handles the "Predict Action" button click in the top-level UI,
 * fetches predictions for the currently open email thread,
 * and displays dynamic buttons based on the predicted actions.
 *
 * @param {HTMLElement} predictionText - The text element for displaying the predicted action.
 * @param {HTMLElement} reasoningText - The text element for displaying the AI reasoning.
 * @param {HTMLElement} actionContainer - The container to hold dynamic action buttons (archive, reply, forward).
 */
async function onPredictButtonClick(predictionText, reasoningText, actionContainer, forceRecompute = false, prediction = null) {
  predictionText.textContent = "Getting email prediction...";
  reasoningText.style.display = "none";

  // Clear existing action buttons
  actionContainer.innerHTML = "";

  try {
    const threadId = getThreadIdFromPage().legacyThreadId;
    if (!threadId) {
      customLog("No thread ID found on page");
      return;
    }

    let response;
    if (prediction) response = prediction;
    else {
      const { result, error } = await getPredictionForThread(threadId, forceRecompute, null);
      if (!result || error) {
        customLog("[ERROR] No result provided to onPredictButtonClick for thread", threadId, "with error:", error);
        return;
      }
      response = result;
    }

    const currentThreadId = getThreadIdFromPage()?.legacyThreadId;
    if (currentThreadId !== threadId) return; // Only proceed if we're still on the same thread

    predictionText.textContent = `Predicted action: ${
      response.prediction.types.length > 0 ? response.prediction.types.join(", ") : "ARCHIVE"
    }`;
    reasoningText.textContent = "Reasoning (" + response.prediction.confidence * 100 + "%): " + response.prediction.reasoning;
    reasoningText.style.display = "block";

    // Remove any existing keyboard listener
    if (window.currentKeydownListener) {
      document.removeEventListener("keydown", window.currentKeydownListener);
    }

    // Create new keyboard listener for this email for the keyboard shortcut
    window.currentKeydownListener = async e => {
      if (e.target.classList.contains("friday-prompt-box") && e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submitPrompt(); // Prompt box validation is handled in submitPrompt()
      }
      if (!e.repeat && !e.target.matches("input, textarea, [contenteditable]")) {
        if (e.key === "Enter") {
          const currentThreadId = getThreadIdFromPage()?.legacyThreadId;
          if (currentThreadId !== threadId) return;

          const action = response.prediction.types.length === 0 ? "archive" : response.prediction.types[0].toLowerCase();
          e.preventDefault();
          //customLog("Enter key pressed, executing action:", action);

          // Remove the first action type from the prediction
          const updatedTypes = await predictionStore.removeFirstActionType(threadId);
          response.prediction.types = updatedTypes;

          // Update UI with new prediction types
          predictionText.textContent = `Predicted action: ${updatedTypes.length > 0 ? updatedTypes.join(", ") : "ARCHIVE"}`;

          // Execute the action
          switch (action) {
            case "reply":
              //customLog("Replying to email after enter press");
              const enterMessageId = response.messageId || response.threadId || null;
              await replyToEmail(response.prediction.suggested_response, enterMessageId);
              onPredictButtonClick(predictionText, reasoningText, actionContainer, false, response);
              break;
            case "archive":
              //customLog("Archiving email after enter press");
              archiveEmail();
              await predictionStore.removePrediction(threadId);
              break;
          }
        } else if (e.key === "Tab") {
          const currentThreadId = getThreadIdFromPage()?.legacyThreadId;
          if (currentThreadId !== threadId) return;

          //customLog("Tab key pressed");
          e.preventDefault();

          const currentAction = response.prediction.types[0];
          const updatedTypes = await predictionStore.switchActionType(threadId, currentAction === "REPLY" ? "ARCHIVE" : "REPLY");
          response.prediction.types = updatedTypes;
          predictionText.textContent = `Predicted action: ${updatedTypes.length > 0 ? updatedTypes.join(", ") : "ARCHIVE"}`;
          onPredictButtonClick(predictionText, reasoningText, actionContainer, false, response);
        } else if (e.key === "u" && (e.metaKey || e.ctrlKey)) {
          const currentThreadId = getThreadIdFromPage()?.legacyThreadId;
          if (currentThreadId !== threadId) return;

          e.preventDefault();
          //customLog("Command+U pressed, executing unsubscribe action");

          unsubscribe();
          await predictionStore.removePrediction(threadId);
        }
      }
    };

    // Add the new keyboard listener
    document.addEventListener("keydown", window.currentKeydownListener);

    // Define all available actions regardless of prediction
    const candidateActions = ["archive", "reply"];

    const unsubscribeButton = getUnsubscribeButton();
    const unsubscribeLink = findUnsubscribeLink();
    if (unsubscribeButton || unsubscribeLink) {
      candidateActions.push("unsubscribe");
    }

    candidateActions.forEach(action => {
      const actionButton = createActionButton(action[0].toUpperCase() + action.slice(1));

      // Highlight the predicted action (if any)
      if (
        (response.prediction.types.length === 0 && action === "archive") ||
        response.prediction.types.map(a => a.toLowerCase()).includes(action)
      ) {
        // Primary action (first in the queue) gets solid border
        if ((response.prediction.types.length === 0 && action === "archive") || response.prediction.types[0].toLowerCase() === action) {
          applyPrimaryActionStyle(actionButton);
        }
        // Secondary actions (later in the queue) get dotted borders
        else {
          applySecondaryActionStyle(actionButton);
        }
      } else {
        actionButton.style.border = "1px solid #ccc";
      }

      // Add command+U shortcut indicator for unsubscribe button
      if (action === "unsubscribe") {
        const shortcutContainer = document.createElement("div");
        shortcutContainer.style.display = "flex";
        shortcutContainer.style.alignItems = "center";

        const metaKeyIndicator = createShortcutIndicator(window.navigator.userAgent.includes("Mac") ? "⌘" : "Ctrl");
        const uKeyIndicator = createShortcutIndicator("U");

        shortcutContainer.appendChild(metaKeyIndicator);
        shortcutContainer.appendChild(uKeyIndicator);
        shortcutContainer.style.marginLeft = "8px";
        shortcutContainer.style.gap = "2px";

        actionButton.appendChild(shortcutContainer);
      }

      // Set up action button event listener to override the suggestion
      actionButton.addEventListener("click", async () => {
        const updatedTypes = await predictionStore.removeFirstActionType(threadId);
        response.prediction.types = updatedTypes;

        predictionText.textContent = `Predicted action: ${updatedTypes.length > 0 ? updatedTypes.join(", ") : "ARCHIVE"}`;
        switch (action) {
          case "archive":
            archiveEmail();
            break;
          case "reply":
            const clickMessageId = response.messageId || response.threadId || null;
            await replyToEmail(response.prediction.suggested_response, clickMessageId);
            onPredictButtonClick(predictionText, reasoningText, actionContainer, false, response);
            break;
          case "unsubscribe":
            if (unsubscribeButton) {
              unsubscribeButton.click();
            } else if (unsubscribeLink) {
              unsubscribeLink.click();
            }
            break;
          default:
            customLog("[ERROR] Unknown action:", action);
        }
      });

      actionContainer.appendChild(actionButton);
    });
  } catch (error) {
    customLog("Error:", error);
  }
}

/**
 * Sets up the MutationObserver to detect changes (e.g., new rows in the inbox)
 * and attach the row-level prediction buttons. Also handles UI insertion in the header area.
 * image.png
 * @param {HTMLElement} mainContainer - The main container for the top-level extension UI.
 */
function setupMutationObserver(mainContainer, predictionText, reasoningText, actionContainer) {
  customLog("mutationObserver active");
  const observer = new MutationObserver(mutations => {
    // Handle header section within the email view
    if (isInInbox() || isInLabels()) {
      let activeInbox;
      if (isInListView()) {
        activeInbox = document.querySelector('div.bGI.nH.oy8Mbf[role="main"]');
        if (!activeInbox) {
          customLog("[ERROR] Could not find active inbox for email view");
          return [];
        }
      } else {
        activeInbox = document;
      }

      const headerSection = activeInbox.querySelector(".V8djrc.byY");
      if (headerSection) {
        if (!headerSection.nextElementSibling?.classList?.contains("friday-extension-container")) {
          headerSection.insertAdjacentElement("afterend", mainContainer);
          onPredictButtonClick(predictionText, reasoningText, actionContainer);
        }
      }

      if (replyBoxIsOpen() && !document.querySelector(".friday-test-row")) {
        addPromptBox();
        const email = getUserEmail();
        // customLog(addTrackingPixel(email));
      }
    }

    if (isInListView()) {
      mutations.forEach(mutation => {
        // Handle direct changes to email rows
        if (mutation.target.classList?.contains("zA")) {
          let row = mutation.target.querySelector("td.yX");
          if (!row) {
            customLog("[ERROR] No row found for mutation target for direct changes to email rows:", mutation.target);
          }
          addRowPredictButton(row);
        }

        // Handle changes to the name cell directly
        else if (mutation.target.classList?.contains("yX")) {
          let row = mutation.target;
          if (!row) {
            customLog("[ERROR] No row found for mutation target for changes to name cell:", mutation.target);
          }
          addRowPredictButton(row);
        }

        // Handle newly added email rows
        else {
          mutation.addedNodes.forEach(node => {
            if (node.classList?.contains("zA")) {
              let row = node.querySelector("td.yX");
              if (!row) {
                customLog("[ERROR] No row found for mutation target for newly added email rows:", node);
              }
              addRowPredictButton(row);
            }
          });
        }
      });

      addPredictButtonToRows();
    }

    if (CHAT_MODE && isGeminiButtonVisible()) {
      addFridayChatButton();
    }

    if (CHAT_MODE && isGeminiChatOpen()) {
      initializeGeminiChat();
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

/**
 * Main entry point for the Chrome extension content script.
 * 1. Creates the top-level UI (predict button, action container, etc.).
 * 2. Attaches the event listener for the predict button.
 * 3. Initializes the mutation observer for dynamic changes.
 */
export async function main() {
  customLog("[LOG] Starting extension");

  // Initialize Supabase Sign-in
  try {
    customLog("[LOG] Getting email address...");
    //TODO: why do we need to get the email address?

    let emailAddress = getUserEmail();

    for (let retryCount = 0; !emailAddress && retryCount < 1000; retryCount++) {
      customLog("[LOG] No email address found, waiting to retry...");
      await new Promise(resolve => setTimeout(resolve, 1000));
      emailAddress = getUserEmail();
    }

    if (!emailAddress) {
      customLog("[ERROR] Failed to get email address after multiple attempts");
      return;
    }

    customLog("[LOG] Found email address:", emailAddress);
    customLog("[LOG] Starting auth process");
    const response = await chrome.runtime.sendMessage({ action: "supabaseAuth" });

    if (!response.success) {
      customLog("[ERROR] Failed to initialize Supabase Sign-in:", response.error);
      customLog(response.error.message);
      throw new Error(response.error.message);
    }

    customLog("[LOG] Supabase Sign-in initialized (see background worker for logs)");
    await chrome.storage.local.remove("friday_auth_error");
    // Tell the popup to refresh the auth status
    chrome.runtime.sendMessage({ action: "refresh" });
  } catch (error) {
    customLog("[ERROR] Failed to initialize Supabase Sign-in (see background worker for logs):", error.message);
    await chrome.storage.local.set({ friday_auth_error: error.message });
    // Tell the popup to refresh the auth status
    chrome.runtime.sendMessage({ action: "refresh" });

    return;
  }

  // Wait for store to load before proceeding
  await predictionStore.ready();

  // Create extension UI
  const { mainContainer, predictButton, predictionText, reasoningText, actionContainer } = createButtons(DEBUG_MODE);

  // 2. Set up event listener for the Predict button
  predictButton.addEventListener("click", () => onPredictButtonClick(predictionText, reasoningText, actionContainer, true));

  // Add event listener for the custom send message event
  document.addEventListener("friday-send-message", () => {
    submitPrompt();
  });

  // 3. Setup the mutation observer to dynamically add row-level buttons
  setupMutationObserver(mainContainer, predictionText, reasoningText, actionContainer);

  if (isInListView()) {
    addPredictButtonToRows();
  }

  // Initialize Gemini replacement if available (only if chat mode is enabled)
  if (CHAT_MODE && isGeminiButtonVisible()) {
    addFridayChatButton();
  }

  // Initialize Gemini chat replacement if open (only if chat mode is enabled)
  if (CHAT_MODE && isGeminiChatOpen()) {
    initializeGeminiChat();
  }
}
