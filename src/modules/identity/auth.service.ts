import type { MongoRepository as Repository } from '@lib/mongo-repository';
import { createHash, randomBytes } from 'crypto';
import { AccountStatus, AccountType, ScopeType, UserRole } from '@lib/constants';
import { comparePassword, hashPassword } from '@lib/security';
import { AccountDeletionService } from '@modules/identity/account-deletion.service';
import { EmailService } from '@emails/email.service';
import { Otp } from '@models/auth/otp.model';
import { SignupSession } from '@models/auth/signup-session.model';
import { Cart } from '@models/cart/cart.model';
import { DeviceToken } from '@models/notifications/device-token.model';
import { Notification } from '@models/notifications/notification.model';
import { Order } from '@models/orders/order.model';
import { User } from '@models/users/user.model';
import { NotificationService } from '@modules/notifications';
import { HttpError } from '@utils/http';
import { verifyGoogleIdToken } from '@modules/identity/google-auth.service';
import { verifyAppleIdentityToken } from '@modules/identity/apple-auth.service';
import {
  issueAccountSession,
  presentAccountUser,
  revokeAccountSession,
  revokeAccountSessions,
  rotateAccountSession,
  type SessionMetadata,
} from '@modules/identity/account-session.service';
import { nextPublicId } from '@modules/platform';
import { ReferralService } from '@modules/orders';
import { CreditService } from '@modules/orders';

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export class AuthService {
  private readonly notifications?: NotificationService;
  private referralsInstance?: ReferralService;
  private get referrals() {
    return (this.referralsInstance ??= new ReferralService());
  }
  private creditsInstance?: CreditService;
  private get credits() {
    return (this.creditsInstance ??= new CreditService());
  }

  constructor(
    private readonly userRepo: Repository<User>,
    private readonly otpRepo?: Repository<Otp>,
    private readonly email = new EmailService(),
    private readonly signupSessions?: Repository<SignupSession>,
    private readonly carts?: Repository<Cart>,
    private readonly orders?: Repository<Order>,
    deviceTokens?: Repository<DeviceToken>,
    notifications?: Repository<Notification>,
  ) {
    if (deviceTokens && notifications) {
      this.notifications = new NotificationService(deviceTokens, notifications);
    }
  }

  async lookup(email: string) {
    const normalizedEmail = email.toLowerCase().trim();
    const existing = await this.userRepo.findOne({ where: { email: normalizedEmail } });
    if (existing) {
      return {
        email: normalizedEmail,
        exists: true,
        nextStep: 'password',
        message: 'Continue with your password.',
      };
    }

    const session = await this.signupSessions?.findOne({
      where: { email: normalizedEmail },
      order: { createdAt: 'DESC' },
    });

    if (session && new Date(session.expiresAt) > new Date()) {
      return {
        email: normalizedEmail,
        exists: false,
        nextStep: session.isEmailVerified ? 'complete_profile' : 'verify_email',
        signupSessionToken: undefined,
        message: 'Continue creating your account.',
      };
    }

    return {
      email: normalizedEmail,
      exists: false,
      nextStep: 'create_password',
      message: 'Create a password to continue.',
    };
  }

  async login(email: string, password: string, portal: 'customer' | 'staff' | 'auto' = 'auto', metadata?: SessionMetadata) {
    const normalizedEmail = email.toLowerCase().trim();
    const user = await this.userRepo.findOne({
      where: { email: normalizedEmail },
      select: {
        id: true,
        email: true,
        password: true,
        role: true,
        firstName: true,
        lastName: true,
        isActive: true,
        isEmailVerified: true,
        avatarUrl: true,
        publicId: true,
        accountType: true,
        accountStatus: true,
      },
    });

    if (!user?.password || !(await comparePassword(password, user.password))) {
      throw new HttpError(401, 'Invalid email or password');
    }

    const isCustomerAccount = user.accountType
      ? user.accountType === AccountType.CUSTOMER
      : user.role === UserRole.SHOPPER;
    const customerLogin = portal === 'customer'
      || (portal === 'auto' && isCustomerAccount);
    if (customerLogin && user.accountType && user.accountType !== AccountType.CUSTOMER) {
      throw new HttpError(403, 'Use the Hook staff portal to sign in to this account', undefined, 'ACCOUNT_PORTAL_MISMATCH');
    }
    if (customerLogin && !user.accountType && user.role !== UserRole.SHOPPER) {
      throw new HttpError(403, 'Use the Hook staff portal to sign in to this account', undefined, 'ACCOUNT_PORTAL_MISMATCH');
    }
    if (!customerLogin && (user.accountType === AccountType.CUSTOMER || (!user.accountType && user.role === UserRole.SHOPPER))) {
      throw new HttpError(403, 'Use the Hook mobile app to sign in to this customer account', undefined, 'ACCOUNT_PORTAL_MISMATCH');
    }
    if (customerLogin) user.accountType = AccountType.CUSTOMER;

    if (!user.isActive) {
      throw new HttpError(401, 'Account not activated. Complete your profile first.');
    }
    if (user.accountStatus === 'pending_password') {
      throw new HttpError(403, 'Set your password from the email sent after checkout before signing in');
    }
    if (user.accountStatus && user.accountStatus !== AccountStatus.ACTIVE) {
      await this.rejectUnavailable(user);
    }

    user.lastLoginAt = new Date();
    const response = await this.buildAuthResponse(user, metadata);
    await this.userRepo.update(user.id, {
      lastLoginAt: user.lastLoginAt,
      refreshToken: undefined,
    });
    return response;
  }

  async loginWithGoogle(input: { idToken: string; referralCode?: string }, metadata?: SessionMetadata) {
    const payload = await verifyGoogleIdToken(input.idToken);
    const email = payload.email!.toLowerCase().trim();
    const firstName = payload.given_name || '';
    const lastName = payload.family_name || '';
    const avatarUrl = payload.picture;

    let user = await this.userRepo.findOne({ where: [{ email }, { googleId: payload.sub }] });
    const isNewUser = !user;

    if (user) {
      if (user.accountType && user.accountType !== AccountType.CUSTOMER) {
        throw new HttpError(403, 'Use the Hook staff portal to sign in to this account', undefined, 'ACCOUNT_PORTAL_MISMATCH');
      }
      if (!user.accountType && user.role !== UserRole.SHOPPER) {
        throw new HttpError(403, 'Use the Hook staff portal to sign in to this account', undefined, 'ACCOUNT_PORTAL_MISMATCH');
      }
      user.accountType = AccountType.CUSTOMER;
      if (!user.isActive || (user.accountStatus && user.accountStatus !== AccountStatus.ACTIVE)) {
        await this.rejectUnavailable(user);
      }
      user.googleId = user.googleId || payload.sub;
      user.email = user.email || email;
      user.authProvider = user.authProvider === 'google' ? 'google' : user.authProvider || 'password';
      user.firstName = user.firstName || firstName;
      user.lastName = user.lastName || lastName;
      user.avatarUrl = user.avatarUrl || avatarUrl;
      user.isEmailVerified = true;
      user.lastLoginAt = new Date();
      await this.userRepo.save(user);
    } else {
      user = await this.userRepo.save(this.userRepo.create({
        publicId: await nextPublicId('customer'),
        accountType: AccountType.CUSTOMER,
        accountStatus: AccountStatus.ACTIVE,
        scopeType: ScopeType.SELF,
        email,
        password: undefined,
        authProvider: 'google',
        googleId: payload.sub,
        firstName,
        lastName,
        avatarUrl,
        role: UserRole.SHOPPER,
        isActive: true,
        isEmailVerified: true,
        isPhoneVerified: false,
        lastLoginAt: new Date(),
      }));
    }

    if (!user) throw new HttpError(401, 'Google sign-in could not be completed');
    const authUser = user;
    const response = await this.buildAuthResponse(authUser, metadata);
    await Promise.all([
      this.userRepo.update(authUser.id, { refreshToken: undefined, lastLoginAt: new Date() }),
    ]);

    if (isNewUser) {
      await this.credits.grantWelcomeBonus(authUser.id).catch(() => undefined);
      if (input.referralCode) await this.referrals.applyCode(input.referralCode, authUser.id);
    }

    const name = `${authUser.firstName || ''} ${authUser.lastName || ''}`.trim();
    await Promise.allSettled([
      isNewUser ? this.email.sendWelcome({ email: authUser.email, name }) : Promise.resolve(),
      isNewUser ? this.notifications?.create({ userId: authUser.id }, 'Welcome to Hook', `Welcome${name ? `, ${name}` : ''}. Your marketplace is ready.`, 'welcome') : Promise.resolve(),
    ]);

    return response;
  }

  async loginWithApple(input: { identityToken: string; firstName?: string; lastName?: string; referralCode?: string }, metadata?: SessionMetadata) {
    const payload = await verifyAppleIdentityToken(input.identityToken);
    let user = await this.userRepo.findOne({ where: payload.email ? [{ appleId: payload.sub }, { email: payload.email }] : { appleId: payload.sub } });
    const isNewUser = !user;
    if (!user) {
      if (!payload.email) throw new HttpError(409, 'Apple did not share an email address. Remove Hook from Apple ID sign-in settings and try again.');
      user = await this.userRepo.save(this.userRepo.create({
        publicId: await nextPublicId('customer'),
        accountType: AccountType.CUSTOMER,
        accountStatus: AccountStatus.ACTIVE,
        scopeType: ScopeType.SELF,
        email: payload.email,
        authProvider: 'apple',
        appleId: payload.sub,
        firstName: input.firstName || '',
        lastName: input.lastName || '',
        role: UserRole.SHOPPER,
        isActive: true,
        isEmailVerified: payload.emailVerified,
        isPhoneVerified: false,
        lastLoginAt: new Date(),
      }));
    } else {
      if (user.accountType && user.accountType !== AccountType.CUSTOMER) {
        throw new HttpError(403, 'Use the Hook staff portal to sign in to this account', undefined, 'ACCOUNT_PORTAL_MISMATCH');
      }
      if (!user.accountType && user.role !== UserRole.SHOPPER) {
        throw new HttpError(403, 'Use the Hook staff portal to sign in to this account', undefined, 'ACCOUNT_PORTAL_MISMATCH');
      }
      user.accountType = AccountType.CUSTOMER;
      if (!user.isActive || (user.accountStatus && user.accountStatus !== AccountStatus.ACTIVE)) {
        await this.rejectUnavailable(user);
      }
      user.appleId = user.appleId || payload.sub;
      user.firstName = user.firstName || input.firstName || '';
      user.lastName = user.lastName || input.lastName || '';
      user.isEmailVerified = user.isEmailVerified || payload.emailVerified;
      user.lastLoginAt = new Date();
      await this.userRepo.save(user);
    }
    if (!user) throw new HttpError(401, 'Apple sign-in could not be completed');
    const response = await this.buildAuthResponse(user, metadata);
    if (isNewUser) {
      await this.credits.grantWelcomeBonus(user.id).catch(() => undefined);
      if (input.referralCode) await this.referrals.applyCode(input.referralCode, user.id);
    }
    if (isNewUser) await this.email.sendWelcome({ email: user.email, name: `${user.firstName} ${user.lastName}`.trim() });
    return response;
  }

  async register(email: string, password: string) {
    const existing = await this.userRepo.findOne({ where: { email } });
    if (existing) {
      throw new HttpError(400, 'An account with this email already exists. Please login.');
    }

    const user = this.userRepo.create({
      publicId: await nextPublicId('customer'),
      accountType: AccountType.CUSTOMER,
      accountStatus: AccountStatus.ACTIVE,
      scopeType: ScopeType.SELF,
      email,
      password: await hashPassword(password),
      authProvider: 'password',
      firstName: '',
      lastName: '',
      role: UserRole.SHOPPER,
      isActive: false,
      isEmailVerified: false,
    });

    await this.userRepo.save(user);
    await this.createOtp(email, 'email_verification');

    return {
      message: 'Verification code sent to your email.',
      email,
      expiresIn: '10 minutes',
    };
  }

  async startSignup(email: string, password: string) {
    if (!this.signupSessions) throw new HttpError(500, 'Signup sessions are not configured');
    const normalizedEmail = email.toLowerCase().trim();
    const existing = await this.userRepo.findOne({ where: { email: normalizedEmail } });
    if (existing) throw new HttpError(400, 'An account with this email already exists. Please login.');

    const rawToken = randomBytes(32).toString('hex');
    const expiresInMinutes = Number(process.env.SIGNUP_SESSION_EXPIRY_MINUTES || 30);
    const expiresAt = new Date(Date.now() + expiresInMinutes * 60 * 1000);

    const previous = await this.signupSessions.findOne({ where: { email: normalizedEmail }, order: { createdAt: 'DESC' } });
    if (previous) await this.signupSessions.delete({ id: previous.id });

    const session = await this.signupSessions.save(this.signupSessions.create({
      email: normalizedEmail,
      passwordHash: await hashPassword(password),
      sessionTokenHash: hashToken(rawToken),
      isEmailVerified: false,
      currentStep: 'password_created',
      expiresAt,
    }));

    await this.createOtp(normalizedEmail, 'email_verification');

    return {
      email: normalizedEmail,
      signupSessionToken: rawToken,
      nextStep: 'verify_email',
      expiresAt: session.expiresAt,
      message: 'Verification code sent to your email.',
    };
  }

  async verifySignup(sessionToken: string, code: string) {
    const session = await this.findSignupSession(sessionToken);
    const otp = await this.findValidOtp(session.email, code, 'email_verification');
    await Promise.all([
      this.markOtpUsed(otp.id),
      this.signupSessions!.update(session.id, {
        isEmailVerified: true,
        currentStep: 'email_verified',
      }),
    ]);
    return {
      email: session.email,
      signupSessionToken: sessionToken,
      nextStep: 'complete_profile',
      message: 'Email verified.',
    };
  }

  async resendSignupCode(sessionToken: string) {
    const session = await this.findSignupSession(sessionToken);
    if (session.isEmailVerified) {
      return {
        email: session.email,
        signupSessionToken: sessionToken,
        nextStep: 'complete_profile',
        message: 'Email is already verified.',
      };
    }

    await this.createOtp(session.email, 'email_verification');
    return {
      email: session.email,
      signupSessionToken: sessionToken,
      nextStep: 'verify_email',
      message: 'A new verification code has been sent.',
    };
  }

  async completeSignup(sessionToken: string, body: Partial<User>, metadata?: SessionMetadata) {
    const session = await this.findSignupSession(sessionToken);
    if (!session.isEmailVerified) throw new HttpError(400, 'Verify your email before completing signup');
    const existing = await this.userRepo.findOne({ where: { email: session.email } });
    if (existing) throw new HttpError(400, 'An account with this email already exists. Please login.');

    const user = await this.userRepo.save(this.userRepo.create({
      publicId: await nextPublicId('customer'),
      accountType: AccountType.CUSTOMER,
      accountStatus: AccountStatus.ACTIVE,
      scopeType: ScopeType.SELF,
      email: session.email,
      password: session.passwordHash,
      authProvider: 'password',
      firstName: body.firstName || '',
      lastName: body.lastName || '',
      phone: body.phone,
      avatarUrl: body.avatarUrl,
      address: body.address,
      preferences: body.preferences,
      role: UserRole.SHOPPER,
      isActive: true,
      isEmailVerified: true,
      isPhoneVerified: false,
      lastLoginAt: new Date(),
    }));

    const response = await this.buildAuthResponse(user, metadata);
    await Promise.all([
      this.userRepo.update(user.id, { refreshToken: undefined }),
      this.signupSessions!.delete({ id: session.id }),
    ]);
    await this.credits.grantWelcomeBonus(user.id).catch(() => undefined);
    // applyCode never throws — a mistyped or retired code must not fail an
    // otherwise valid signup.
    if ((body as { referralCode?: string }).referralCode) {
      await this.referrals.applyCode(String((body as { referralCode?: string }).referralCode), user.id);
    }
    const name = `${user.firstName || ''} ${user.lastName || ''}`.trim();
    await Promise.all([
      this.email.sendWelcome({ email: user.email, name }),
      this.notifications?.create({ userId: user.id }, 'Welcome to Hook', `Welcome${name ? `, ${name}` : ''}. Your marketplace is ready.`, 'welcome'),
    ]);

    return response;
  }

  async verifyOtp(email: string, code: string, metadata?: SessionMetadata) {
    const otp = await this.findValidOtp(email, code, 'email_verification');
    const user = await this.userRepo.findOne({ where: { email } });
    if (!user) throw new HttpError(404, 'User not found');

    user.isEmailVerified = true;
    user.isActive = true;
    await Promise.all([
      this.markOtpUsed(otp.id),
      this.userRepo.save(user),
    ]);
    // The legacy register() path only becomes a usable account here, so this
    // is its activation point. Keyed on the user id, so an account that
    // already received the bonus elsewhere is not credited twice.
    await this.credits.grantWelcomeBonus(user.id).catch(() => undefined);
    await this.email.sendWelcome({
      email: user.email,
      name: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
    });

    return this.buildAuthResponse(user, metadata);
  }

  async completeProfile(userId: string, body: Partial<User>) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new HttpError(404, 'User not found');

    Object.assign(user, {
      firstName: body.firstName ?? user.firstName,
      lastName: body.lastName ?? user.lastName,
      phone: body.phone ?? user.phone,
      avatarUrl: body.avatarUrl !== undefined ? body.avatarUrl : user.avatarUrl,
      address: body.address ?? user.address,
      preferences: body.preferences ?? user.preferences,
      isActive: true,
    });

    await this.userRepo.save(user);
    const { password, refreshToken, ...safeUser } = user;
    return safeUser;
  }

  async refresh(refreshToken: string) {
    return rotateAccountSession(refreshToken);
  }

  async logout(refreshToken?: string, _userId?: string, sessionId?: string) {
    await revokeAccountSession(refreshToken, sessionId);
    return { loggedOut: true };
  }

  async requestPasswordReset(email: string) {
    const user = await this.userRepo.findOne({ where: { email } });
    if (user) await this.createOtp(email, 'password_reset');
    return { message: 'If the email exists, a password reset code has been sent.' };
  }

  async verifyPasswordReset(email: string, code: string) {
    await this.findValidOtp(email, code, 'password_reset');
    return { email, resetToken: code, message: 'Code verified.' };
  }

  async requestAdminPasswordReset(email: string) {
    const user = await this.userRepo.findOne({ where: { email } });
    if (
      user &&
      [UserRole.SUPPORT, UserRole.ADMIN, UserRole.SUPER_ADMIN].includes(user.role) &&
      user.isActive
    ) {
      await this.createOtp(email, 'password_reset');
    }
    return { message: 'If the admin email exists, a password reset code has been sent.' };
  }

  async resetPassword(email: string, code: string, password: string, metadata?: SessionMetadata) {
    const otp = await this.findValidOtp(email, code, 'password_reset');
    const user = await this.userRepo.findOne({ where: { email } });
    if (!user) throw new HttpError(404, 'User not found');

    user.password = await hashPassword(password);
    user.refreshToken = undefined;
    user.accountStatus = AccountStatus.ACTIVE;
    user.isActive = true;
    user.isEmailVerified = true;
    await Promise.all([
      this.markOtpUsed(otp.id),
      this.userRepo.save(user),
    ]);

    await revokeAccountSessions(user.id, 'password_reset');
    const response = await this.buildAuthResponse(user, metadata);
    return { message: 'Password reset successfully.', ...response };
  }

  async resetAdminPassword(email: string, code: string, password: string) {
    const user = await this.userRepo.findOne({ where: { email } });
    if (
      !user ||
      ![UserRole.SUPPORT, UserRole.ADMIN, UserRole.SUPER_ADMIN].includes(user.role) ||
      !user.isActive
    ) {
      throw new HttpError(400, 'Invalid or expired OTP code');
    }
    return this.resetPassword(email, code, password);
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const user = await this.userRepo.findOne({
      where: { id: userId },
      select: { id: true, password: true },
    });
    if (!user?.password || !(await comparePassword(currentPassword, user.password))) {
      throw new HttpError(400, 'Current password is incorrect');
    }

    await this.userRepo.update(userId, {
      password: await hashPassword(newPassword),
      refreshToken: undefined,
    });
    return { message: 'Password changed successfully.' };
  }

  async getProfile(userId: string) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new HttpError(404, 'User not found');
    return presentAccountUser(user);
  }

  /**
   * Called only after the caller has proven who they are. A customer whose own
   * deletion request is in its cooling-off window is told so, with the date and
   * a way back, instead of the generic denial that left them with no way to
   * change their mind.
   */
  private async rejectUnavailable(user: { id?: string; _id?: unknown; accountStatus?: string }): Promise<never> {
    if (user.accountStatus === AccountStatus.DELETION_REQUESTED) {
      const scheduledFor = await new AccountDeletionService().scheduledFor(String(user.id || user._id));
      if (scheduledFor) {
        throw new HttpError(
          403,
          'Your account is scheduled for deletion. You can restore it until then.',
          { scheduledFor: scheduledFor.toISOString() },
          'ACCOUNT_DELETION_SCHEDULED',
        );
      }
    }
    throw new HttpError(403, 'This account is not available for sign in', undefined, 'ACCESS_DENIED');
  }

  private async createOtp(email: string, type: Otp['type']) {
    if (!this.otpRepo) return;
    const normalizedEmail = email.toLowerCase().trim();
    const code = String(Math.floor(1000 + Math.random() * 9000));
    const expiresInMinutes = Number(process.env.OTP_EXPIRY_MINUTES || 10);
    const expiresAt = new Date(Date.now() + expiresInMinutes * 60 * 1000);
    await this.otpRepo.update({ email: normalizedEmail, type, isUsed: false }, { isUsed: true });
    await this.otpRepo.save(this.otpRepo.create({ email: normalizedEmail, code, type, expiresAt }));
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[otp:dev] ${type} for ${normalizedEmail}: ${code} (expires in ${expiresInMinutes}m)`);
    }
    await this.email.sendOtp({
      email: normalizedEmail,
      code,
      purpose: type === 'password_reset' ? 'password_reset' : 'verification',
      expiresInMinutes,
    });
  }

  private async findSignupSession(sessionToken: string) {
    if (!this.signupSessions) throw new HttpError(500, 'Signup sessions are not configured');
    const session = await this.signupSessions.findOne({ where: { sessionTokenHash: hashToken(sessionToken) } });
    if (!session || new Date(session.expiresAt) <= new Date()) {
      if (process.env.NODE_ENV !== 'production') {
        console.log('[auth:verify] signup session not found or expired');
      }
      throw new HttpError(400, 'Signup session expired. Please start again.');
    }
    return session;
  }

  private async findValidOtp(email: string, code: string, type: Otp['type']) {
    if (!this.otpRepo) throw new HttpError(500, 'OTP service is not configured');
    const normalizedEmail = email.toLowerCase().trim();
    const now = new Date();
    const otp = await this.otpRepo.model
      .findOne({
        email: normalizedEmail,
        code,
        type,
        isUsed: false,
        expiresAt: { $gt: now },
      })
      .sort({ createdAt: -1 })
      .lean({ virtuals: true });
    if (!otp) {
      if (process.env.NODE_ENV !== 'production') {
        console.log(`[auth:verify] otp not found or expired for ${normalizedEmail} (${type})`);
      }
      throw new HttpError(400, 'Invalid or expired OTP code');
    }
    return otp;
  }

  private async markOtpUsed(id: string) {
    if (!this.otpRepo) throw new HttpError(500, 'OTP service is not configured');
    await this.otpRepo.update(id, { isUsed: true });
  }

  private buildAuthResponse(user: User, metadata?: SessionMetadata) {
    return issueAccountSession(user, metadata);
  }
}
