import { connectDatabase, disconnectDatabase } from '@config/data-source';
import { RunnerPackage } from '@models/fulfilment/fulfilment.model';
import { ItemResolution } from '@models/fulfilment/item-resolution.model';
import { FulfilmentTaskStatus, RunnerPackageStatus } from '@lib/constants';

async function main() {
  await connectDatabase();
  const duplicateActiveCodes = await RunnerPackage.aggregate([
    { $match: { status: 'READY_FOR_HUB' } },
    { $group: { _id: { hubId: '$hubId', scanCredentialHash: '$scanCredentialHash' }, count: { $sum: 1 }, packageIds: { $push: '$publicId' } } },
    { $match: { count: { $gt: 1 } } },
  ]);
  if (duplicateActiveCodes.length) {
    throw new Error(`Cannot create the active handover-code index: ${duplicateActiveCodes.length} duplicate Hub/code pair(s) require review`);
  }
  await Promise.all([RunnerPackage.createIndexes(), ItemResolution.createIndexes()]);
  const receivedPackages = await RunnerPackage.find({ status: RunnerPackageStatus.HUB_RECEIVED })
    .select('taskId handedOverAt credentialVerifiedAt')
    .lean();
  let reconciledTasks = 0;
  for (const pack of receivedPackages) {
    const result = await (await import('@models/fulfilment/fulfilment.model')).FulfilmentTask.updateOne(
      { _id: pack.taskId, status: FulfilmentTaskStatus.READY_FOR_HUB },
      { $set: { status: FulfilmentTaskStatus.HUB_RECEIVED, hubReceivedAt: pack.credentialVerifiedAt || pack.handedOverAt || new Date() }, $inc: { version: 1 } },
    );
    reconciledTasks += result.modifiedCount;
  }
  console.log(`Market fulfilment indexes are ready; reconciled ${reconciledTasks} received task(s)`);
}

void main().finally(() => disconnectDatabase());
