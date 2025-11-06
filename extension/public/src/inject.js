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
const AI_API_HOST = window.__FRIDAY_AI_API_HOST || 'https://your-ai-endpoint.example.com';

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

// async function getPredictionForThread(threadId, forceRecompute = false, row = null) {
//     if (forceRecompute) {
//         customLog("[LOG] Forcing recomputation for thread", threadId);
//         return fetchPrediction(threadId, forceRecompute, row);
//     }

//     let threadData = row ? (typeof getThreadIdFromRow === 'function' ? getThreadIdFromRow(row) : null) : (typeof getThreadIdFromPage === 'function' ? getThreadIdFromPage() : null);
//     let lastMessageId = threadData?.legacyLastNonDraftMessageId;

//     if (!threadData) {
//         customLog("[LOG] No thread data found for thread", threadId);

//         if (predictionStore.hasPrediction(threadId)) {
//             const storedPrediction = predictionStore.getPrediction(threadId);
//             return { result: storedPrediction.prediction, error: null };
//         }

//         customLog("[LOG] No prediction found for thread", threadId);
//     } else {
//         if (predictionStore.hasCurrentPrediction(threadId, lastMessageId)) {
//             const storedPrediction = predictionStore.getPrediction(threadId);
//             return { result: storedPrediction.prediction, error: null };
//         }

//         customLog("[LOG] No current prediction found for thread", threadId, "with the last message ID:", lastMessageId);
//         if (!lastMessageId) {
//             customLog("[ERROR] No current last message ID found for thread", threadId, "thread data:", threadData);
//         }
//     }

//     const cacheKey = threadId;

//     if (pendingPredictionRequests.has(cacheKey)) {
//         customLog("[LOG] Returning pending prediction request for", cacheKey);
//         return pendingPredictionRequests.get(cacheKey);
//     }

//     customLog("[LOG] Creating new prediction request for", cacheKey);

//     const predictionPromise = fetchPrediction(threadId, forceRecompute, row);

//     const timeoutPromise = new Promise((_, reject) => {
//         setTimeout(() => {
//             reject(new Error(`Prediction request for ${cacheKey} timed out after ${PREDICTION_REQUEST_TIMEOUT}ms`));
//         }, PREDICTION_REQUEST_TIMEOUT);
//     });

//     const resultPromise = Promise.race([predictionPromise, timeoutPromise])
//         .then(result => {
//             customLog("[LOG] Prediction request completed first for", cacheKey);
//             return result;
//         })
//         .catch(error => {
//             if (error.message && error.message.includes("timed out")) customLog("[LOG] Timeout occurred first for", cacheKey, ":", error.message);
//             else customLog("[ERROR] Prediction request failed for", cacheKey, ":", error);
//             throw error;
//         })
//         .finally(() => {
//             customLog("[LOG] Clearing pending prediction request for", cacheKey);
//             pendingPredictionRequests.delete(cacheKey);
//         });

//     pendingPredictionRequests.set(cacheKey, resultPromise);
//     customLog("[LOG] Added new pending prediction request for", cacheKey);

//     return resultPromise;
// }

// async function fetchPrediction(threadId, forceRecompute = false, row = null) {
//     let threadData;

//     customLog(forceRecompute ? "[LOG] Forcing recomputation for thread" : "[LOG] Getting new prediction for thread", threadId);

//     let lastMessageId;
//     if (row) {
//         threadData = (typeof getThreadIdFromRow === 'function') ? getThreadIdFromRow(row) : null;
//         lastMessageId = threadData?.legacyLastNonDraftMessageId;
//     } else {
//         threadData = (typeof getThreadIdFromPage === 'function') ? getThreadIdFromPage() : null;
//         lastMessageId = threadData?.legacyLastNonDraftMessageId;
//     }

//     const emailAddress = (typeof getUserEmail === 'function') ? getUserEmail() : null;

//     if (!lastMessageId) {
//         customLog("[LOG] No last message ID found for thread, using thread-based prediction API instead", threadId);
//         const { result, error } = (typeof predictAction === 'function') ? await predictAction(threadId, emailAddress, forceRecompute, true) : { result: null, error: 'predictAction not available' };

//         if (result && !error) {
//             customLog("Saving prediction for thread", threadId, "with response:", result);
//             await predictionStore.savePrediction(threadId, "thread-based-prediction", result);
//         }

