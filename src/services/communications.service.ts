import { randomUUID } from 'crypto';
import { AccountType } from '@lib/constants';
import { User } from '@models/users/user.model';
import { StaffProfile, MarketAssociateProfile } from '@models/platform/operations-accounts.model';
import { Role } from '@models/platform/access.model';
import { DeviceToken } from '@models/notifications/device-token.model';
import { Notification } from '@models/notifications/notification.model';
import { Broadcast } from '@models/notifications/broadcast.model';
import { EmailService } from '@emails/email.service';
import { sendPushMessages } from '@services/push.service';
import { nextPublicId } from '@modules/platform/public-id.service';
import { HttpError } from '@utils/http';

export type CommunicationsAudience =
  | { segment: 'customers' }
  | { segment: 'market_associates'; stateIds?: string[] }
  | { segment: 'staff'; roleKey?: string }
  | { userIds: string[] };

export type CommunicationsChannel = 'push' | 'email' | 'inbox';

export class CommunicationsService {
  private email = new EmailService();

  /** The only place an audience filter turns into an actual list of accounts. */
  async resolveAudience(audience: CommunicationsAudience) {
    if ('userIds' in audience) {
      return User.find({ _id: { $in: audience.userIds } }).select('_id email firstName lastName').lean();
    }
    if (audience.segment === 'customers') {
      return User.find({ accountType: AccountType.CUSTOMER }).select('_id email firstName lastName').lean();
    }
    if (audience.segment === 'market_associates') {
      const filter: Record<string, unknown> = {};
      if (audience.stateIds?.length) filter.stateIds = { $in: audience.stateIds };
      const profiles = await MarketAssociateProfile.find(filter).select('accountId').lean();
      const accountIds = profiles.map((profile) => profile.accountId);
      return User.find({ _id: { $in: accountIds } }).select('_id email firstName lastName').lean();
    }
    if (audience.segment === 'staff') {
      const filter: Record<string, unknown> = {};
      if (audience.roleKey) {
        const role = await Role.findOne({ key: audience.roleKey }).select('_id').lean();
        if (!role) return [];
        filter.roleIds = String(role._id);
      }
      const profiles = await StaffProfile.find(filter).select('accountId').lean();
      const accountIds = profiles.map((profile) => profile.accountId);
      return User.find({ _id: { $in: accountIds } }).select('_id email firstName lastName').lean();
    }
    throw new HttpError(400, 'Unrecognized audience', undefined, 'VALIDATION_ERROR');
  }

  async preview(audience: CommunicationsAudience) {
    const recipients = await this.resolveAudience(audience);
    const sample = recipients.slice(0, 5).map((recipient) => ({
      name: `${recipient.firstName || ''} ${recipient.lastName || ''}`.trim() || recipient.email,
      email: recipient.email,
    }));
    return { recipientCount: recipients.length, sample };
  }

  /** Search across every account type, for the "specific people" audience picker. */
  async searchAccounts(term: string) {
    const expression = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const accounts = await User.find({ $or: [{ email: expression }, { firstName: expression }, { lastName: expression }] })
      .select('_id publicId email firstName lastName accountType')
      .limit(10)
      .lean();
    // resolveAudience's userIds branch matches on Mongo _id — return it as an explicit
    // string rather than relying on the client to serialize the raw ObjectId itself.
    return accounts.map((account) => ({ ...account, _id: String(account._id) }));
  }

  /**
   * Resolves the audience once, then fans out to whichever channels were
   * chosen. Deliberately does not loop the per-user createCommerceNotification
   * helper — at broadcast scale that would be an N+1 device-token query. This
   * bulk-inserts Notification rows and batch-fetches every device token in
   * one query instead.
   */
  async send(input: { title: string; body: string; channels: CommunicationsChannel[]; audience: CommunicationsAudience; senderUserId: string }) {
    const recipients = await this.resolveAudience(input.audience);
    if (!recipients.length) throw new HttpError(400, 'No accounts matched this audience', undefined, 'VALIDATION_ERROR');
    const broadcastId = randomUUID();

    if (input.channels.includes('inbox') || input.channels.includes('push')) {
      const docs = recipients.map((recipient) => ({
        userId: String(recipient._id),
        title: input.title,
        body: input.body,
        type: 'admin_broadcast',
        eventKey: `broadcast:${broadcastId}:${recipient._id}`,
      }));
      await Notification.insertMany(docs, { ordered: false }).catch(() => undefined);

      if (input.channels.includes('push')) {
        const devices = await DeviceToken.find({ userId: { $in: recipients.map((recipient) => String(recipient._id)) }, isActive: true })
          .select('expoPushToken')
          .lean();
        await sendPushMessages(devices.map((device) => ({
          to: device.expoPushToken,
          title: input.title,
          body: input.body,
          data: { type: 'admin_broadcast', group: 'account', screen: 'notifications' },
        })));
      }
    }

    if (input.channels.includes('email')) {
      const BATCH_SIZE = 20;
      for (let index = 0; index < recipients.length; index += BATCH_SIZE) {
        const batch = recipients.slice(index, index + BATCH_SIZE);
        await Promise.allSettled(batch.map((recipient) => this.email.sendBroadcastMessage({
          email: recipient.email,
          name: recipient.firstName,
          subject: input.title,
          message: input.body,
        })));
      }
    }

    await Broadcast.create({
      publicId: await nextPublicId('broadcast'),
      title: input.title,
      body: input.body,
      channels: input.channels,
      audience: input.audience,
      recipientCount: recipients.length,
      sentByUserId: input.senderUserId,
      sentAt: new Date(),
    });

    return { recipientCount: recipients.length, channels: input.channels };
  }

  async list(input: { skip: number; limit: number }) {
    const [data, total] = await Promise.all([
      Broadcast.find({ deletedAt: { $exists: false } }).sort({ sentAt: -1 }).skip(input.skip).limit(input.limit).lean(),
      Broadcast.countDocuments({ deletedAt: { $exists: false } }),
    ]);
    return { data, total };
  }

  /** Removes a send from the history list. Does not recall or unsend anything already delivered. */
  async deleteFromHistory(publicId: string) {
    const result = await Broadcast.updateOne({ publicId, deletedAt: { $exists: false } }, { $set: { deletedAt: new Date() } });
    if (!result.matchedCount) throw new HttpError(404, 'This send is not in the history', undefined, 'NOT_FOUND');
  }
}
