import { connectDatabase, disconnectDatabase } from '@config/data-source';
import { Consolidation, FulfilmentTask, HubPackage, Shipment } from '@models/fulfilment/fulfilment.model';
import { OrderItem } from '@models/orders/order-item.model';
import { FulfilmentTaskStatus, HubPackageStatus } from '@lib/constants';

const execute = process.argv.includes('--execute');

/**
 * Moves existing data onto the hub-receive → ship flow (no QC, consolidate or seal):
 *
 *  1. Drops the unique { orderId, fulfilmentGroupId } index on shipments. An order can now ship in
 *     several shipments, and a cancelled one is booked again.
 *  2. Shipments booked the old way get the hub packages they carried (hubPackageIds), and those
 *     packages are marked SHIPPED.
 *  3. Packages still waiting for QC, or consolidated but never shipped, become ready to ship.
 *     Their open consolidations are cancelled.
 *
 * Dry run by default; pass --execute to write.
 */
async function main() {
  await connectDatabase();
  console.log(execute ? 'Applying shipping-flow migration\n' : 'Dry run (no data changed)\n');

  // 1. Index
  const indexes = await Shipment.collection.indexes();
  const stale = indexes.find((index) => JSON.stringify(index.key) === JSON.stringify({ orderId: 1, fulfilmentGroupId: 1 }) && index.unique);
  if (stale) {
    console.log(`  shipments: ${execute ? 'dropping' : 'would drop'} unique index "${stale.name}"`);
    if (execute) {
      await Shipment.collection.dropIndex(stale.name!);
      await Shipment.collection.createIndex({ orderId: 1, fulfilmentGroupId: 1 });
    }
  } else {
    console.log('  shipments: unique { orderId, fulfilmentGroupId } index not present — nothing to drop');
  }

  // 2. Backfill shipments that predate hubPackageIds
  const legacy = await Shipment.find({ consolidationId: { $exists: true }, hubPackageIds: { $exists: false } }).lean() as any[];
  console.log(`\n  ${legacy.length} shipment(s) booked the old way`);
  for (const shipment of legacy) {
    const consolidation = await Consolidation.findById(shipment.consolidationId).select('hubPackageIds').lean() as any;
    const packages = consolidation?.hubPackageIds?.length ? await HubPackage.find({ _id: { $in: consolidation.hubPackageIds } }).select('publicId').lean() as any[] : [];
    console.log(`    ${shipment.publicId}: ${packages.length} package(s)`);
    if (!execute || !packages.length) continue;
    await Shipment.updateOne({ _id: shipment._id }, { $set: { hubPackageIds: packages.map((pack) => pack.publicId) } });
    if (shipment.status !== 'CANCELLED') await HubPackage.updateMany({ _id: { $in: packages.map((pack) => pack._id) } }, { $set: { status: HubPackageStatus.SHIPPED, shipmentId: shipment.publicId } });
  }

  // 3. Packages stuck behind the removed steps
  const shippedConsolidations = new Set((await Shipment.find({ consolidationId: { $exists: true } }).select('consolidationId').lean() as any[]).map((entry) => String(entry.consolidationId)));
  const stuck = await HubPackage.find({ status: { $in: [HubPackageStatus.RECEIVED, HubPackageStatus.QC_PENDING, HubPackageStatus.CONSOLIDATED] } }).lean() as any[];
  const ready: any[] = [];
  for (const pack of stuck) {
    if (pack.status === HubPackageStatus.CONSOLIDATED) {
      const consolidation = await Consolidation.findOne({ hubPackageIds: String(pack._id) }).select('status').lean() as any;
      if (consolidation && shippedConsolidations.has(String(consolidation._id))) continue;
    }
    ready.push(pack);
  }
  console.log(`\n  ${ready.length} package(s) to make ready to ship`);
  if (execute && ready.length) {
    const ids = ready.map((pack) => pack._id);
    await HubPackage.updateMany({ _id: { $in: ids } }, { $set: { status: HubPackageStatus.QC_PASSED, qcPassedAt: new Date() } });
    await FulfilmentTask.updateMany({ _id: { $in: ready.map((pack) => pack.taskId) } }, { $set: { status: FulfilmentTaskStatus.QC_PASSED } });
    await OrderItem.updateMany({ _id: { $in: ready.flatMap((pack) => pack.itemIds) } }, { $set: { fulfilmentStatus: 'QC_PASSED' } });
    await Consolidation.updateMany({ hubPackageIds: { $in: ids.map(String) }, status: { $in: ['DRAFT', 'SEALED'] }, _id: { $nin: [...shippedConsolidations] } }, { $set: { status: 'CANCELLED' } });
  }

  if (!execute) console.log('\nNo data changed. Run with --execute to apply.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase());