//         return { result, error };
//     }

//     const { result, error } = (typeof predictAction === 'function') ? await predictAction(lastMessageId, emailAddress, forceRecompute, false) : { result: null, error: 'predictAction not available' };
//     if (result && !error) {
//         customLog("Saving prediction for thread", threadId, "with response:", result);
//         await predictionStore.savePrediction(threadId, lastMessageId, result);
//     }

//     return { result, error };
// }

// async function updateRowButtonStyle(button, threadId, row) {
//     if (!row) {
//         customLog("[ERROR] No row provided to updateRowButtonStyle", button, threadId, row);
//         return;
//     }

//     const { result, error } = await getPredictionForThread(threadId, false, row);
//     if (!result || error) {
//         customLog("[ERROR] No result provided to updateRowButtonStyle for thread", threadId, "with error:", error);
//         return;
//     }

//     if (!result.prediction) {
//         customLog("[ERROR] No prediction provided to updateRowButtonStyle for thread", threadId, result);
//         return;
//     }

//     const actions = result.prediction.types;
//     const confidence = result.prediction.confidence;
//     const action = result.prediction.types.length > 0 ? actions[0].toLowerCase() : "archive";

//     if (typeof applyRowButtonBaseStyle === 'function') applyRowButtonBaseStyle(button);
//     if (typeof applyRowButtonActionStyle === 'function') applyRowButtonActionStyle(button, action);
//     if (typeof applyRowButtonInteractiveEffects === 'function') applyRowButtonInteractiveEffects(button);

//     if (confidence) {
//         button.title = `${actions.join(", ")} (${Math.round(confidence * 100)}% confidence)`;
//     }

//     button.setAttribute("data-loading", "false");
// }

// function addRowPredictButton(row) {
//     if (!row) {
//         customLog("[ERROR] No row provided to addRowPredictButton");
//         return;
//     }

//     const nameCell = row.querySelector("td.yX");
//     if (!nameCell || nameCell.getElementsByClassName("friday-predict-button").length > 0) {
//         return;
//     }

//     const threadId = (typeof getThreadIdFromRow === 'function') ? getThreadIdFromRow(row).legacyThreadId : null;

//     if (!threadId) {
//         customLog("[ERROR] No thread ID found for row:", row);
//         return;
//     }

//     const rowPredictButton = document.createElement("button");
//     rowPredictButton.className = "friday-predict-button";
//     if (typeof applyPredictionButtonStyle === 'function') applyPredictionButtonStyle(rowPredictButton);
//     rowPredictButton.setAttribute("data-loading", "true");

//     updateRowButtonStyle(rowPredictButton, threadId, row);

//     rowPredictButton.addEventListener("click", async event => {
//         if (rowPredictButton.getAttribute("data-loading") === "true") {
//             customLog("rowPredictButton clicked while loading, skipping");
//             return;
//         }

//         const { result, error } = await getPredictionForThread(threadId, false, row);
//         if (!result || error) {
//             customLog("[ERROR] No result provided to addRowPredictButton for thread", threadId, "with error:", error);
//             return;
//         }

//         const actions = result.prediction.types;
//         const action = actions.length > 0 ? actions[0].toLowerCase() : "archive";

//         if (action === "archive" || actions.length === 0) {
//             event.stopPropagation();
//             customLog("stopping propagation");
//         }

//         setTimeout(() => {
//             switch (action) {
//                 case "archive":
//                     customLog("archiving email");
//                     if (typeof archiveFromRowView === 'function') archiveFromRowView(row);
//                     break;
//                 case "reply":
//                     const messageId = null;
//                     if (typeof replyToEmail === 'function') replyToEmail(result.prediction.suggested_response, messageId);
//                     break;
//                 case "forward":
//                     if (typeof forwardEmail === 'function') forwardEmail(result.prediction.suggested_response);
//                     break;
//                 default:
//                     customLog("Unknown action type:", action);
//                     break;
//             }
//         }, 100);

//         updateRowButtonStyle(rowPredictButton, threadId, row);
//     });

//     const nameContent = nameCell.querySelector(".afn");
//     if (nameContent) {
//         nameCell.insertBefore(rowPredictButton, nameContent);
//     }
// }

