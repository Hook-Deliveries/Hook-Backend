import { OAuth2Client, TokenPayload } from 'google-auth-library';
import { HttpError } from '@utils/http';

const googleClient = new OAuth2Client();

/** The native Google Sign-In SDK issues ID tokens audienced to the Web client ID, not the platform one, so the web client must be accepted alongside iOS/Android for mobile sign-in to verify. */
function configuredAudiences() {
  return [
    process.env.GOOGLE_WEB_CLIENT_ID,
    process.env.GOOGLE_IOS_CLIENT_ID,
    process.env.GOOGLE_ANDROID_CLIENT_ID,
  ].filter(Boolean) as string[];
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
    throw new HttpError(401, 'Google sign-in could not be verified');
  }
}
