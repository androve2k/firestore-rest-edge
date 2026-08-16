/* ═════════════════════════════════════════════════════════════
   firestore-rest-edge — a minimal Firestore client for V8 isolate
   runtimes (Cloudflare Workers, Vercel Edge, Deno Deploy).

   WHY THIS EXISTS:
   The official `firebase-admin` SDK talks to Firestore over gRPC,
   which requires raw TCP sockets. V8 isolate runtimes don't expose
   TCP sockets to user code — not even with a Node.js compatibility
   flag, which covers some core APIs but not gRPC. This module
   replicates the operations most projects actually need (get a
   document, set/merge a document, run a simple query) by calling
   Google's public REST APIs directly:
     - oauth2.googleapis.com            (JWT -> access token exchange)
     - firestore.googleapis.com/v1/...  (document CRUD + queries)

   AUTHENTICATION:
   Uses the same service account credentials as firebase-admin
   (project ID, client email, private key). The JWT is signed with
   RS256 using the Web Crypto API (`crypto.subtle`), which is
   available natively in every V8 isolate runtime — no Node.js
   `crypto` module required.

   The resulting access token is valid for 1 hour and cached at the
   client level: if the isolate stays warm between requests (typical
   under steady traffic), you avoid re-signing a JWT and calling
   Google on every single request.

   SCOPE:
   This is NOT a full Firestore client. It covers: get a single
   document, set/merge a document (shallow merge on top-level
   fields), and simple queries (where/orderBy/limit). It does not
   support transactions, batched writes, collection group queries,
   or realtime listeners — some of these are architecturally
   impossible on a stateless edge runtime anyway. See "Limitations"
   in the README before adopting this for anything beyond simple
   CRUD.
═════════════════════════════════════════════════════════════ */

// ───────────────────────── Helpers ─────────────────────────

function base64UrlEncode(bytes) {
  let binary;
  if (typeof bytes === 'string') {
    binary = bytes;
  } else {
    binary = String.fromCharCode(...new Uint8Array(bytes));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToArrayBuffer(pem) {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function importPrivateKey(pem) {
  const keyData = pemToArrayBuffer(pem);
  return crypto.subtle.importKey(
    'pkcs8',
    keyData,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

// ───────────────── JS <-> Firestore REST value conversion ─────────────────
// Firestore's REST API wraps every value in a typed envelope
// (e.g. {"stringValue": "hi"}, {"integerValue": "42"}). These
// helpers convert to/from plain JS values.

function toFirestoreValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFirestoreValue) } };
  if (typeof v === 'object') return { mapValue: { fields: toFirestoreFields(v) } };
  throw new Error(`Unsupported value type for Firestore: ${typeof v}`);
}

function toFirestoreFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined) continue; // Firestore has no "undefined" — omit the field
    fields[k] = toFirestoreValue(v);
  }
  return fields;
}

function fromFirestoreValue(fv) {
  if (!fv) return null;
  if ('nullValue' in fv) return null;
  if ('booleanValue' in fv) return fv.booleanValue;
  if ('integerValue' in fv) return parseInt(fv.integerValue, 10);
  if ('doubleValue' in fv) return fv.doubleValue;
  if ('timestampValue' in fv) return new Date(fv.timestampValue);
  if ('stringValue' in fv) return fv.stringValue;
  if ('arrayValue' in fv) return (fv.arrayValue.values || []).map(fromFirestoreValue);
  if ('mapValue' in fv) return fromFirestoreFields(fv.mapValue.fields || {});
  return null;
}

function fromFirestoreFields(fields) {
  const obj = {};
  for (const [k, v] of Object.entries(fields || {})) {
    obj[k] = fromFirestoreValue(v);
  }
  return obj;
}

function docIdFromName(name) {
  // name looks like "projects/X/databases/(default)/documents/coll/docId"
  const parts = name.split('/');
  return parts[parts.length - 1];
}

const OP_MAP = {
  '==': 'EQUAL', '!=': 'NOT_EQUAL',
  '<': 'LESS_THAN', '<=': 'LESS_THAN_OR_EQUAL',
  '>': 'GREATER_THAN', '>=': 'GREATER_THAN_OR_EQUAL'
};

// ───────────────────────── Client ─────────────────────────

/**
 * Create a Firestore REST client for edge/V8-isolate runtimes.
 *
 * @param {Object} config
 * @param {string} config.projectId    Firebase/GCP project ID
 * @param {string} config.clientEmail  Service account client email
 * @param {string} config.privateKey   Service account private key (PEM).
 *   If your platform stores it with literal "\n" sequences (common with
 *   Cloudflare Workers secrets / most env var UIs), pass it as-is —
 *   this client normalizes it internally.
 */
