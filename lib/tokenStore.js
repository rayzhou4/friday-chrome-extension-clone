const fs = require('fs');
const path = require('path');

const STORE_PATH = path.resolve(process.cwd(), 'tokens.json');

function readStore() {
  try {
    if (!fs.existsSync(STORE_PATH)) return {};
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    return JSON.parse(raw || '{}');
  } catch (err) {
    console.error('Failed to read token store', err);
    return {};
  }
}

function writeStore(data) {
  try {
    fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to write token store', err);
  }
}

module.exports = {
  getTokenForId(id) {
    const store = readStore();
    return store[id] || null;
  },
  saveTokenForId(id, tokenObj) {
    const store = readStore();
    store[id] = tokenObj;
    writeStore(store);
  },
  deleteTokenForId(id) {
    const store = readStore();
    delete store[id];
    writeStore(store);
  }
};
