// popup.js
// Uses Web Crypto API (PBKDF2 -> AES-GCM) to encrypt/decrypt the Gemini API key.
// Robust JSON extraction + retry/reformat flow for Gemini outputs.

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-2.0-flash';

const apiKeyInput = document.getElementById('apiKey');
const saveKeyBtn = document.getElementById('saveKeyBtn');
const clearKeyBtn = document.getElementById('clearKeyBtn');
const cityInput = document.getElementById('city');
const foodInput = document.getElementById('food');
const searchBtn = document.getElementById('searchBtn');
const clearBtn = document.getElementById('clearBtn');
const resultsDiv = document.getElementById('results');

let sessionApiKey = null; // cached decrypted key for the current popup session

/* -------------------- Utilities: base64 encode/decode for ArrayBuffers -------------------- */
function base64Encode(u8) {
  // chunked encode to avoid call stack issues
  const CHUNK = 0x8000;
  let idx = 0, len = u8.length, result = '', slice;
  while (idx < len) {
    slice = u8.subarray(idx, Math.min(idx + CHUNK, len));
    result += String.fromCharCode.apply(null, slice);
    idx += CHUNK;
  }
  return btoa(result);
}
function base64Decode(b64) {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/* -------------------- Key derivation and encrypt/decrypt -------------------- */
async function deriveKeyFromPassphrase(passphrase, saltUint8) {
  const enc = new TextEncoder();
  const passKey = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: saltUint8,
      iterations: 200000,
      hash: 'SHA-256'
    },
    passKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  return key;
}

async function encryptApiKey(apiKeyPlain, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKeyFromPassphrase(passphrase, salt);
  const enc = new TextEncoder();
  const cipherBuffer = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(apiKeyPlain));
  return {
    ciphertext: base64Encode(new Uint8Array(cipherBuffer)),
    iv: base64Encode(iv),
    salt: base64Encode(salt)
  };
}

async function decryptApiKey(encryptedObj, passphrase) {
  const salt = base64Decode(encryptedObj.salt);
  const iv = base64Decode(encryptedObj.iv);
  const cipher = base64Decode(encryptedObj.ciphertext);
  const key = await deriveKeyFromPassphrase(passphrase, salt);
  const plainBuffer = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher.buffer);
  return new TextDecoder().decode(plainBuffer);
}

/* -------------------- Storage helpers -------------------- */
async function storeEncryptedKey(obj) {
  return new Promise((res) => chrome.storage.local.set({ gemini_encrypted: obj }, () => res()));
}
async function getEncryptedKey() {
  return new Promise((res) => chrome.storage.local.get('gemini_encrypted', (r) => res(r.gemini_encrypted)));
}
async function clearStoredKey() {
  return new Promise((res) => chrome.storage.local.remove('gemini_encrypted', () => res()));
}

/* -------------------- UI actions: Save / Clear Key -------------------- */
saveKeyBtn.addEventListener('click', async () => {
  const key = apiKeyInput.value.trim();
  if (!key) return alert('Please enter your Gemini API key before saving.');

  // Ask user for a passphrase (not stored) to protect the key.
  const pass1 = prompt('Create a passphrase to encrypt your API key (you will need this passphrase to decrypt later):');
  if (!pass1) return alert('Passphrase is required to encrypt the API key.');
  const pass2 = prompt('Confirm passphrase:');
  if (pass1 !== pass2) return alert('Passphrases do not match. Aborting save.');

  try {
    const encObj = await encryptApiKey(key, pass1);
    await storeEncryptedKey(encObj);
    sessionApiKey = key; // cache for this popup session
    apiKeyInput.value = ''; // clear visible input
    alert('API key encrypted and saved locally. Remember your passphrase!');
  } catch (err) {
    console.error(err);
    alert('Failed to encrypt/save the key: ' + err.message);
  }
});

clearKeyBtn.addEventListener('click', async () => {
  await clearStoredKey();
  sessionApiKey = null;
  alert('Stored API key cleared.');
});

/* -------------------- Helper: show loading spinner text -------------------- */
function setLoading(message = 'Loading…') {
  resultsDiv.innerHTML = `<div class="about"><span class="spinner"></span> ${escapeHtml(message)}</div>`;
}

/* -------------------- Escape HTML -------------------- */
function escapeHtml(str) {
  if (str == null) return '';
  return String(str).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
}

