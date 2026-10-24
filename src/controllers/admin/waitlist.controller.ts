import { Request, Response } from 'express';
import { WaitlistService } from '@modules/notifications/waitlist.service';
import { sendSuccess } from '@utils/http';
import { actor, adminRepos, getPagination, paginated } from './admin.helpers';

export class AdminWaitlistController {
  private readonly waitlist = new WaitlistService();

  private audit = async (req: Request, action: string, resourceId: string, details: string) => {
    const auditLogs = adminRepos.auditLogs();
    await auditLogs.save(auditLogs.create({
      action,
      resourceType: 'waitlist',
      resourceId,
      details,
      status: 'success',
      ...actor(req),
    }));
  };

  list = async (req: Request, res: Response) => {
    const { skip, page, limit } = getPagination(req.query);
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    const { data, total, redeemed } = await this.waitlist.list({ search, skip, limit });
    sendSuccess(res, { ...paginated(data, total, page, limit), redeemed });
  };

  remove = async (req: Request, res: Response) => {
    const id = String(req.params.id);
    await this.waitlist.remove(id);
    await this.audit(req, 'waitlist.remove', id, `Removed waitlist entry ${id}`);
    sendSuccess(res, { removed: true });
  };

  broadcast = async (req: Request, res: Response) => {
    const result = await this.waitlist.broadcast(req.body);
    await this.audit(req, 'waitlist.broadcast', 'waitlist', `Sent "${req.body.subject}" to ${result.sent} recipient(s), ${result.failed} failed`);
    sendSuccess(res, result);
  };

  gift = async (req: Request, res: Response) => {
    const result = await this.waitlist.gift({ ...req.body, actorId: req.user!.sub });
    await this.audit(req, 'waitlist.gift', 'waitlist', `Gifted credit: ${result.grantedNow} immediately, ${result.pendingForSignup} queued for signup — ${req.body.reason}`);
    sendSuccess(res, result);
  };
}
