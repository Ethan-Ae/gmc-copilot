import Anthropic from "@anthropic-ai/sdk";
import { ShopifyReauthRequired } from "./shopifyToken";

// The only categories ever shown to a merchant. Never surface a raw SDK/API
// error message on the front end - it is logged server-side and kept in
// audits.error_message for debugging, but the response to the client always
// goes through one of these fixed, French messages.
export type AuditErrorCode = "anthropic" | "shopify_auth" | "timeout" | "unknown";

const MESSAGES: Record<AuditErrorCode, string> = {
  anthropic:
    "Notre service d'analyse est temporairement indisponible. Votre crédit d'audit n'a pas été consommé. Réessayez dans quelques minutes.",
  shopify_auth: "La connexion à votre boutique a expiré. Reconnectez votre boutique.",
  timeout: "L'analyse a pris trop de temps. Réessayez, votre crédit n'a pas été consommé.",
  unknown:
    "Une erreur inattendue est survenue. Votre crédit n'a pas été consommé. Contactez le support si le problème persiste.",
};

export function auditErrorMessage(code: AuditErrorCode | null | undefined): string {
  return (code && MESSAGES[code]) || MESSAGES.unknown;
}

// Classifies any error thrown while creating/running an audit into one of the
// fixed categories above. Never inspects/returns the raw message - callers
// that want the raw detail for logs should log `err` itself.
export function classifyAuditError(err: unknown): AuditErrorCode {
  if (err instanceof ShopifyReauthRequired) return "shopify_auth";

  if (
    err instanceof Anthropic.APIConnectionTimeoutError ||
    err instanceof Anthropic.APIUserAbortError ||
    (err instanceof Error && err.name === "AbortError")
  ) {
    return "timeout";
  }

  if (err instanceof Anthropic.APIError) return "anthropic";

  // lib/auditEngine.ts's MissingAnthropicKey/ModelNoToolBlock are plain Error
  // subclasses with `name` set in their constructor; matched by name instead
  // of `instanceof` to avoid a circular import with auditEngine.ts.
  if (err instanceof Error && err.name === "MissingAnthropicKey") {
    return "anthropic";
  }

  // A generic HTTP-shaped error (e.g. a raw fetch response wrapper) carrying
  // a Shopify 401/403 that was not already converted to ShopifyReauthRequired.
  if (err && typeof err === "object" && "status" in err) {
    const status = (err as { status?: unknown }).status;
    if (status === 401 || status === 403) return "shopify_auth";
  }

  return "unknown";
}

// Classifies `err`, logs the raw detail server-side, and returns both the
// raw text (kept in audits.error_message for debugging only) and the fixed
// French message/code pair the client is allowed to see.
export function resolveAuditError(
  context: string,
  err: unknown,
): { code: AuditErrorCode; message: string; raw: string } {
  const code = classifyAuditError(err);
  const raw = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`[audit:${context}]`, err);
  return { code, message: auditErrorMessage(code), raw };
}
