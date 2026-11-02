import { Request, Response } from 'express';
import { AccountDeletionService } from '@modules/identity/account-deletion.service';
import { sendSuccess } from '@utils/http';

/**
 * Public entry points for account deletion, used by the web page. The app opens that page instead of handling deletion itself.
 */
export class AccountDeletionController {
  private readonly deletions = new AccountDeletionService();

  /** POST /public/account-deletion/code: always the same answer, whether or not the email exists. */
  sendCode = async (req: Request, res: Response) => {
    await this.deletions.sendCode(req.body.email).catch((error) => {
      console.error('[account-deletion] could not send code', error instanceof Error ? error.message : error);
    });
    res.status(202);
    sendSuccess(res, { sent: true }, 'If a Google or Apple account exists for this email, a code is on its way.');
  };

  request = async (req: Request, res: Response) => {
    const { email, password, code, reason } = req.body;
    const user = await this.deletions.verifyOwner(email, { password, code });
    sendSuccess(res, await this.deletions.request(user, { reason, source: 'web' }));
  };

  status = async (req: Request, res: Response) => {
    const { email, password, code } = req.body;
    const user = await this.deletions.verifyOwner(email, { password, code });
    sendSuccess(res, await this.deletions.status(user));
  };

  cancel = async (req: Request, res: Response) => {
    if (req.body.token) return sendSuccess(res, await this.deletions.cancel({ token: req.body.token }));
    const { email, password, code } = req.body;
    const user = await this.deletions.verifyOwner(email, { password, code });
    sendSuccess(res, await this.deletions.cancel({ user }));
  };
}
