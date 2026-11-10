import { OAuth2Client, TokenPayload } from 'google-auth-library';
import { HttpError } from '@utils/http';

const googleClient = new OAuth2Client();

function configuredAudiences() {
  return [
    process.env.GOOGLE_WEB_CLIENT_ID,
    process.env.GOOGLE_IOS_CLIENT_ID,
    process.env.GOOGLE_ANDROID_CLIENT_ID,
  ]
    .flatMap((value) => String(value || '').split(','))
    .map((value) => value.trim())
    .filter(Boolean);
}

/** The audience the app's token was issued for, read without trusting it, only so a mismatch can be explained. */
function tokenAudience(idToken: string) {
  try {
    const body = idToken.split('.')[1];
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')).aud as string | undefined;
  } catch {
    return undefined;
  }
}

export async function verifyGoogleIdToken(idToken: string): Promise<TokenPayload> {
  const audience = configuredAudiences();
  if (!audience.length) {
    throw new HttpError(500, 'Google authentication is not configured');
  }

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience,
    });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email) {
      throw new HttpError(401, 'Google sign-in could not be verified');
    }
    if (!payload.email_verified) {
      throw new HttpError(401, 'Google email is not verified');
    }
    return payload;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    // The usual cause is a token issued for a Google client this server does not know (the app and the server are
    // configured with different Google projects). Log both sides so it can be seen at a glance. Client ids are public.
    const issuedFor = tokenAudience(idToken);
    console.warn(JSON.stringify({
      event: 'google_auth.rejected',
      reason: error instanceof Error ? error.message : 'unknown',
      tokenAudience: issuedFor,
      audienceKnown: issuedFor ? audience.includes(issuedFor) : undefined,
      expectedAudiences: audience,
    }));
    throw new HttpError(401, 'Google sign-in could not be verified');
  }
}
