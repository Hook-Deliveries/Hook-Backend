import { Request, Response } from 'express';
import { publishConfigChanged } from '@modules/platform/realtime.service';
import { CouponService } from '@services/coupon.service';
import { User } from '@models/users/user.model';
import { sendCreated, sendSuccess } from '@utils/http';
import { actor, adminRepos, getPagination, paginated, routeParam } from './admin.helpers';

export class AdminCouponsController {
  private readonly coupons = new CouponService();

  private audit = async (req: Request, action: string, resourceId: string, details: string) => {
    const auditLogs = adminRepos.auditLogs();
    await auditLogs.save(auditLogs.create({
      action,
      resourceType: 'coupon',
      resourceId,
      details,
      status: 'success',
      ...actor(req),
    }));
  };

  list = async (_req: Request, res: Response) => {
    const data = await this.coupons.list();
    sendSuccess(res, { data, total: data.length });
  };

  detail = async (req: Request, res: Response) => {
    sendSuccess(res, await this.coupons.get(routeParam(req.params.id)));
  };

  /** Who used this coupon, when, and on which order. */
  redemptions = async (req: Request, res: Response) => {
    const { skip, page, limit } = getPagination(req.query);
    const { data, total } = await this.coupons.redemptions(routeParam(req.params.id), { skip, take: limit });

    const userIds = [...new Set(data.map((row) => row.userId).filter(Boolean))];
    const users = userIds.length
      ? await User.find({ _id: { $in: userIds } }).select('_id firstName lastName email').lean()
      : [];
    const byId = new Map(users.map((user) => [String(user._id), user]));

    sendSuccess(res, paginated(
      data.map((row) => {
        const user = byId.get(String(row.userId));
        return {
          ...row,
          customer: user
            ? { name: `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'Hook customer', email: user.email }
            : undefined,
        };
      }),
      total,
      page,
      limit,
    ));
  };

  create = async (req: Request, res: Response) => {
    const { reason, ...input } = req.body;
    const coupon: any = await this.coupons.create(input, req.user!.sub);
    await this.audit(req, 'coupon.create', String(coupon.publicId || coupon.id), reason);
    publishConfigChanged('coupons');
    sendCreated(res, coupon);
  };

  update = async (req: Request, res: Response) => {
    const { reason, ...input } = req.body;
    const coupon: any = await this.coupons.update(routeParam(req.params.id), input);
    await this.audit(req, 'coupon.update', String(coupon?.publicId || coupon?.id), reason);
    publishConfigChanged('coupons');
    sendSuccess(res, coupon);
  };

  remove = async (req: Request, res: Response) => {
    const result = await this.coupons.remove(routeParam(req.params.id));
    await this.audit(req, 'coupon.delete', result.id, `Removed coupon ${result.id}`);
    publishConfigChanged('coupons');
    sendSuccess(res, result);
  };
}
