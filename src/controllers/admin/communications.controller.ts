import { Request, Response } from 'express';
import { CommunicationsService } from '@modules/notifications/communications.service';
import { sendSuccess } from '@utils/http';
import { actor, adminRepos, getPagination, paginated } from './admin.helpers';
import { routeParam } from '@lib/api-utils';

export class AdminCommunicationsController {
  private readonly communications = new CommunicationsService();

  private audit = async (req: Request, action: string, details: string) => {
    const auditLogs = adminRepos.auditLogs();
    await auditLogs.save(auditLogs.create({
      action,
      resourceType: 'communications',
      resourceId: 'broadcast',
      details,
      status: 'success',
      ...actor(req),
    }));
  };

  preview = async (req: Request, res: Response) => {
    const result = await this.communications.preview(req.body.audience);
    sendSuccess(res, result);
  };

  searchUsers = async (req: Request, res: Response) => {
    const term = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const results = term.length >= 2 ? await this.communications.searchAccounts(term) : [];
    sendSuccess(res, results);
  };

  send = async (req: Request, res: Response) => {
    const result = await this.communications.send({
      title: req.body.title,
      body: req.body.body,
      channels: req.body.channels,
      audience: req.body.audience,
      senderUserId: req.user!.sub,
    });
    await this.audit(req, 'communications.send', `Sent "${req.body.title}" to ${result.recipientCount} recipient(s) via ${result.channels.join(', ')}`);
    sendSuccess(res, result);
  };

  list = async (req: Request, res: Response) => {
    const { skip, page, limit } = getPagination(req.query);
    const { data, total } = await this.communications.list({ skip, limit });
    sendSuccess(res, paginated(data, total, page, limit));
  };

  remove = async (req: Request, res: Response) => {
    await this.communications.deleteFromHistory(routeParam(req.params.id));
    await this.audit(req, 'communications.history_deleted', `Removed a broadcast from the send history`);
    sendSuccess(res, { deleted: true });
  };
}
