import dotenv from 'dotenv';
import mongoose, { Model } from 'mongoose';
import { MongoRepository } from '@lib/mongo-repository';

dotenv.config({ quiet: true });

export function getMongoUri() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI is required');
  }
  return uri;
}

function getMongoHost(uri: string) {
  try {
    return new URL(uri).hostname;
  } catch {
    return 'configured URI';
  }
}

function isRetryableConnectionError(error: unknown) {
  const value = error as { code?: string; name?: string; message?: string };
  const code = String(value?.code || '');
  const message = String(value?.message || '');
  return [
    'ENOTFOUND',
    'EAI_AGAIN',
    'ECONNREFUSED',
    'ETIMEDOUT',
  ].includes(code) || value?.name === 'MongoServerSelectionError' || /server selection|querySrv|timed out/i.test(message);
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Checkout, payment confirmation and refunds rely on multi-document
 * transactions, which MongoDB only offers on a replica set or sharded
 * cluster. Fail at boot rather than on the first customer payment.
 */
async function assertTransactionSupport() {
  const hello = await mongoose.connection.db?.admin().command({ hello: 1 });
  if (!hello?.setName && hello?.msg !== 'isdbgrid') {
    const message = 'MongoDB is not a replica set: multi-document transactions are unavailable';
    if (process.env.NODE_ENV === 'production') throw new Error(message);
    console.warn(`⚠️ ${message}. Payment and checkout transactions will fail until you run a replica set.`);
  }
}

export async function connectDatabase() {
  if (mongoose.connection.readyState === 1) return mongoose.connection;

  const uri = getMongoUri();
  const configuredRetries = Number(process.env.MONGODB_CONNECT_RETRIES);
  const maxAttempts = Number.isInteger(configuredRetries) && configuredRetries > 0 ? configuredRetries : 5;
  const serverSelectionTimeoutMS = Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS)
    || (process.env.NODE_ENV === 'development' ? 5000 : 10000);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await mongoose.connect(uri, {
        autoIndex: process.env.NODE_ENV !== 'production',
        serverSelectionTimeoutMS,
        // A dropped connection should fail a query immediately, not queue it silently until a client-side
        // timeout — consistent with the fail-fast retry/backoff this function already does on initial connect.
        bufferCommands: false,
      });
      break;
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryableConnectionError(error)) throw error;
      const delay = Math.min(5000, 500 * (2 ** (attempt - 1)));
      console.warn(`⚠️ MongoDB connection attempt ${attempt}/${maxAttempts} failed for ${getMongoHost(uri)}; retrying in ${delay}ms`);
      await mongoose.disconnect().catch(() => undefined);
      await wait(delay);
    }
  }

  await assertTransactionSupport();
  console.log(`✅ MongoDB Connected: ${getMongoHost(uri)}`);
  console.log(`   Database: ${mongoose.connection.name}`);

  return mongoose.connection;
}

export async function disconnectDatabase() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
}

export const initializeDatabase = connectDatabase;

export const AppDataSource = {
  get isInitialized() {
    return mongoose.connection.readyState === 1;
  },
  initialize: connectDatabase,
  destroy: disconnectDatabase,
  getRepository<T extends { id?: string }>(model: Model<T>) {
    return new MongoRepository<T>(model);
  },
};

export default AppDataSource;