function createFirestoreClient(config) {
  const { projectId, clientEmail } = config;
  const privateKey = (config.privateKey || '').replace(/\\n/g, '\n');

  if (!projectId || !clientEmail || !privateKey) {
    const missing = [];
    if (!projectId) missing.push('projectId');
    if (!clientEmail) missing.push('clientEmail');
    if (!privateKey) missing.push('privateKey');
    throw new Error(`Missing Firestore credentials: ${missing.join(', ')}`);
  }

  let cachedToken = null; // { accessToken, expiresAt (ms epoch) }

  async function getAccessToken() {
    const now = Date.now();
    if (cachedToken && cachedToken.expiresAt > now + 60000) {
      // 60s safety margin before real expiry
      return cachedToken.accessToken;
    }

    const iat = Math.floor(now / 1000);
    const exp = iat + 3600;

    const header = { alg: 'RS256', typ: 'JWT' };
    const claims = {
      iss: clientEmail,
      scope: 'https://www.googleapis.com/auth/datastore',
      aud: 'https://oauth2.googleapis.com/token',
      iat,
      exp
    };

    const signingInput =
      base64UrlEncode(JSON.stringify(header)) + '.' + base64UrlEncode(JSON.stringify(claims));

    const key = await importPrivateKey(privateKey);
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      key,
      new TextEncoder().encode(signingInput)
    );

    const jwt = signingInput + '.' + base64UrlEncode(signature);

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt
      })
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      throw new Error(`OAuth2 token exchange failed: HTTP ${tokenRes.status} — ${errText}`);
    }

    const tokenData = await tokenRes.json();
    cachedToken = {
      accessToken: tokenData.access_token,
      expiresAt: now + tokenData.expires_in * 1000
    };

    return cachedToken.accessToken;
  }

  const baseUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;

  /**
   * Read a single document. docPath e.g. "users/abc123".
   * Returns { exists, id, data } — data is a plain JS object
   * (Firestore timestamps become Date instances).
   */
  async function getDoc(docPath) {
    const token = await getAccessToken();
    const res = await fetch(`${baseUrl}/${docPath}`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (res.status === 404) return { exists: false, id: docPath.split('/').pop(), data: null };
    if (!res.ok) throw new Error(`Firestore GET ${docPath} → HTTP ${res.status}`);

    const json = await res.json();
    return {
      exists: true,
      id: docIdFromName(json.name),
      data: fromFirestoreFields(json.fields)
    };
  }

  /**
   * Write/update a document.
   * merge: true (default) merges only the top-level fields passed in
   *   — equivalent to admin SDK's `.set(data, {merge: true})`, but
   *   NOT a deep merge of nested maps.
   * merge: false overwrites the entire document.
   */
  async function setDoc(docPath, dataObj, { merge = true } = {}) {
    const token = await getAccessToken();
    const fields = toFirestoreFields(dataObj);

    let url = `${baseUrl}/${docPath}`;
    if (merge) {
      const fieldPaths = Object.keys(dataObj).filter((k) => dataObj[k] !== undefined);
      const qs = fieldPaths.map((f) => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join('&');
      url += `?${qs}`;
    }

    const res = await fetch(url, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields })
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Firestore PATCH ${docPath} → HTTP ${res.status} — ${errText}`);
    }
    return res.json();
  }

  /**
   * Run a simple query: AND-combined `where` filters, optional
   * `orderBy`, optional `limit`.
   *   where:   [{ field, op, value }]  op ∈ '==' '!=' '<' '<=' '>' '>='
   *   orderBy: { field, direction: 'ASCENDING' | 'DESCENDING' }
   * Returns an array of { id, data }.
   */
  async function query(collectionId, { where = [], orderBy = null, limit = null } = {}) {
    const token = await getAccessToken();

    const filters = where.map((w) => ({
      fieldFilter: {
        field: { fieldPath: w.field },
        op: OP_MAP[w.op],
        value: toFirestoreValue(w.value)
      }
    }));

    let whereClause;
    if (filters.length === 1) whereClause = filters[0];
    else if (filters.length > 1) whereClause = { compositeFilter: { op: 'AND', filters } };

    const structuredQuery = {
      from: [{ collectionId }],
      ...(whereClause ? { where: whereClause } : {}),
      ...(orderBy
        ? { orderBy: [{ field: { fieldPath: orderBy.field }, direction: orderBy.direction || 'ASCENDING' }] }
        : {}),
      ...(limit ? { limit } : {})
    };

    const res = await fetch(`${baseUrl}:runQuery`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ structuredQuery })
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Firestore runQuery(${collectionId}) → HTTP ${res.status} — ${errText}`);
    }

    const rows = await res.json();
    return rows
      .filter((r) => r.document)
      .map((r) => ({ id: docIdFromName(r.document.name), data: fromFirestoreFields(r.document.fields) }));
  }

  return { getAccessToken, getDoc, setDoc, query };
}

export {
  createFirestoreClient,
  toFirestoreValue,
  fromFirestoreValue,
  toFirestoreFields,
  fromFirestoreFields,
  docIdFromName
};
