import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

let replSet: MongoMemoryReplSet | undefined;

/** A single-node replica set: plain standalone mongod cannot run transactions. */
export async function startDatabase() {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri(), { autoIndex: true });
}

export async function resetDatabase() {
  const collections = await mongoose.connection.db!.collections();
  await Promise.all(collections.map((collection) => collection.deleteMany({})));
}

export async function stopDatabase() {
  await mongoose.disconnect();
  await replSet?.stop();
}
