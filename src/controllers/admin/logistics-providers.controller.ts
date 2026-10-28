import { Request, Response } from 'express';
import { publishConfigChanged } from '@modules/platform/realtime.service';
import { LogisticsProviderService } from '@modules/fulfilment/logistics-provider.service';
import { sendCreated, sendSuccess } from '@utils/http';
import { actor, adminRepos, routeParam } from './admin.helpers';

export class AdminLogisticsProvidersController {
  private readonly providers = new LogisticsProviderService();

  private audit = async (req: Request, action: string, resourceId: string, details: string) => {
    const auditLogs = adminRepos.auditLogs();
    await auditLogs.save(auditLogs.create({
      action,
      resourceType: 'logistics_provider',
      resourceId,
      details,
      status: 'success',
      ...actor(req),
    }));
  };

  list = async (_req: Request, res: Response) => {
    const data = await this.providers.list();
    sendSuccess(res, { data, total: data.length });
  };

  detail = async (req: Request, res: Response) => {
    sendSuccess(res, await this.providers.get(routeParam(req.params.id)));
  };

  create = async (req: Request, res: Response) => {
    const { reason, ...input } = req.body;
    const provider: any = await this.providers.create(input, req.user!.sub);
    await this.audit(req, 'logistics_provider.create', String(provider.publicId || provider.id), reason || `Created logistics provider "${provider.name}"`);
    publishConfigChanged('logistics');
    sendCreated(res, provider);
  };

  update = async (req: Request, res: Response) => {
    const { reason, ...input } = req.body;
    const provider: any = await this.providers.update(routeParam(req.params.id), input);
    await this.audit(req, 'logistics_provider.update', String(provider?.publicId || provider?.id), reason || `Updated logistics provider "${provider?.name}"`);
    publishConfigChanged('logistics');
    sendSuccess(res, provider);
  };

  remove = async (req: Request, res: Response) => {
    const result = await this.providers.remove(routeParam(req.params.id));
    await this.audit(req, 'logistics_provider.delete', result.id, `Removed logistics provider ${result.id}`);
    publishConfigChanged('logistics');
    sendSuccess(res, result);
  };
}