// function addPredictButtonToRows() {
//     const emailRows = (typeof getEmailRows === 'function') ? getEmailRows() : [];
//     emailRows.forEach(row => addRowPredictButton(row));
// }

// function initializeFridayChat(chatContent, emailAddress) {
//     const containerKey = `${emailAddress}-${chatContent.tagName}`;
//     let chatInstance = chatInstances.get(containerKey);

//     if (!chatInstance) {
//         if (window.FridayChat) {
//             customLog("[FRIDAY] Creating new FridayChat instance");
//             chatInstance = new window.FridayChat(chatContent, emailAddress);
//         }

//         chatInstances.set(containerKey, chatInstance);
//         fridayChat = chatInstance;
//     } else {
//         if (chatInstance.chatContainer !== chatContent) chatInstance.chatContainer = chatContent;
//         if (chatContent.children.length === 0 && chatInstance.conversationHistory && chatInstance.conversationHistory.length > 0) {
//             chatInstance.loadConversationHistory();
//         }
//     }

//     return chatInstance;
// }

// function handleSend(fridayInput, geminiChatContainer) {
//     const message = fridayInput.value.trim();
//     if (!message) return;
//     customLog("[FRIDAY] User message:", message);

//     const chatContent = geminiChatContainer.querySelector('div[jsname="v2aOce"]');
//     if (chatContent) {
//         chatContent.style.display = "flex";
//         chatContent.style.flexDirection = "column";
//         chatContent.style.justifyContent = "flex-start";
//         chatContent.style.gap = "0";
//         chatContent.style.overflowY = "auto";
//         chatContent.style.maxHeight = "100%";
//         chatContent.style.height = "100%";

//         if (!chatContent.querySelector(".friday-chat-bubble")) chatContent.innerHTML = "";

//         const emailAddress = (typeof getUserEmail === 'function') ? getUserEmail() : null;
//         if (emailAddress) {
//             const chat = initializeFridayChat(chatContent, emailAddress);
//             if (chat && typeof chat.sendMessage === 'function') chat.sendMessage(message);
//         } else {
//             customLog("[ERROR] No email address found for Friday chat");
//         }
//     }

//     fridayInput.value = "";
// }

// async function initializeGeminiChat() {
//     // Use the specific selector first, then fallback
//     const geminiChatContainer = document.querySelector('div.xFhX5c[jscontroller="TZv7Re"]') || document.querySelector('div[jsname="y8x7oe"].ccYpFf');
//     if (!geminiChatContainer) return;

//     const chatContent = geminiChatContainer.querySelector('div[jsname="v2aOce"]');
//     const emailAddress = (typeof getUserEmail === 'function') ? getUserEmail() : null;

//     if (typeof modifyGeminiChatHeader === 'function') modifyGeminiChatHeader(geminiChatContainer);
//     if (typeof modifyGeminiChatFooter === 'function') modifyGeminiChatFooter(geminiChatContainer, handleSend);
//     if (typeof modifyGeminiChat === 'function') modifyGeminiChat(geminiChatContainer);

//     if (chatContent) {
//         chatContent.style.display = "flex";
//         chatContent.style.flexDirection = "column";
//         chatContent.style.justifyContent = "flex-start";
//         chatContent.style.gap = "0";
//         chatContent.style.overflowY = "auto";
//         chatContent.style.maxHeight = "100%";
//         chatContent.style.height = "100%";
//     }

//     let fridayChatInstance = null;
//     if (emailAddress && chatContent) {
//         fridayChatInstance = initializeFridayChat(chatContent, emailAddress);
//         if (typeof modifyGeminiChatHeader === 'function') modifyGeminiChatHeader(geminiChatContainer, fridayChatInstance);
//     }
// }

// async function submitPrompt() {
//     customLog("Prompt box enter key pressed");
//     const prompt = (typeof getPromptFromBox === 'function') ? getPromptFromBox() : null;
//     const messageBody = (typeof getMessageBody === 'function') ? getMessageBody() : null;

//     if (!prompt) { customLog("No prompt in box"); return; }

//     document.dispatchEvent(new CustomEvent("friday-draft-processing", { detail: { status: "start" } }));

