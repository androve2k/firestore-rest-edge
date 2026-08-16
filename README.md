# firestore-rest-edge

A minimal Firestore client for V8 isolate runtimes — Cloudflare Workers, Vercel Edge Functions, Deno Deploy — where `firebase-admin` doesn't work.

## The problem

`firebase-admin` talks to Firestore over **gRPC**, which requires raw TCP sockets. V8 isolate runtimes don't expose TCP sockets to user code — not even with a Node.js compatibility flag, since those flags cover some core Node APIs but not gRPC's transport layer. If you've tried to import `firebase-admin` in a Cloudflare Worker, you've likely hit something like:

```
Error: connect ECONNREFUSED — or —
TypeError: The 'net' module is not supported
```

There's no fix on the `firebase-admin` side: it's a fundamental architecture mismatch, not a bug. The usual advice is "use a different database" — but if your project is already on Firestore, that's a rewrite, not a fix.

This package takes the other path: Firestore also exposes a plain **REST API** (`firestore.googleapis.com/v1/...`), authenticated the same way as the admin SDK (a service account JWT). REST works fine over `fetch()`, which every edge runtime supports natively. This client implements just enough of that REST surface to cover the operations most projects actually use.

## Install

```bash
npm install firestore-rest-edge
```

## Usage

```js
import { createFirestoreClient } from 'firestore-rest-edge';

const db = createFirestoreClient({
  projectId: env.FIREBASE_PROJECT_ID,
  clientEmail: env.FIREBASE_CLIENT_EMAIL,
  privateKey: env.FIREBASE_PRIVATE_KEY // \n-escaped PEM is handled automatically
});

// Read
const doc = await db.getDoc('users/abc123');
// → { exists: true, id: 'abc123', data: { name: 'Jane', age: 30 } }

// Write (shallow merge on top-level fields — like admin SDK's .set(data, {merge: true}))
await db.setDoc('users/abc123', { lastSeen: new Date() });

// Overwrite entirely
await db.setDoc('users/abc123', { name: 'Jane' }, { merge: false });

// Query
const results = await db.query('users', {
  where: [{ field: 'age', op: '>=', value: 18 }],
  orderBy: { field: 'age', direction: 'DESCENDING' },
  limit: 10
});
// → [{ id: 'abc123', data: {...} }, ...]
```

See [`example/cloudflare-worker.js`](./example/cloudflare-worker.js) for a full Worker.

## How authentication works

Same service account credentials as `firebase-admin` (project ID, client email, private key) — no new GCP setup needed if you're migrating an existing project. The client signs an RS256 JWT using the **Web Crypto API** (`crypto.subtle`), which is available natively in every V8 isolate runtime, and exchanges it for an OAuth2 access token. The token is cached in memory for its ~1 hour lifetime (with a 60s safety margin), so a warm isolate handling steady traffic doesn't re-sign a JWT on every request.

## API

### `createFirestoreClient({ projectId, clientEmail, privateKey })`

Returns a client with:

| Method | Description |
|---|---|
| `getDoc(docPath)` | Read a single document. Returns `{ exists, id, data }`. `data` is a plain JS object — Firestore timestamps become `Date` instances. |
| `setDoc(docPath, data, { merge })` | Write a document. `merge: true` (default) updates only the top-level fields passed in. `merge: false` overwrites the whole document. |
| `query(collectionId, { where, orderBy, limit })` | Run a query. `where` is an array of `{ field, op, value }` with `op` in `== != < <= > >=`, AND-combined. Returns `[{ id, data }]`. |
| `getAccessToken()` | Get (and cache) a raw OAuth2 access token, in case you need to call other Google Cloud REST APIs with the same credentials. |

## Limitations

This is deliberately **not** a full Firestore client. It does not support:

- Transactions or batched writes
- Deep/nested-field merges (`setDoc` merge is shallow on top-level fields only)
- Collection group queries or compound `OR` filters
- Realtime listeners (architecturally impossible on a stateless edge function anyway — there's no persistent connection to hang a listener off)
- Subcollections beyond simple path traversal (`parent/id/sub/id` works; recursive subcollection queries don't)

If your project needs any of the above, this package isn't the right fit — consider running an admin API behind a traditional Node server, or a different data layer built for edge from day one. This exists for the common case: a Worker that needs to read/write a handful of documents and run simple filtered queries against an existing Firestore database.

## Testing

`npm test` runs a `node --test` suite covering the JS ↔ Firestore REST value conversion (the part most likely to silently misbehave — numbers vs. strings, nested maps, arrays, timestamps) and client validation. It doesn't hit real Firestore; there's no way to unit test the network calls without either a live project or a mock server, both out of scope for this package's size.

## Origin

Extracted from the Cloudflare Workers backend of [roversia.it](https://roversia.it/index-en.html), a free utility/tools site, after migrating off Netlify Functions in August 2026 and hitting this exact gRPC wall. Read the full migration writeup: [Netlify → Cloudflare Workers migration](https://roversia.it/blog-27-migrazione-netlify-cloudflare-workers-en.html).

## Related

Part of a small set of zero-dependency JS utilities I maintain: [39+ free browser-based tools](https://roversia.it/utility-en.html) at roversia.it.

## License

MIT © [Andrea Roversi](https://roversia.it/index-en.html)
