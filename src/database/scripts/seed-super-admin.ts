import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { connectDatabase, disconnectDatabase } from '@config/data-source';
import { AccountStatus, AccountType, ScopeType, UserRole } from '@lib/constants';
import { hashPassword } from '@lib/security';
import { Role } from '@models/platform/access.model';
import { StaffProfile } from '@models/platform/operations-accounts.model';
import { User } from '@models/users/user.model';
import { ensurePlatformAccessCatalog } from '@modules/platform/platform-bootstrap.service';
import { nextPublicId } from '@modules/platform/public-id.service';

// Creates only the super admin and never clears anything, so it is safe on a live database.
// Password: SUPER_ADMIN_PASSWORD if set, otherwise a strong random one saved to .super-admin-credentials.
const EMAIL = (process.env.SUPER_ADMIN_EMAIL || 'admin@gmail.com').toLowerCase().trim();
const PHONE = process.env.SUPER_ADMIN_PHONE || '+2348000000000';

async function main() {
  await connectDatabase();
  if (await User.exists({ email: EMAIL })) {
    console.log(`  skip — ${EMAIL} already exists`);
    return;
  }
  await ensurePlatformAccessCatalog();
  const role = await Role.findOne({ key: 'SUPER_ADMIN', isActive: true }).lean();
  if (!role) throw new Error('SUPER_ADMIN role was not found');

  const generated = !process.env.SUPER_ADMIN_PASSWORD;
  const password = process.env.SUPER_ADMIN_PASSWORD || crypto.randomBytes(18).toString('base64url');
  const user = await User.create({
    publicId: await nextPublicId('staff'),
    email: EMAIL,
    phone: PHONE,
    password: await hashPassword(password),
    firstName: process.env.SUPER_ADMIN_FIRST_NAME || 'Hook',
    lastName: process.env.SUPER_ADMIN_LAST_NAME || 'Admin',
    role: UserRole.SUPER_ADMIN,
    accountType: AccountType.STAFF,
    accountStatus: AccountStatus.ACTIVE,
    roleIds: [String(role._id)],
    scopeType: ScopeType.GLOBAL,
    assignedStateIds: [],
    assignedHubIds: [],
    permissions: role.permissionKeys,
    isActive: true,
    isEmailVerified: true,
    isPhoneVerified: true,
    passwordChangedAt: new Date(),
  });
  await StaffProfile.create({
    publicId: user.publicId,
    accountId: String(user.id || user._id),
    roleIds: [String(role._id)],
    scopeType: ScopeType.GLOBAL,
    stateIds: [],
    hubIds: [],
    status: 'active',
  });
  console.log(`  created — ${EMAIL} (${user.publicId})`);
  if (generated) {
    const file = path.resolve(process.cwd(), '.super-admin-credentials');
    fs.writeFileSync(file, `email: ${EMAIL}\npassword: ${password}\n`, { mode: 0o600 });
    console.log(`  password saved to ${file}`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void disconnectDatabase());
