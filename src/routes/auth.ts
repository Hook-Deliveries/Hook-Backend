import { Router } from 'express';
import { z } from 'zod';
import { AuthController } from '@controllers/auth.controller';
import { requireAuth } from '@middleware/auth';
import { validateBody } from '@middleware/validate';
import {
  changePasswordSchema,
  loginSchema,
  passwordResetRequestSchema,
  passwordResetSchema,
  profileSchema,
  registerSchema,
} from '@validations/common.schemas';
import { asyncHandler, sendSuccess } from '@utils/http';
import { acceptAccountInvitation } from '@modules/identity/account-invitation.service';

const deviceMetadataFields = {
  deviceId: z.string().trim().min(1).max(120).optional(),
  deviceName: z.string().trim().min(1).max(120).optional(),
  platform: z.string().trim().min(1).max(40).optional(),
};

/** Optional on every path that can mint a brand-new customer account. */
const referralCodeField = { referralCode: z.string().trim().min(4).max(20).optional() };

const otpSchema = z.object({ email: z.string().email(), code: z.string().min(4), ...deviceMetadataFields });
const refreshSchema = z.object({ refreshToken: z.string().min(1) });
const logoutSchema = z.object({ refreshToken: z.string().min(1).optional() });
const lookupSchema = z.object({ email: z.string().email() });
const signupStartSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});
const signupVerifySchema = z.object({
  signupSessionToken: z.string().min(32),
  code: z.string().min(4),
});
const signupCompleteSchema = z.object({
  signupSessionToken: z.string().min(32),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  phone: z.string().min(6).optional(),
  avatarUrl: z.string().url().optional(),
  address: z.record(z.string(), z.unknown()).optional(),
  preferences: z.record(z.string(), z.unknown()).optional(),
  ...deviceMetadataFields,
  ...referralCodeField,
});
const passwordVerifySchema = z.object({ email: z.string().email(), code: z.string().min(4) });
const googleAuthSchema = z.object({
  idToken: z.string().min(20),
  ...deviceMetadataFields,
  ...referralCodeField,
});
const appleAuthSchema = z.object({
  identityToken: z.string().min(20),
  firstName: z.string().trim().max(80).optional(),
  lastName: z.string().trim().max(80).optional(),
  ...deviceMetadataFields,
  ...referralCodeField,
});

export function createAuthRouter() {
  const router = Router();
  const controller = new AuthController();

  router.post('/lookup', validateBody(lookupSchema), asyncHandler(controller.lookup));
  router.post('/signup/start', validateBody(signupStartSchema), asyncHandler(controller.startSignup));
  router.post('/signup/verify', validateBody(signupVerifySchema), asyncHandler(controller.verifySignup));
  router.post('/signup/resend', validateBody(z.object({ signupSessionToken: z.string().min(32) })), asyncHandler(controller.resendSignupCode));
  router.post('/signup/complete', validateBody(signupCompleteSchema), asyncHandler(controller.completeSignup));
  router.post('/register', validateBody(registerSchema), asyncHandler(controller.register));
  router.post('/login', validateBody(loginSchema), asyncHandler(controller.login));
  router.post('/google', validateBody(googleAuthSchema), asyncHandler(controller.googleLogin));
  router.post('/apple', validateBody(appleAuthSchema), asyncHandler(controller.appleLogin));
  router.post('/invitations/accept', validateBody(z.object({
    token: z.string().min(32),
    password: z.string().min(9).max(128),
  })), asyncHandler(async (req, res) => {
    const result = await acceptAccountInvitation(req.body.token, req.body.password, {
      requestId: req.requestId,
      ipAddress: req.ip,
      userAgent: req.header('user-agent'),
    });
    sendSuccess(res, result);
  }));
  router.post('/verify-otp', validateBody(otpSchema), asyncHandler(controller.verifyOtp));
  router.post('/refresh', validateBody(refreshSchema), asyncHandler(controller.refresh));
  router.post('/logout', validateBody(logoutSchema), asyncHandler(controller.logout));
  router.post('/password/forgot', validateBody(passwordResetRequestSchema), asyncHandler(controller.requestPasswordReset));
  router.post('/password/verify', validateBody(passwordVerifySchema), asyncHandler(controller.verifyPasswordReset));
  router.post('/password/reset', validateBody(passwordResetSchema), asyncHandler(controller.resetPassword));
  router.get('/profile', requireAuth, asyncHandler(controller.profile));
  router.patch('/profile', requireAuth, validateBody(profileSchema), asyncHandler(controller.updateProfile));
  router.post('/complete-profile', requireAuth, validateBody(profileSchema), asyncHandler(controller.completeProfile));
  router.post('/password/change', requireAuth, validateBody(changePasswordSchema), asyncHandler(controller.changePassword));

  return router;
}