//     try {
//         const emailAddress = (typeof getUserEmail === 'function') ? getUserEmail() : null;
//         const threadData = (typeof getThreadIdFromPage === 'function') ? getThreadIdFromPage() : null;
//         if (threadData && emailAddress) {
//             customLog("getting draft");
//             const draft = (typeof getDraft === 'function') ? await getDraft(threadData.legacyLastNonDraftMessageId, emailAddress, prompt, messageBody) : { suggestedResponse: '' };
//             customLog("Draft for message", threadData.legacyLastNonDraftMessageId, ":", draft);
//             if (typeof removeOriginalDraft === 'function') removeOriginalDraft();
//             if (typeof inputReply === 'function') inputReply(draft.suggestedResponse);
//             document.dispatchEvent(new CustomEvent("friday-draft-processing", { detail: { status: "complete" } }));
//         } else {
//             document.dispatchEvent(new CustomEvent("friday-draft-processing", { detail: { status: "error", error: "No thread data or email address found" } }));
//         }
//     } catch (error) {
//         customLog("Error submitting prompt:", error);
//         document.dispatchEvent(new CustomEvent("friday-draft-processing", { detail: { status: "error", error } }));
//     }
// }

// async function onPredictButtonClick(predictionText, reasoningText, actionContainer, forceRecompute = false, prediction = null) {
//     predictionText.textContent = "Getting email prediction...";
//     reasoningText.style.display = "none";
//     actionContainer.innerHTML = "";

//     try {
//         const threadId = (typeof getThreadIdFromPage === 'function') ? getThreadIdFromPage().legacyThreadId : null;
//         if (!threadId) { customLog("No thread ID found on page"); return; }

//         let response;
//         if (prediction) response = prediction;
//         else {
//             const { result, error } = await getPredictionForThread(threadId, forceRecompute, null);
//             if (!result || error) { customLog("[ERROR] No result provided to onPredictButtonClick for thread", threadId, "with error:", error); return; }
//             response = result;
//         }

//         const currentThreadId = (typeof getThreadIdFromPage === 'function') ? getThreadIdFromPage()?.legacyThreadId : null;
//         if (currentThreadId !== threadId) return;

//         predictionText.textContent = `Predicted action: ${response.prediction.types.length > 0 ? response.prediction.types.join(", ") : "ARCHIVE"}`;
//         reasoningText.textContent = "Reasoning (" + response.prediction.confidence * 100 + "%): " + response.prediction.reasoning;
//         reasoningText.style.display = "block";

//         if (window.currentKeydownListener) document.removeEventListener("keydown", window.currentKeydownListener);

//         window.currentKeydownListener = async e => {
//             if (e.target.classList && e.target.classList.contains && e.target.classList.contains("friday-prompt-box") && e.key === "Enter" && !e.shiftKey) {
//                 e.preventDefault(); submitPrompt();
//             }
//             if (!e.repeat && !e.target.matches("input, textarea, [contenteditable]")) {
//                 if (e.key === "Enter") {
//                     const currentThreadId = (typeof getThreadIdFromPage === 'function') ? getThreadIdFromPage()?.legacyThreadId : null;
//                     if (currentThreadId !== threadId) return;

//                     const action = response.prediction.types.length === 0 ? "archive" : response.prediction.types[0].toLowerCase();
//                     e.preventDefault();

//                     const updatedTypes = await predictionStore.removeFirstActionType(threadId);
//                     response.prediction.types = updatedTypes;
//                     predictionText.textContent = `Predicted action: ${updatedTypes.length > 0 ? updatedTypes.join(", ") : "ARCHIVE"}`;

//                     switch (action) {
//                         case "reply":
//                             const enterMessageId = response.messageId || response.threadId || null;
//                             if (typeof replyToEmail === 'function') await replyToEmail(response.prediction.suggested_response, enterMessageId);
//                             onPredictButtonClick(predictionText, reasoningText, actionContainer, false, response);
//                             break;
//                         case "archive":
//                             if (typeof archiveEmail === 'function') archiveEmail();
//                             await predictionStore.removePrediction(threadId);
//                             break;
//                     }
//                 } else if (e.key === "Tab") {
//                     const currentThreadId = (typeof getThreadIdFromPage === 'function') ? getThreadIdFromPage()?.legacyThreadId : null;
//                     if (currentThreadId !== threadId) return;
//                     e.preventDefault();

