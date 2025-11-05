// modules/api.js
// Lightweight API helpers for the extension UI and content script.
// These functions try to call Next.js backend endpoints if available
// and fall back to simple mocked behavior for a fast prototype.

const SERVER_BASE = typeof window !== 'undefined' && window.location ? `${window.location.origin}` : 'http://localhost:3000';

export async function predictAction(id, emailAddress, forceRecompute = false, threadBased = false) {
  try {
    const res = await fetch(`${SERVER_BASE}/api/predict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, emailAddress, forceRecompute, threadBased })
    });
    if (!res.ok) throw new Error('Predict API failed');
    return await res.json();
  } catch (err) {
    // Fallback mock prediction
    console.warn('predictAction fallback', err);
    return {
      result: {
        prediction: {
          types: ['archive'],
          confidence: 0.78,
          reasoning: 'Short mock reasoning',
          suggested_response: 'Thanks — I will follow up on this.'
        }
      },
      error: null
    };
  }
}

export async function getDraft(messageId, emailAddress, prompt, messageBody) {
  try {
    const res = await fetch(`${SERVER_BASE}/api/draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId, emailAddress, prompt, messageBody })
    });
    if (!res.ok) throw new Error('Draft API failed');
    return await res.json();
  } catch (err) {
    console.warn('getDraft fallback', err);
    return { suggestedResponse: `Hi — thanks for your message. ${prompt || ''}` };
  }
}

export async function sendChatMessage(emailAddress, message) {
  try {
    const res = await fetch(`${SERVER_BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emailAddress, message })
    });
    if (!res.ok) throw new Error('Chat API failed');
    return await res.json();
  } catch (err) {
    console.warn('sendChatMessage fallback', err);
    return { reply: `Mock reply to: ${message}` };
  }
}

export async function getUserCredits(session) {
  try {
    const res = await fetch(`${SERVER_BASE}/api/credits`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    });
    if (!res.ok) throw new Error('Credits API failed');
    return await res.json();
  } catch (err) {
    console.warn('getUserCredits fallback', err);
    return { credits: 1000, used: 73 };
  }

}

export default {
  predictAction,
  getDraft,
  sendChatMessage,
  getUserCredits
};
