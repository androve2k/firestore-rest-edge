/**
 * Minimal Cloudflare Worker using firestore-rest-edge.
 *
 * Required secrets (wrangler secret put ...):
 *   FIREBASE_PROJECT_ID
 *   FIREBASE_CLIENT_EMAIL
 *   FIREBASE_PRIVATE_KEY   (paste the PEM as-is; \n line breaks are handled)
 */
import { createFirestoreClient } from 'firestore-rest-edge';

export default {
  async fetch(request, env) {
    const db = createFirestoreClient({
      projectId: env.FIREBASE_PROJECT_ID,
      clientEmail: env.FIREBASE_CLIENT_EMAIL,
      privateKey: env.FIREBASE_PRIVATE_KEY
    });

    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname.startsWith('/visits/')) {
      const id = url.pathname.split('/').pop();
      const doc = await db.getDoc(`siteVisits/${id}`);
      return Response.json(doc);
    }

    if (request.method === 'POST' && url.pathname === '/visits') {
      const body = await request.json();
      await db.setDoc(`siteVisits/${crypto.randomUUID()}`, {
        page: body.page,
        timestamp: new Date()
      });
      return new Response('ok', { status: 201 });
    }

    if (request.method === 'GET' && url.pathname === '/visits/recent') {
      const results = await db.query('siteVisits', {
        orderBy: { field: 'timestamp', direction: 'DESCENDING' },
        limit: 20
      });
      return Response.json(results);
    }

    return new Response('Not found', { status: 404 });
  }
};
