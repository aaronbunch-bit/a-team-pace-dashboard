// Netlify Identity event handler — blocks signups that aren't @varsitytutors.com.
// Uses the modern typed event export (userValidate) instead of the legacy
// identity-validate.mts + Lambda { statusCode, body } handler. The old form was
// returning "Failed to handle signup webhook" on Google OAuth because Identity
// could not successfully complete the validate webhook.
import type { UserValidateEvent } from "@netlify/functions";

const ALLOWED_EMAIL_DOMAIN = "@varsitytutors.com";

export default {
  userValidate(event: UserValidateEvent) {
    const email = String(event.user?.email || "").toLowerCase();
    if (!email.endsWith(ALLOWED_EMAIL_DOMAIN)) {
      return event.deny();
    }
  },
};