//                     const currentAction = response.prediction.types[0];
//                     const updatedTypes = await predictionStore.switchActionType(threadId, currentAction === "REPLY" ? "ARCHIVE" : "REPLY");
//                     response.prediction.types = updatedTypes;
//                     predictionText.textContent = `Predicted action: ${updatedTypes.length > 0 ? updatedTypes.join(", ") : "ARCHIVE"}`;
//                     onPredictButtonClick(predictionText, reasoningText, actionContainer, false, response);
//                 } else if (e.key === "u" && (e.metaKey || e.ctrlKey)) {
//                     const currentThreadId = (typeof getThreadIdFromPage === 'function') ? getThreadIdFromPage()?.legacyThreadId : null;
//                     if (currentThreadId !== threadId) return;
//                     e.preventDefault();
//                     if (typeof unsubscribe === 'function') unsubscribe();
//                     await predictionStore.removePrediction(threadId);
//                 }
//             }
//         };

//         document.addEventListener("keydown", window.currentKeydownListener);

//         const candidateActions = ["archive", "reply"];
//         const unsubscribeButton = (typeof getUnsubscribeButton === 'function') ? getUnsubscribeButton() : null;
//         const unsubscribeLink = (typeof findUnsubscribeLink === 'function') ? findUnsubscribeLink() : null;
//         if (unsubscribeButton || unsubscribeLink) candidateActions.push("unsubscribe");

//         candidateActions.forEach(action => {
//             const actionButton = (typeof createActionButton === 'function') ? createActionButton(action[0].toUpperCase() + action.slice(1)) : document.createElement('button');

//             if ((response.prediction.types.length === 0 && action === "archive") || response.prediction.types.map(a => a.toLowerCase()).includes(action)) {
//                 if ((response.prediction.types.length === 0 && action === "archive") || response.prediction.types[0].toLowerCase() === action) {
//                     if (typeof applyPrimaryActionStyle === 'function') applyPrimaryActionStyle(actionButton);
//                 } else {
//                     if (typeof applySecondaryActionStyle === 'function') applySecondaryActionStyle(actionButton);
//                 }
//             } else {
//                 actionButton.style.border = "1px solid #ccc";
//             }

//             if (action === "unsubscribe") {
//                 const shortcutContainer = document.createElement("div");
//                 shortcutContainer.style.display = "flex";
//                 shortcutContainer.style.alignItems = "center";
//                 const metaKeyIndicator = (typeof createShortcutIndicator === 'function') ? createShortcutIndicator(window.navigator.userAgent.includes("Mac") ? "⌘" : "Ctrl") : document.createElement('span');
//                 const uKeyIndicator = (typeof createShortcutIndicator === 'function') ? createShortcutIndicator("U") : document.createElement('span');
//                 shortcutContainer.appendChild(metaKeyIndicator);
//                 shortcutContainer.appendChild(uKeyIndicator);
//                 shortcutContainer.style.marginLeft = "8px";
//                 shortcutContainer.style.gap = "2px";
//                 actionButton.appendChild(shortcutContainer);
//             }

//             actionButton.addEventListener("click", async () => {
//                 const updatedTypes = await predictionStore.removeFirstActionType(threadId);
//                 response.prediction.types = updatedTypes;
//                 predictionText.textContent = `Predicted action: ${updatedTypes.length > 0 ? updatedTypes.join(", ") : "ARCHIVE"}`;
//                 switch (action) {
//                     case "archive":
//                         if (typeof archiveEmail === 'function') archiveEmail();
//                         break;
//                     case "reply":
//                         const clickMessageId = response.messageId || response.threadId || null;
//                         if (typeof replyToEmail === 'function') await replyToEmail(response.prediction.suggested_response, clickMessageId);
//                         onPredictButtonClick(predictionText, reasoningText, actionContainer, false, response);
//                         break;
//                     case "unsubscribe":
//                         if (unsubscribeButton) unsubscribeButton.click();
//                         else if (unsubscribeLink) unsubscribeLink.click();
//                         break;
//                     default:
//                         customLog("[ERROR] Unknown action:", action);
//                 }
//             });

//             actionContainer.appendChild(actionButton);
//         });
//     } catch (error) {
//         customLog("Error:", error);
//     }
// }

