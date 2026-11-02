import { connectDatabase, disconnectDatabase } from '@config/data-source';
import { Notification } from '@models/notifications/notification.model';
import { User } from '@models/users/user.model';

const execute = process.argv.includes('--execute');
const EMAIL = process.argv.find((arg) => arg.includes('@')) || 'muhammedabiodun42@gmail.com';

/**
 * Clears one customer's notification history. Used after wiping their orders,
 * since the notifications left behind reference orders that no longer exist.
 */
async function main() {
  await connectDatabase();

  const user = await User.findOne({ email: EMAIL }).lean();
  if (!user) {
    console.log(`No account found for ${EMAIL}. Nothing to do.`);
    return;
  }
  const userId = String(user._id);

  const rows = await Notification.find({ userId })
    .select('type title createdAt')
    .sort({ createdAt: -1 })
    .lean();

  if (!rows.length) {
    console.log(`${EMAIL} has no notifications. Nothing to do.`);
    return;
  }

  console.log(`${EMAIL} — ${rows.length} notification(s):`);
  for (const row of rows) console.log(`  [${row.type}] ${row.title}`);

  if (execute) {
    const result = await Notification.deleteMany({ userId });
    console.log(`\nDeleted ${result.deletedCount} notification(s).`);
  } else {
    console.log(`\nWould delete ${rows.length} notification(s).`);
    console.log('No data changed. Run with --execute to apply.');
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase());
