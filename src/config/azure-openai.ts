/**
 * The one place Azure OpenAI settings are read. They are read lazily (never cached at import time) so a
 * changed environment, such as a test or a secret rotation followed by a restart, is always honoured.
 *
 *   AZURE_OPENAI_ENDPOINT         https URL of the Azure resource
 *   AZURE_OPENAI_API_KEY          resource key (secret, never log it)
 *   AZURE_OPENAI_DEPLOYMENT_NAME  the deployment that serves requests
 *   AZURE_OPENAI_API_VERSION      REST API version
 *   AZURE_OPENAI_MODEL_NAME       model behind the deployment, e.g. gpt-4.1-mini. Optional: only used to pick request
 *                                 parameters, because reasoning models take different ones.
 */

const REQUIRED = [
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_ENDPOINT',
  'AZURE_OPENAI_DEPLOYMENT_NAME',
  'AZURE_OPENAI_API_VERSION',
] as const;

export interface AzureOpenAIConfig {
  apiKey: string;
  endpoint: string;
  deployment: string;
  apiVersion: string;
  modelName: string;
  /** Names (never values) of required settings that are missing or unusable. */
  missing: string[];
  configured: boolean;
}

export function azureOpenAIConfig(env: NodeJS.ProcessEnv = process.env): AzureOpenAIConfig {
  const apiKey = (env.AZURE_OPENAI_API_KEY || '').trim();
  const endpoint = (env.AZURE_OPENAI_ENDPOINT || '').trim();
  const deployment = (env.AZURE_OPENAI_DEPLOYMENT_NAME || '').trim();
  const apiVersion = (env.AZURE_OPENAI_API_VERSION || '').trim();
  const modelName = (env.AZURE_OPENAI_MODEL_NAME || deployment).trim();
  const missing: string[] = REQUIRED.filter((name) => !(env[name] || '').trim());
  if (endpoint) {
    try {
      const url = new URL(endpoint);
      // A key embedded in the URL, or plain http, would leak the credential: treat the endpoint as unusable.
      if (url.protocol !== 'https:' || url.username || url.password) missing.push('AZURE_OPENAI_ENDPOINT');
    } catch {
      missing.push('AZURE_OPENAI_ENDPOINT');
    }
  }
  const unique = [...new Set(missing)];
  return { apiKey, endpoint, deployment, apiVersion, modelName, missing: unique, configured: unique.length === 0 };
}

/**
 * Reasoning models (o-series, gpt-5) reject `max_tokens` and a custom `temperature`; everything else,
 * including gpt-4.1 and gpt-4o, takes the classic parameters.
 */
export function usesReasoningParameters(modelName: string) {
  return /^(o\d|gpt-5)/i.test(modelName.trim());
}

/** Logged once at startup so a missing setting is noticed before the first customer is told "unavailable". */
export function warnIfAzureIncomplete(negotiationExpected = true) {
  const { missing, configured } = azureOpenAIConfig();
  if (configured || !negotiationExpected) return;
  console.warn(JSON.stringify({ event: 'negotiation.azure_not_configured', missing }));
}