/* -------------------- Extract text from Gemini response (robust) -------------------- */
function extractTextFromApiResponse(json) {
  try {
    // Try several common shapes
    if (json?.candidates?.length) {
      const cand = json.candidates[0];
      if (cand?.content?.parts?.length && typeof cand.content.parts[0].text === 'string') return cand.content.parts[0].text;
      if (cand?.content?.length && cand.content[0].parts?.length && typeof cand.content[0].parts[0].text === 'string') return cand.content[0].parts[0].text;
      if (cand?.output?.[0]?.content?.[0]?.text) return cand.output[0].content[0].text;
      if (typeof cand?.text === 'string') return cand.text;
    }
    // Some responses use 'output' at top-level
    if (json?.output?.[0]?.content?.[0]?.text) return json.output[0].content[0].text;
  } catch(e){}
  return null;
}

/* -------------------- Extract the first complete JSON object from arbitrary text -------------------- */
function extractFirstJson(text) {
  if (!text || typeof text !== 'string') return null;
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\\\') { escape = true; continue; }
    if (ch === '"' ) { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        try {
          const parsed = JSON.parse(candidate);
          return { text: candidate, parsed };
        } catch (e) {
          // not valid JSON — continue scanning (maybe nested objects cause issues)
          // but if we can't parse candidate, continue searching for later closing brace
        }
      }
    }
  }
  return null;
}

