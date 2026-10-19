#!/usr/bin/env node
/**
 * Reproduction for Bug 2 in Contribo's GitHub sign-in.
 *
 * `users.email` was indexed `unique: true, sparse: true`. `sparse` only omits documents
 * where the field is ABSENT — the NextAuth MongoDB adapter writes `email: null` for an
 * OAuth profile with no public email, so every such account collides on the single null
 * key and the second one fails with E11000 { email: null }.
 *
 * This script proves both halves:
 *   1. legacy index  -> the second email-less user is rejected (bug reproduced)
 *   2. partial index -> email-less users coexist, duplicate real emails still rejected
 *
 * Requires a reachable mongod. Never point MONGODB_URI at production.
 *
 *   MONGODB_URI=mongodb://127.0.0.1:27017 node scripts/repro-null-email.mjs
 */

import { MongoClient } from 'mongodb';

const URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const DB_NAME = process.env.MONGODB_DB || 'contribo_auth_repro';
const COLL = 'users_probe';
const EMAIL_UNIQUE_INDEX = 'email_unique_when_present';

const legacyAccount = (id) => ({
  _id: id,
  name: `No Public Email ${id}`,
  email: null, // exactly what @auth/mongodb-adapter persists for a GitHub profile
                 // whose owner has not published an email address
  emailVerified: null,
  image: `https://avatars.githubusercontent.com/u/${id}?v=4`,
});

const isDuplicateKey = (err) => err?.code === 11000 || err?.codeName === 'DuplicateKey';

async function listIndexes(collection) {
  try {
    return await collection.indexes();
  } catch (err) {
    // A collection that has never been created has no namespace to list.
    if (err.code === 26 || err.codeName === 'NamespaceNotFound') return [];
    throw err;
  }
}

async function resetCollection(db) {
  const users = db.collection(COLL);
  await users.deleteMany({});
  for (const index of await listIndexes(users)) {
    if (index.name !== '_id_') await users.dropIndex(index.name);
  }
}

async function stageLegacyIndex(db) {
  console.log('\n[1] Legacy index: unique + sparse on users.email');
  const users = db.collection(COLL);
  await resetCollection(db);
  await users.createIndex({ email: 1 }, { unique: true, sparse: true, name: 'email_1' });

  const first = await users.insertOne(legacyAccount('11111111'));
  console.log(`    - first email-less account inserted (${first.insertedId})`);

  let blocked = null;
  try {
    await users.insertOne(legacyAccount('22222222'));
  } catch (err) {
    blocked = err;
  }

  if (!blocked || !isDuplicateKey(blocked)) {
    throw new Error(
      'expected the second email-less insert to fail with E11000, got: ' +
        (blocked ? blocked.message : 'no error'),
    );
  }
  console.log(
    `    - second email-less account REJECTED (code ${blocked.code}): ${firstKey(blocked.message)}`,
  );
  console.log('    => bug reproduced: uniqueness applies to the shared null key');
}

async function stagePartialIndex(db) {
  console.log('\n[2] Fixed index: unique only when the email is a string');
  const users = db.collection(COLL);
  await resetCollection(db);

  // Build the replacement BEFORE dropping the legacy index, mirroring
  // scripts/setup-indexes.js in the fix. Two indexes over { email: 1 } are legal in
  // MongoDB as long as the names differ.
  await users.createIndex({ email: 1 }, { unique: true, sparse: true, name: 'email_1' });
  await users.createIndex(
    { email: 1 },
    {
      unique: true,
      name: EMAIL_UNIQUE_INDEX,
      partialFilterExpression: { email: { $type: 'string' } },
    },
  );
  await users.dropIndex('email_1');

  await users.insertOne(legacyAccount('33333333'));
  await users.insertOne(legacyAccount('44444444'));
  console.log('    - two email-less accounts both inserted');

  // ...and real emails are still unique, so the fix is not a licence for duplicates.
  await users.insertOne({ ...legacyAccount('55555555'), email: 'dev@example.com' });
  let duplicateCaught = false;
  try {
    await users.insertOne({ ...legacyAccount('66666666'), email: 'dev@example.com' });
  } catch (err) {
    duplicateCaught = isDuplicateKey(err);
  }
  if (!duplicateCaught) {
    throw new Error('a repeated real email must still be rejected');
  }
  console.log('    - duplicate real email REJECTED (dev@example.com) as it should be');

  const names = (await users.indexes()).map((i) => i.name).sort().join(' | ');
  console.log(`    final index set: ${names}`);
}

function firstKey(message) {
  const line = String(message).split('\n')[0];
  return line.length > 90 ? `${line.slice(0, 90)}...` : line;
}

async function main() {
  const client = new MongoClient(URI, { serverSelectionTimeoutMS: 4000 });
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    const info = await db.command({ ping: 1 });
    void info;
    console.log(`Connected to ${URI} (database ${DB_NAME}, collection ${COLL})`);
    await stageLegacyIndex(db);
    await stagePartialIndex(db);
    await resetCollection(db);
    console.log('\nAll expectations met: the legacy index breaks email-less GitHub sign-ins, the partial index does not.');
  } catch (err) {
    if (err.message && /ECONNREFUSED|MONGODB_URI/i.test(err.message)) {
      console.error(`\nCannot reach mongod at ${URI}.`);
      console.error('Start one (e.g. `mongod --port 27017 --dbpath /tmp/mongo-repro`) or export MONGODB_URI.');
    }
    console.error(`\nFAILED: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

main();
