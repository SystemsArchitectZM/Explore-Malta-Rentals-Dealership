import { digitsOnlyForWa } from "@/components/footer/footer-utils";
import { resolveGoogleReviewUrl } from "@/lib/reviews/google-review-url";

/** E.164 length after formatting is removed. Country codes are not invented. */
const WHATSAPP_MIN_DIGITS = 8;
const WHATSAPP_MAX_DIGITS = 15;

export type WhatsAppReviewLinkResult =
  | { ok: true; url: string; phone: string }
  | { ok: false; reason: "invalid_phone" | "invalid_review_url" };

/**
 * Turns a stored booking phone into the digits WhatsApp click-to-chat expects.
 * Formatting characters are removed. A leading 00 international prefix is removed
 * when the remaining number is a plausible length. A country code is never added.
 */
export function normalizeWhatsAppPhone(value: string | null | undefined): string | null {
  const digits = digitsOnlyForWa(value ?? "");
  if (!digits) return null;

  const withoutExitCode = digits.startsWith("00") ? digits.slice(2) : digits;
  if (withoutExitCode.length < WHATSAPP_MIN_DIGITS || withoutExitCode.length > WHATSAPP_MAX_DIGITS) {
    return null;
  }
  if (/^0+$/.test(withoutExitCode)) return null;
  return withoutExitCode;
}

export function postRentalCustomerFirstName(customerFullName: string): string {
  const first = customerFullName.trim().split(/\s+/)[0];
  return first || "there";
}

/**
 * Plain-text post-rental chat message. Loyalty credit and the Google review
 * request stay independent: the credit is not described as a reward for reviewing.
 */
export function buildPostRentalWhatsAppMessage(input: {
  customerFullName: string;
  reviewUrl: string;
  includeLoyaltyCredit: boolean;
}): string {
  const name = postRentalCustomerFirstName(input.customerFullName);
  const lines = [`Hi ${name},`, "", "Thank you for choosing Explore Malta Rentals."];

  if (input.includeLoyaltyCredit) {
    lines.push("", "As a thank-you for your rental, you have €5 credit available toward your next booking.");
  }

  lines.push(
    "",
    "We'd also really appreciate it if you shared your experience with us on Google:",
    "",
    input.reviewUrl,
    "",
    "Thank you and we hope to see you again soon!",
  );

  return lines.join("\n");
}

export function buildWhatsAppClickToChatUrl(phone: string, message: string): string {
  return `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
}

/**
 * Builds a wa.me link from the booking's stored phone and the same Google review
 * URL used by the post-rental email. Opening the link does not send the message.
 */
export function buildPostRentalWhatsAppLink(input: {
  customerPhone: string | null | undefined;
  customerFullName: string;
  includeLoyaltyCredit: boolean;
  googleReviewUrlEnv?: string;
}): WhatsAppReviewLinkResult {
  const phone = normalizeWhatsAppPhone(input.customerPhone);
  if (!phone) {
    return { ok: false, reason: "invalid_phone" };
  }

  const reviewUrl = resolveGoogleReviewUrl(input.googleReviewUrlEnv);
  if (!reviewUrl.ok) {
    return { ok: false, reason: "invalid_review_url" };
  }

  const message = buildPostRentalWhatsAppMessage({
    customerFullName: input.customerFullName,
    reviewUrl: reviewUrl.url,
    includeLoyaltyCredit: input.includeLoyaltyCredit,
  });

  return {
    ok: true,
    phone,
    url: buildWhatsAppClickToChatUrl(phone, message),
  };
}