// function setupMutationObserver(mainContainer, predictionText, reasoningText, actionContainer) {
//     customLog("mutationObserver active");
//     const observer = new MutationObserver(mutations => {
//         try {
//             if ((typeof isInInbox === 'function' && isInInbox()) || (typeof isInLabels === 'function' && isInLabels())) {
//                 let activeInbox;
//                 if (typeof isInListView === 'function' && isInListView()) {
//                     activeInbox = document.querySelector('div.bGI.nH.oy8Mbf[role="main"]');
//                     if (!activeInbox) { customLog("[ERROR] Could not find active inbox for email view"); return []; }
//                 } else {
//                     activeInbox = document;
//                 }

//                 const headerSection = activeInbox.querySelector('.V8djrc.byY');
//                 if (headerSection) {
//                     if (!headerSection.nextElementSibling?.classList?.contains('friday-extension-container')) {
//                         headerSection.insertAdjacentElement('afterend', mainContainer);
//                         onPredictButtonClick(predictionText, reasoningText, actionContainer);
//                     }
//                 }

//                 if (typeof replyBoxIsOpen === 'function' && replyBoxIsOpen() && !document.querySelector('.friday-test-row')) {
//                     if (typeof addPromptBox === 'function') addPromptBox();
//                 }
//             }

//             if (typeof isInListView === 'function' && isInListView()) {
//                 mutations.forEach(mutation => {
//                     if (mutation.target.classList?.contains('zA')) {
//                         let row = mutation.target.querySelector('td.yX');
//                         if (!row) customLog('[ERROR] No row found for mutation target for direct changes to email rows:', mutation.target);
//                         addRowPredictButton(row);
//                     } else if (mutation.target.classList?.contains('yX')) {
//                         let row = mutation.target;
//                         if (!row) customLog('[ERROR] No row found for mutation target for changes to name cell:', mutation.target);
//                         addRowPredictButton(row);
//                     } else {
//                         mutation.addedNodes.forEach(node => {
//                             if (node.classList?.contains('zA')) {
//                                 let row = node.querySelector('td.yX');
//                                 if (!row) customLog('[ERROR] No row found for mutation target for newly added email rows:', node);
//                                 addRowPredictButton(row);
//                             }
//                         });
//                     }
//                 });

//                 addPredictButtonToRows();
//             }

//             if (CHAT_MODE && typeof isGeminiButtonVisible === 'function' && isGeminiButtonVisible()) {
//                 if (typeof addFridayChatButton === 'function') addFridayChatButton();
//             }

//             if (CHAT_MODE && typeof isGeminiChatOpen === 'function' && isGeminiChatOpen()) {
//                 initializeGeminiChat();
//             }
//         } catch (err) {
//             console.error('friday: observer error', err);
//         }
//     });

//     observer.observe(document.body, { childList: true, subtree: true });
// }

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
                input.placeholder = 'Ask Friday to help with this email...';
                Object.assign(input.style, { flex: '1 1 auto', resize: 'none', minHeight: '48px', maxHeight: '140px', padding: '10px 12px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.04)', background: '#0b1220', color: '#e6eef8' });

                const sendButton = document.createElement('button');
                sendButton.innerText = '➤';
                Object.assign(sendButton.style, { width: '44px', height: '44px', padding: '0', background: 'linear-gradient(90deg,#111827,#0b1220)', color: '#fff', border: 'none', borderRadius: '10px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 6px 14px rgba(2,6,23,0.6)' });

                sendButton.addEventListener('click', () => {
                    const text = input.value.trim();
                    if (!text) return;
                    // Append a simple user bubble
                    const bubble = document.createElement('div');
                    bubble.textContent = text;
                    Object.assign(bubble.style, { alignSelf: 'flex-end', background: '#111827', color: '#e6eef8', padding: '10px 12px', borderRadius: '14px', marginBottom: '8px', maxWidth: '80%', boxShadow: '0 6px 18px rgba(2,6,23,0.6)' });
                    messageArea.appendChild(bubble);
                    messageArea.scrollTop = messageArea.scrollHeight;

                    // If a FridayChat implementation exists, forward the message to it
                    try {
                        const emailAddress = (typeof getUserEmail === 'function') ? getUserEmail() : null;
                        if (emailAddress) {
                            const chat = initializeFridayChat(messageArea, emailAddress);
                            if (chat && typeof chat.sendMessage === 'function') chat.sendMessage(text);
                        }
                    } catch (e) { customLog('chat send error', e); }

                    input.value = '';
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
        if (!floatingContainer) {   customLog('Floating container not found for toggle button'); return; }
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

