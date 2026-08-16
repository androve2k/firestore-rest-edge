import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createFirestoreClient,
  toFirestoreValue,
  fromFirestoreValue,
  toFirestoreFields,
  fromFirestoreFields,
  docIdFromName
} from '../src/index.js';

test('toFirestoreValue: primitives', () => {
  assert.deepEqual(toFirestoreValue(null), { nullValue: null });
  assert.deepEqual(toFirestoreValue(undefined), { nullValue: null });
  assert.deepEqual(toFirestoreValue(true), { booleanValue: true });
  assert.deepEqual(toFirestoreValue(42), { integerValue: '42' });
  assert.deepEqual(toFirestoreValue(3.14), { doubleValue: 3.14 });
  assert.deepEqual(toFirestoreValue('hi'), { stringValue: 'hi' });
});

test('toFirestoreValue: Date becomes timestampValue', () => {
  const d = new Date('2026-08-16T12:00:00.000Z');
  assert.deepEqual(toFirestoreValue(d), { timestampValue: d.toISOString() });
});

test('toFirestoreValue: arrays and nested objects', () => {
  const result = toFirestoreValue([1, 'two', true]);
  assert.deepEqual(result, {
    arrayValue: {
      values: [{ integerValue: '1' }, { stringValue: 'two' }, { booleanValue: true }]
    }
  });

  const nested = toFirestoreValue({ a: 1, b: { c: 'x' } });
  assert.deepEqual(nested, {
    mapValue: {
      fields: { a: { integerValue: '1' }, b: { mapValue: { fields: { c: { stringValue: 'x' } } } } }
    }
  });
});

test('toFirestoreFields: omits undefined values', () => {
  const fields = toFirestoreFields({ a: 1, b: undefined, c: 'x' });
  assert.deepEqual(Object.keys(fields).sort(), ['a', 'c']);
});

test('round trip: JS value -> Firestore value -> JS value', () => {
  const original = { name: 'Jane', age: 30, active: true, tags: ['a', 'b'], meta: { note: 'ok' } };
  const wrapped = toFirestoreFields(original);
  const unwrapped = fromFirestoreFields(wrapped);
  assert.deepEqual(unwrapped, original);
});

test('fromFirestoreValue: handles all wrapper types', () => {
  assert.equal(fromFirestoreValue({ nullValue: null }), null);
  assert.equal(fromFirestoreValue({ booleanValue: false }), false);
  assert.equal(fromFirestoreValue({ integerValue: '7' }), 7);
  assert.equal(fromFirestoreValue({ doubleValue: 1.5 }), 1.5);
  assert.equal(fromFirestoreValue({ stringValue: 'x' }), 'x');
  assert.ok(fromFirestoreValue({ timestampValue: '2026-08-16T00:00:00.000Z' }) instanceof Date);
});

test('docIdFromName: extracts trailing segment', () => {
  assert.equal(
    docIdFromName('projects/p/databases/(default)/documents/users/abc123'),
    'abc123'
  );
});

test('createFirestoreClient: throws on missing credentials', () => {
  assert.throws(() => createFirestoreClient({}), /Missing Firestore credentials/);
  assert.throws(
    () => createFirestoreClient({ projectId: 'p' }),
    /clientEmail/
  );
});

test('createFirestoreClient: returns expected method surface', () => {
  const client = createFirestoreClient({
    projectId: 'p',
    clientEmail: 'x@example.iam.gserviceaccount.com',
    privateKey: '-----BEGIN PRIVATE KEY-----\nZmFrZQ==\n-----END PRIVATE KEY-----'
  });
  assert.equal(typeof client.getDoc, 'function');
  assert.equal(typeof client.setDoc, 'function');
  assert.equal(typeof client.query, 'function');
  assert.equal(typeof client.getAccessToken, 'function');
});
