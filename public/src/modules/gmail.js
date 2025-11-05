// modules/gmail.js
// Lightweight helpers for interacting with Gmail DOM for the prototype.
// These functions are intentionally defensive because Gmail's DOM can change.

export function getUserEmail() {
  try {
    const accountAnchor = document.querySelector('a.gb_B[aria-label*="Google Account"]');
    if (accountAnchor) {
      const label = accountAnchor.getAttribute("aria-label") || "";
      const match = label.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
      if (match) {
        return match[0];
      }
    }
  } catch (err) {
    console.warn('getUserEmail error', err);
  }
  return "";
}

export function getThreadIdFromPage() {
    try {
      // Gmail sometimes keeps the thread id as th= in URL or as /u/0/#inbox/THREAD_ID
      const url = location.href;
      const m = url.match(/#.*th=([a-zA-Z0-9_-]+)/) || url.match(/\/k\/[0-9]+\/([a-zA-Z0-9_-]+)/);
      if (m) return { legacyThreadId: m[1] };
      // Try query param
      const q = new URL(location.href).searchParams.get('th');
      if (q) return { legacyThreadId: q };
      return null;
    } catch (err) {
      return null;
    }
  }

  export function isInInbox() {
    return location.href.includes('/#inbox') || document.title.toLowerCase().includes('inbox');
  }

  export function isInLabels() {
    return location.href.includes('/#label/') || document.querySelector('[aria-label*="Labels"]') !== null;
  }

  export function isInListView() {
    // Heuristic: presence of rows with class zA
    return document.querySelectorAll('tr.zA').length > 0;
  }

  export function getEmailRows() {
    return Array.from(document.querySelectorAll('tr.zA')) || [];
  }

  export function getThreadIdFromRow(row) {
    try {
      // Look for a link in the row that contains the message id
      const a = row.querySelector('a[href*="#"], a[href*="/u/"]');
      if (a) {
        const href = a.getAttribute('href');
        const m = href.match(/th=([a-zA-Z0-9_-]+)/) || href.match(/\/([a-zA-Z0-9_-]{16,})/);
        if (m) return { legacyThreadId: m[1], legacyLastNonDraftMessageId: null };
      }
      return { legacyThreadId: null, legacyLastNonDraftMessageId: null };
    } catch (err) {
      return { legacyThreadId: null, legacyLastNonDraftMessageId: null };
    }
  }

  export function archiveEmail() {
    try {
      // Click the archive button if visible
      const btn = document.querySelector('div[aria-label="Archive"], div[aria-label="Archive conversation"]');
      if (btn) { btn.click(); return true; }
      // fallback keyboard shortcut: press 'e' while focused
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true }));
    } catch (err) {
      console.warn('archiveEmail error', err);
    }
  }

  export function archiveFromRowView(row) {
    try {
      // try to find the archive action for the specific row
      const archiveBtn = row.querySelector('div[aria-label="Archive"], .ar5');
      if (archiveBtn) { archiveBtn.click(); return true; }
      return archiveEmail();
    } catch (err) {
      console.warn('archiveFromRowView error', err);
    }
  }

  export function replyToEmail(text, messageId = null) {
    try {
      // Try to find reply button in the message view
      const replyBtn = document.querySelector('div[aria-label="Reply"]') || document.querySelector('div[aria-label*="Reply"]');
      if (replyBtn) replyBtn.click();

      // Find the editable reply area
      const replyArea = document.querySelector('[aria-label="Message Body"]') || document.querySelector('div[role="textbox"]');
      if (replyArea) {
        // Insert text
        replyArea.focus();
        document.execCommand('insertText', false, text);
        // Optionally click send
        const sendBtn = document.querySelector('div[aria-label="Send"]');
        if (sendBtn) sendBtn.click();
        return true;
      }
    } catch (err) {
      console.warn('replyToEmail error', err);
    }
  }

  export function forwardEmail(text) {
    try {
      const forwardBtn = document.querySelector('div[aria-label="Forward"]');
      if (forwardBtn) forwardBtn.click();
      const area = document.querySelector('[aria-label="Message Body"]') || document.querySelector('div[role="textbox"]');
      if (area) {
        area.focus();
        document.execCommand('insertText', false, text);
      }
    } catch (err) {
      console.warn('forwardEmail error', err);
    }
  }

  export function getUnsubscribeButton() {
    return document.querySelector('a[href*="unsubscribe"], button[aria-label*="unsubscribe"], a:contains("Unsubscribe")');
  }

  export function findUnsubscribeLink() {
    const links = Array.from(document.querySelectorAll('a'));
    return links.find(a => /unsubscribe/i.test(a.textContent)) || null;
  }

  export function replyBoxIsOpen() {
    return !!document.querySelector('div[aria-label="Message Body"], div[role="textbox"]');
  }

  export function inputReply(text) {
    const area = document.querySelector('div[aria-label="Message Body"], div[role="textbox"]');
    if (area) {
      area.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
      return true;
    }
    return false;
  }

  export function getMessageBody() {
    const area = document.querySelector('div[aria-label="Message Body"], div[role="textbox"]');
    return area ? area.innerText || area.textContent : '';
  }

  export function removeOriginalDraft() {
    try {
      const draft = document.querySelector('.editable');
      if (draft) draft.innerHTML = '';
    } catch (err) {
      console.warn('removeOriginalDraft error', err);
    }
  }

  export function unsubscribe() {
    try {
      const link = findUnsubscribeLink();
      if (link) { link.click(); return true; }
      const btn = getUnsubscribeButton();
      if (btn) { btn.click(); return true; }
    } catch (err) {
      console.warn('unsubscribe error', err);
    }
  }

  export function isGeminiButtonVisible() {
    return !!document.querySelector('div[jsname="y8x7oe"], div.ccYpFf');
  }

  export function isGeminiChatOpen() {
    return !!document.querySelector('div[jsname="v2aOce"], div.ccYpFf');
  }

  // Functions used to modify the Gemini chat UI for replacement
  export function modifyGeminiChatHeader(container, fridayChatInstance = null) {
    try {
      const header = container.querySelector('header') || container.querySelector('div[role="heading"]');
      if (header) {
        header.style.display = 'flex';
        header.style.justifyContent = 'space-between';
        // Add custom clear button
        let clearBtn = header.querySelector('.friday-clear-btn');
        if (!clearBtn) {
          clearBtn = document.createElement('button');
          clearBtn.className = 'friday-clear-btn';
          clearBtn.textContent = 'Clear';
          clearBtn.addEventListener('click', () => {
            if (fridayChatInstance) fridayChatInstance.clearHistory && fridayChatInstance.clearHistory();
            const chatContent = container.querySelector('div[jsname="v2aOce"]');
            if (chatContent) chatContent.innerHTML = '';
          });
          header.appendChild(clearBtn);
        }
      }
    } catch (err) {
      console.warn('modifyGeminiChatHeader error', err);
    }
  }

  export function modifyGeminiChatFooter(container, onSend) {
    try {
      const footer = container.querySelector('footer') || container.querySelector('div[role="toolbar"]');
      if (footer) {
        let sendArea = footer.querySelector('.friday-send-area');
        if (!sendArea) {
          sendArea = document.createElement('div');
          sendArea.className = 'friday-send-area';
          sendArea.style.display = 'flex';
          sendArea.style.gap = '8px';
          const input = document.createElement('input');
          input.className = 'friday-input';
          input.placeholder = 'Ask Friday...';
          input.style.flex = '1';
          const sendBtn = document.createElement('button');
          sendBtn.textContent = 'Send';
          sendBtn.addEventListener('click', () => onSend && onSend(input, container));
          sendArea.appendChild(input);
          sendArea.appendChild(sendBtn);
          footer.appendChild(sendArea);
        }
      }
    } catch (err) {
      console.warn('modifyGeminiChatFooter error', err);
    }
  }

  export function modifyGeminiChat(container) {
    try {
      const chatContent = container.querySelector('div[jsname="v2aOce"]');
      if (chatContent) {
        chatContent.innerHTML = '<div class="friday-chat-placeholder">Friday Chat Loaded</div>';
      }
    } catch (err) {
      console.warn('modifyGeminiChat error', err);
    }
  }

  export default {
    getUserEmail,
    getThreadIdFromPage,
    isInInbox,
    isInLabels,
    isInListView,
    getEmailRows,
    getThreadIdFromRow,
    archiveEmail,
    archiveFromRowView,
    replyToEmail,
    forwardEmail,
    getUnsubscribeButton,
    findUnsubscribeLink,
    replyBoxIsOpen,
    inputReply,
    getMessageBody,
    removeOriginalDraft,
    unsubscribe,
    isGeminiButtonVisible,
    isGeminiChatOpen,
    modifyGeminiChatHeader,
    modifyGeminiChatFooter,
    modifyGeminiChat
  };