/* -------------------- Call Gemini REST generateContent -------------------- */
async function callGemini(promptText, model = DEFAULT_MODEL, apiKey) {
  const url = `${API_BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = { contents: [{ parts: [{ text: promptText }] }] };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const t = await res.text().catch(()=>null);
    throw new Error(`Gemini HTTP ${res.status} ${res.statusText}${t? ' — '+t.slice(0,400):''}`);
  }
  const json = await res.json();
  const text = extractTextFromApiResponse(json);
  // If no text field found, fallback to stringified json
  return { text: text ?? JSON.stringify(json) , rawJson: json };
}

/* -------------------- Main flow: fetch suggestions with retry (strict JSON) -------------------- */
async function fetchRestaurantSuggestions(city, food, model = DEFAULT_MODEL, apiKey) {
  const basePrompt = `Return STRICT JSON ONLY — nothing else. Structure must match EXACTLY:

{
  "foodDescription": "short description (1-2 sentences)",
  "restaurants": [
    {
      "name": "restaurant name",
      "address": "address string",
      "googleMap": "https://maps.google.com/....",
      "reasons": ["reason1","reason2","reason3","reason4"]
    },
    {
      "name": "restaurant name",
      "address": "address string",
      "googleMap": "https://maps.google.com/....",
      "reasons": ["reason1","reason2","reason3","reason4"]
    }
  ]
}

Now: Provide the best two restaurants in ${city} for the food item "${food}". Keep each reason <= 12 words. Keep addresses concise. Do NOT include any explanatory text or extra fields.`;

  // 1) First attempt
  const attempt1 = await callGemini(basePrompt, model, apiKey);
  let text = attempt1.text;

  // Try to extract JSON
  let extracted = extractFirstJson(text);
  if (extracted) return extracted.parsed;

  // 2) If first attempt failed, attempt a re-format prompt using the raw text
  // Limit the raw to avoid huge payloads
  const rawSnippet = text.length > 8000 ? text.slice(0,8000) + '...[truncated]' : text;
  const reformatPrompt = `The previous response (not valid JSON) is below. Reformat it into VALID JSON matching the exact schema and nothing else (no commentary):

-----BEGIN PREVIOUS RESPONSE-----
${rawSnippet}
-----END PREVIOUS RESPONSE-----`;

  const attempt2 = await callGemini(reformatPrompt, model, apiKey);
  text = attempt2.text;
  extracted = extractFirstJson(text);
  if (extracted) return extracted.parsed;

  // 3) As a last attempt, ask a very short strictly constrained prompt
  const strictPrompt = `Produce ONLY valid JSON with schema:
{"foodDescription":"string","restaurants":[{"name":"string","address":"string","googleMap":"string","reasons":["s","s","s","s"]},{"name":"string","address":"string","googleMap":"string","reasons":["s","s","s","s"]}]}
Now provide values for city: ${city} and food: ${food}.`;
  const attempt3 = await callGemini(strictPrompt, model, apiKey);
  text = attempt3.text;
  extracted = extractFirstJson(text);
  if (extracted) return extracted.parsed;

  // If all attempts failed, return object with raw text for UI fallback
  return { __raw: attempt1.text };
}

/* -------------------- Render helpers -------------------- */
function renderStructured(data, city, food) {
  const fd = escapeHtml(data.foodDescription || '');
  let html = `<div class="about"><strong>About ${escapeHtml(food)}</strong><div style="margin-top:6px">${fd}</div></div>`;
  if (!Array.isArray(data.restaurants)) {
    html += `<div class="about small">No restaurants array found in response.</div>`;
  } else {
    data.restaurants.slice(0,2).forEach(r => {
      const name = escapeHtml(r.name || 'Unnamed');
      const addr = escapeHtml(r.address || '');
      const maps = escapeHtml(r.googleMap || '');
      const reasons = Array.isArray(r.reasons) ? r.reasons : [];
      html += `<div class="restaurant"><h3>${name}</h3><div class="address">${addr}</div>` +
              (maps ? `<div><a class="maplink" href="${maps}" target="_blank" rel="noreferrer">View on Google Maps</a></div>` : '') +
              `<ul>${reasons.slice(0,4).map(x=>`<li>${escapeHtml(x)}</li>`).join('')}</ul></div>`;
    });
  }
  resultsDiv.innerHTML = html;
}

function renderRaw(rawText) {
  const safe = escapeHtml(rawText);
  resultsDiv.innerHTML = `<div class="about"><strong>Raw output (could not parse as JSON)</strong></div><pre class="raw">${safe}</pre>
    <div style="margin-top:10px">
      <button id="retryBtn">Retry (ask Gemini to return strict JSON)</button>
      <button id="copyRawBtn" class="secondary">Copy raw</button>
    </div>`;
  document.getElementById('copyRawBtn').addEventListener('click', () => {
    navigator.clipboard.writeText(rawText).then(()=>alert('Raw response copied to clipboard.'));
  });
  document.getElementById('retryBtn').addEventListener('click', async () => {
    setLoading('Retrying with strict JSON prompt…');
    try {
      // We reuse fetchRestaurantSuggestions which already contains retry logic
      const encryptedObj = await getEncryptedKey();
      if (!encryptedObj) throw new Error('No stored encrypted API key found.');
      // Ask for passphrase to decrypt
      const pass = prompt('Enter passphrase to decrypt your Gemini API key (for retry):');
      if (!pass) throw new Error('Passphrase required.');
      const apiKey = await decryptApiKey(encryptedObj, pass);
      sessionApiKey = apiKey;
      const city = cityInput.value.trim();
      const food = foodInput.value.trim();
      const parsed = await fetchRestaurantSuggestions(city, food, DEFAULT_MODEL, apiKey);
      if (parsed.__raw) {
        renderRaw(parsed.__raw);
      } else {
        renderStructured(parsed, city, food);
      }
    } catch (err) {
      resultsDiv.innerHTML = `<div class="about" style="color:#b00020">Retry failed: ${escapeHtml(err.message)}</div>`;
    }
  });
}

/* -------------------- Main Search button handler -------------------- */
searchBtn.addEventListener('click', async () => {
  const city = cityInput.value.trim();
  const food = foodInput.value.trim();
  if (!city || !food) return alert('Please enter both city and food item.');

  // Get encrypted key if no session key cached
  let apiKey = sessionApiKey;
  if (!apiKey) {
    const enc = await getEncryptedKey();
    if (!enc) return alert('No saved API key found. Please save your key first.');
    const pass = prompt('Enter passphrase to decrypt your Gemini API key:');
    if (!pass) return alert('Passphrase required to decrypt API key.');
    try {
      apiKey = await decryptApiKey(enc, pass);
      sessionApiKey = apiKey; // cache for this popup session
    } catch (err) {
      return alert('Failed to decrypt API key: ' + err.message);
    }
  }

  try {
    setLoading('Querying Gemini for suggestions…');
    const result = await fetchRestaurantSuggestions(city, food, DEFAULT_MODEL, apiKey);
    if (result.__raw) {
      renderRaw(result.__raw);
    } else {
      renderStructured(result, city, food);
    }
  } catch (err) {
    resultsDiv.innerHTML = `<div class="about" style="color:#b00020">Error: ${escapeHtml(err.message)}</div>`;
  }
});

/* Clear results */
clearBtn.addEventListener('click', () => { resultsDiv.innerHTML = ''; });

