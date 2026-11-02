// One-off cleanup: clears every row in the `notifications` collection so the
// bell starts fresh, free of seeded/demo noise (catalog_availability,
// negotiation_started, etc.). Safe to delete this file after running once.
//
// Usage:  node scripts/clear-notifications.js
const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
const env = fs.readFileSync(envPath, 'utf8');
const uri = env.split('\n').find((line) => line.startsWith('MONGODB_URI=')).slice('MONGODB_URI='.length).trim();

(async () => {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db();
  const before = await db.collection('notifications').countDocuments({});
  const result = await db.collection('notifications').deleteMany({});
  const after = await db.collection('notifications').countDocuments({});
  console.log(`Deleted ${result.deletedCount} of ${before} notifications. Remaining: ${after}`);
  await client.close();
})().catch((error) => {
  console.error('Failed:', error);
  process.exitCode = 1;
});
