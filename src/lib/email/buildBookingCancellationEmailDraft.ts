import { format } from "date-fns";

export type BookingCancellationDraftInput = {
  customerFullName: string;
  bookingReference: string;
  vehicleName: string;
  pickupDateTime: string | Date;
  returnDateTime: string | Date;
  /**
   * @deprecated Ignored. Kept so older callers compile; drafts never promise a refund.
   */
  refundPayment?: boolean;
};

export type BookingCancellationDraft = {
  subject: string;
  body: string;
};

function formatWhen(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return format(date, "dd MMM yyyy, HH:mm");
}

/** Accurate copy: cancellation ≠ Stripe refund completed or scheduled. */
export function cancellationPaymentClarification(): string {
  return [
    "This message confirms that your booking has been cancelled.",
    "It does not confirm that any payment has been refunded.",
    "If a rental payment refund applies, our team will handle it separately and contact you if needed.",
  ].join(" ");
}

/**
 * Default customer-facing cancellation email for the admin review/edit form.
 */
export function buildBookingCancellationEmailDraft(
  input: BookingCancellationDraftInput,
): BookingCancellationDraft {
  const subject = `Explore Malta Rentals – Booking ${input.bookingReference} cancelled`;
  const body = [
    `Hello ${input.customerFullName},`,
    "",
    "We're writing to confirm that your booking with Explore Malta Rentals has been cancelled.",
    "",
    `Booking reference: ${input.bookingReference}`,
    `Vehicle: ${input.vehicleName}`,
    `Pickup: ${formatWhen(input.pickupDateTime)}`,
    `Return: ${formatWhen(input.returnDateTime)}`,
    "",
    cancellationPaymentClarification(),
    "",
    "We're sorry we won't see you this time. If you would like to book again or need any help, just reply to this email and our team will assist you.",
    "",
    "Kind regards,",
    "Explore Malta Rentals",
  ].join("\n");

  return { subject, body };
}
