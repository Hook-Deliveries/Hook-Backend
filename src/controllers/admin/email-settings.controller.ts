import { Request, Response } from "express";
import { getEmailSettings } from "@services/email-settings.service";
import { EmailSettings } from "@models/platform/email-settings.model";
import { recordAudit } from "@modules/platform/platform-audit.service";
import { clearEmailSettingsCache } from "@services/email-settings.service";
import { sendSuccess } from "@utils/http";

export class AdminEmailSettingsController {
  // Support address alone, for any signed-in staff member.
  supportContact = async (_req: Request, res: Response) => {
    const settings = await getEmailSettings();
    sendSuccess(res, { supportEmail: settings.supportEmail });
  };

  get = async (_req: Request, res: Response) => {
    const [settings, resolved] = await Promise.all([
      EmailSettings.findOne({ key: "email" }).lean(),
      getEmailSettings(),
    ]);
    sendSuccess(res, {
      supportEmail: settings?.supportEmail || "",
      hookOpsEmail: settings?.hookOpsEmail || "",
      appName: settings?.appName || "",
      appUrl: settings?.appUrl || "",
      supportUrl: settings?.supportUrl || "",
      // Read-only: sender identity is env-configured only (BREVO_FROM_EMAIL / BREVO_FROM_NAME).
      brevoFromEmail: resolved.brevoFromEmail || "",
      brevoFromName: resolved.brevoFromName,
      updatedAt: settings?.updatedAt,
    });
  };

  update = async (req: Request, res: Response) => {
    const { reason, ...fields } = req.body;
    const updated = await EmailSettings.findOneAndUpdate(
      { key: "email" },
      { $set: { ...fields, updatedBy: req.user!.sub } },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
    ).lean();
    clearEmailSettingsCache();
    await recordAudit(req, {
      action: "email_settings.update",
      entityType: "email_settings",
      after: fields,
      reason,
    });
    const resolved = await getEmailSettings();
    sendSuccess(res, {
      supportEmail: updated?.supportEmail || "",
      hookOpsEmail: updated?.hookOpsEmail || "",
      appName: updated?.appName || "",
      appUrl: updated?.appUrl || "",
      supportUrl: updated?.supportUrl || "",
      brevoFromEmail: resolved.brevoFromEmail || "",
      brevoFromName: resolved.brevoFromName,
      updatedAt: updated?.updatedAt,
    });
  };
}
