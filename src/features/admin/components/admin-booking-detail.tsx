import type { ReactNode } from "react";

import { ArrowLeft, BadgeCheck, CheckCircle2, KeyRound, RotateCcw, XCircle } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { AdminBookingPriceBuildup } from "@/features/admin/components/admin-booking-price-buildup";
import { AdminBookingReviewRequestButton } from "@/features/admin/components/admin-booking-review-request-button";
import type { AdminBookingDetail } from "@/lib/admin/bookings/types";
import { formatMaltaDate, formatMaltaDateTime } from "@/lib/format-malta-datetime";
import { buildPostRentalWhatsAppLink } from "@/lib/reviews/whatsapp-review-link";

type AdminBookingDetailViewProps = Readonly<{
  locale: string;
  booking: AdminBookingDetail;
}>;

function formatEur(amount: number | null): string {
  if (amount === null) return "—";
  return new Intl.NumberFormat("en-MT", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

function formatPercent(value: number | null): string {
  if (value === null) return "—";
  return `${value}%`;
}

function formatCoordinates(latitude: number | null, longitude: number | null): string {
  if (latitude === null || longitude === null) return "—";
  return `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
}

function formatUploadPath(path: string | null): string {
  if (!path?.trim()) return "—";
  const segments = path.split(/[/\\]/);
  return segments[segments.length - 1] ?? path;
}

function statusBadgeClass(status: string): string {
  if (status === "CONFIRMED") return "bg-emerald-50 text-emerald-700";
  if (status === "VEHICLE_HANDED_OVER") return "bg-blue-50 text-blue-700";
  if (status === "RETURNED") return "bg-sky-50 text-sky-700";
  if (status === "COMPLETED") return "bg-slate-100 text-slate-700";
  if (status === "CANCELLED") return "bg-slate-100 text-slate-600";
  return "bg-amber-50 text-amber-800";
}

function paymentStatusBadgeClass(status: string): string {
  if (status === "PAID") return "bg-emerald-50 text-emerald-700";
  if (status === "REFUNDED") return "bg-blue-50 text-blue-700";
  if (status === "FAILED") return "bg-red-50 text-red-700";
  return "bg-amber-50 text-amber-800";
}

function depositStatusBadgeClass(status: string): string {
  if (status === "COLLECTED") return "bg-emerald-50 text-emerald-700";
  if (status === "REFUNDED") return "bg-blue-50 text-blue-700";
  if (status === "DEDUCTED") return "bg-orange-50 text-orange-700";
  return "bg-amber-50 text-amber-800";
}

function unitStatusBadgeClass(status: string): string {
  if (status === "AVAILABLE") return "bg-emerald-50 text-emerald-700";
  if (status === "RESERVED") return "bg-blue-50 text-blue-700";
  if (status === "OUT_WITH_CUSTOMER") return "bg-violet-50 text-violet-700";
  if (status === "MAINTENANCE") return "bg-orange-50 text-orange-700";
  return "bg-slate-100 text-slate-600";
}

function reviewStatusClass(status: string): string {
  if (status === "SENT") return "bg-emerald-50 text-emerald-700";
  if (status === "FAILED") return "bg-rose-50 text-rose-700";
  if (status === "SKIPPED") return "bg-slate-100 text-slate-600";
  return "bg-amber-50 text-amber-800";
}

async function LoyaltyCreditSection({
  locale,
  booking,
}: Readonly<{
  locale: string;
  booking: AdminBookingDetail;
}>) {
  const t = await getTranslations({ locale, namespace: "Admin.bookings" });
  const issued = booking.issuedLoyaltyCredit;
  const redeemed = booking.redeemedLoyaltyCredit;

  return (
    <DetailSection title={t("details.loyaltyCredit.title")}>
      <dl>
        {issued ? (
          <>
            <DetailRow label={t("details.loyaltyCredit.issued")} value={formatEur(issued.amount)} />
            <DetailRow
              label={t("details.loyaltyCredit.status")}
              value={t(
                `details.loyaltyCredit.statuses.${issued.status}` as "details.loyaltyCredit.statuses.AVAILABLE",
              )}
            />
            <DetailRow label={t("details.loyaltyCredit.issuedAt")} value={formatMaltaDateTime(issued.issuedAt)} />
            <DetailRow
              label={t("details.loyaltyCredit.redeemedBooking")}
              value={
                issued.redeemedBookingId && issued.redeemedBookingReference ? (
                  <a className="font-semibold text-teal-800 underline" href={`/${locale}/admin/bookings/${issued.redeemedBookingId}`}>
                    {issued.redeemedBookingReference}
                  </a>
                ) : (
                  "—"
                )
              }
            />
          </>
        ) : null}
        {redeemed ? (
          <DetailRow
            label={t("details.loyaltyCredit.appliedFrom")}
            value={redeemed.sourceBookingReference ?? "—"}
          />
        ) : null}
      </dl>
      <p className="mt-3 text-sm text-slate-600">{t("details.loyaltyCredit.independentOfReview")}</p>
    </DetailSection>
  );
}

async function ReviewRequestSection({
  locale,
  booking,
}: Readonly<{
  locale: string;
  booking: AdminBookingDetail;
}>) {
  const t = await getTranslations({ locale, namespace: "Admin.bookings" });
  const review = booking.reviewRequest;
  const canSend = booking.status === "RETURNED" || booking.status === "COMPLETED";
  const actionLabel = review?.sentAt ? t("details.reviewRequest.resend") : t("details.reviewRequest.send");
  const whatsapp = buildPostRentalWhatsAppLink({
    customerPhone: booking.customerPhone,
    customerFullName: booking.customerFullName,
    includeLoyaltyCredit: booking.issuedLoyaltyCredit !== null,
  });

  return (
    <DetailSection title={t("details.reviewRequest.title")}>
      <dl>
        <DetailRow
          label={t("details.reviewRequest.status")}
          value={
            review ? (
              <span className={["inline-flex rounded-full px-2 py-0.5 text-xs font-semibold", reviewStatusClass(review.status)].join(" ")}>
                {t(`details.reviewRequest.statuses.${review.status}` as "details.reviewRequest.statuses.SENT")}
              </span>
            ) : (
              t("details.reviewRequest.notScheduled")
            )
          }
        />
        {review && (review.status === "PENDING" || review.status === "PROCESSING") ? (
          <DetailRow label={t("details.reviewRequest.scheduled")} value={formatMaltaDateTime(review.scheduledAt)} />
        ) : null}
        {review?.sentAt ? (
          <DetailRow label={t("details.reviewRequest.sent")} value={formatMaltaDateTime(review.sentAt)} />
        ) : null}
        {review?.lastManualResendAt ? (
          <DetailRow label={t("details.reviewRequest.lastResent")} value={formatMaltaDateTime(review.lastManualResendAt)} />
        ) : null}
        {review?.lastManualResendByName ? (
          <DetailRow label={t("details.reviewRequest.resentBy")} value={review.lastManualResendByName} />
        ) : null}
        {review?.lastError ? (
          <DetailRow label={t("details.reviewRequest.error")} value={review.lastError} />
        ) : null}
      </dl>
      {review?.status === "PENDING" || review?.status === "PROCESSING" ? (
        <p className="mt-3 text-sm text-slate-500">{t("details.reviewRequest.scheduledHint")}</p>
      ) : null}
      {!review ? <p className="mt-3 text-sm text-slate-500">{t("details.reviewRequest.notScheduledHint")}</p> : null}
      {review?.status === "SKIPPED" ? (
        <p className="mt-3 text-sm text-slate-500">
          {review.skippedReason === "invalid_customer_email"
            ? t("details.reviewRequest.skippedHint")
            : t("details.reviewRequest.skippedGeneric")}
        </p>
      ) : null}
      {canSend ? (
        <div className="mt-4">
          <AdminBookingReviewRequestButton
            bookingId={booking.id}
            disabled={review?.status === "PROCESSING"}
            label={actionLabel}
            sendingLabel={t("details.reviewRequest.sending")}
            successMessage={t("details.reviewRequest.resendSuccess")}
            fallbackError={t("details.reviewRequest.fallbackError")}
          >
            <WhatsAppReviewLink
              href={whatsapp.ok ? whatsapp.url : null}
              label={t("details.reviewRequest.whatsapp")}
            />
          </AdminBookingReviewRequestButton>
          {whatsapp.ok ? null : (
            <p className="mt-2 text-sm text-slate-500">
              {whatsapp.reason === "invalid_phone"
                ? t("details.reviewRequest.whatsappUnavailable")
                : t("details.reviewRequest.whatsappReviewUrlUnavailable")}
            </p>
          )}
        </div>
      ) : null}
    </DetailSection>
  );
}

function WhatsAppReviewLink({
  href,
  label,
}: Readonly<{
  href: string | null;
  label: string;
}>) {
  const className =
    "inline-flex items-center gap-2 rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60";

  if (!href) {
    return (
      <button type="button" disabled className={className}>
        {label}
      </button>
    );
  }

  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
      {label}
    </a>
  );
}

function DetailSection({
  title,
  children,
}: Readonly<{ title: string; children: ReactNode }>) {
  return (
    <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm">
      <h3 className="text-sm font-bold uppercase tracking-wide text-slate-500">{title}</h3>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function DetailRow({
  label,
  value,
}: Readonly<{ label: string; value: ReactNode }>) {
  return (
    <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 border-b border-slate-100 py-2 last:border-0">
      <dt className="text-sm text-slate-500">{label}</dt>
      <dd className="max-w-[65%] text-right text-sm font-medium text-slate-900">{value}</dd>
    </div>
  );
}

function BookingStatusIcon({ status }: Readonly<{ status: string }>) {
  const className = "size-3.5 shrink-0";

  switch (status) {
    case "CONFIRMED":
      return <CheckCircle2 className={className} aria-hidden />;
    case "VEHICLE_HANDED_OVER":
      return <KeyRound className={className} aria-hidden />;
    case "RETURNED":
      return <RotateCcw className={className} aria-hidden />;
    case "COMPLETED":
      return <BadgeCheck className={className} aria-hidden />;
    case "CANCELLED":
      return <XCircle className={className} aria-hidden />;
    default:
      return null;
  }
}

export async function AdminBookingDetailHeader({
  locale,
  booking,
}: Readonly<{
  locale: string;
  booking: AdminBookingDetail;
}>) {
  const t = await getTranslations({ locale, namespace: "Admin.bookings" });

  return (
    <section className="space-y-4">
      <a
        href={`/${locale}/admin/bookings`}
        className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-600 transition hover:text-[#3a7ca5]"
      >
        <ArrowLeft className="size-4" aria-hidden />
        {t("details.backToList")}
      </a>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h2 className="min-w-0 text-lg font-bold text-slate-950">
          {t("details.title", { reference: booking.bookingReference })}
        </h2>
        <span
          className={[
            "inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-sm font-semibold",
            statusBadgeClass(booking.status),
          ].join(" ")}
        >
          <BookingStatusIcon status={booking.status} />
          {t(`status.${booking.status}` as "status.CONFIRMED")}
        </span>
      </div>
    </section>
  );
}

export async function AdminBookingDetailView({ locale, booking }: AdminBookingDetailViewProps) {
  const t = await getTranslations({ locale, namespace: "Admin.bookings" });

  const formatYesNo = (value: boolean) => (value ? t("details.yes") : t("details.no"));

  return (
    <div className="space-y-5">
      <DetailSection title={t("details.sections.summary")}>
        <dl>
          <DetailRow label={t("details.fields.reference")} value={booking.bookingReference} />
          <DetailRow
            label={t("details.fields.status")}
            value={t(`status.${booking.status}` as "status.CONFIRMED")}
          />
          <DetailRow
            label={t("details.fields.paymentStatus")}
            value={
              <span className={["inline-flex rounded-full px-2 py-0.5 text-xs font-semibold", paymentStatusBadgeClass(booking.paymentStatus)].join(" ")}>
                {t(`paymentStatus.${booking.paymentStatus}` as "paymentStatus.PENDING")}
              </span>
            }
          />
          <DetailRow
            label={t("details.fields.securityDepositStatus")}
            value={
              <span className={["inline-flex rounded-full px-2 py-0.5 text-xs font-semibold", depositStatusBadgeClass(booking.securityDepositStatus)].join(" ")}>
                {t(`depositStatus.${booking.securityDepositStatus}` as "depositStatus.PENDING")}
              </span>
            }
          />
          <DetailRow label={t("details.fields.createdAt")} value={formatMaltaDateTime(booking.createdAt)} />
          <DetailRow label={t("details.fields.updatedAt")} value={formatMaltaDateTime(booking.updatedAt)} />
          <DetailRow
            label={t("details.fields.securityDepositMethod")}
            value={t(`depositMethod.${booking.depositMethod}` as "depositMethod.ONLINE")}
          />
          {booking.paymentProofUploadPath ? (
            <DetailRow
              label={t("details.fields.paymentProofUpload")}
              value={formatUploadPath(booking.paymentProofUploadPath)}
            />
          ) : null}
          <DetailRow
            label={t("details.fields.confirmationEmailStatus")}
            value={t(
              `confirmationEmailStatus.${booking.confirmationEmailStatus}` as "confirmationEmailStatus.SENT",
            )}
          />
          <DetailRow
            label={t("details.fields.confirmationEmailSentAt")}
            value={booking.confirmationEmailSentAt ? formatMaltaDateTime(booking.confirmationEmailSentAt) : "—"}
          />
        </dl>
      </DetailSection>

      {booking.reviewRequest || booking.status === "RETURNED" || booking.status === "COMPLETED" ? (
        <ReviewRequestSection locale={locale} booking={booking} />
      ) : null}

      {booking.issuedLoyaltyCredit || booking.redeemedLoyaltyCredit ? (
        <LoyaltyCreditSection locale={locale} booking={booking} />
      ) : null}

      <div className="grid gap-5 lg:grid-cols-2">
        <DetailSection title={t("details.sections.customer")}>
          <dl>
            <DetailRow label={t("details.fields.name")} value={booking.customerFullName} />
            <DetailRow label={t("details.fields.email")} value={booking.customerEmail} />
            <DetailRow label={t("details.fields.phone")} value={booking.customerPhone} />
            <DetailRow label={t("details.fields.nationality")} value={booking.customerNationality} />
            <DetailRow label={t("details.fields.dateOfBirth")} value={formatMaltaDate(booking.customerDateOfBirth)} />
            <DetailRow label={t("details.fields.licenseCategory")} value={booking.customerLicenseCategory} />
            <DetailRow
              label={t("details.fields.licenseUpload")}
              value={formatUploadPath(booking.customerLicenseUploadPath)}
            />
            <DetailRow
              label={t("details.fields.passportUpload")}
              value={formatUploadPath(booking.customerPassportUploadPath)}
            />
            <DetailRow
              label={t("details.fields.willPresentLicenseAtPickup")}
              value={formatYesNo(booking.customerWillPresentLicenseAtPickup)}
            />
            <DetailRow
              label={t("details.fields.willPresentIdAtPickup")}
              value={formatYesNo(booking.customerWillPresentIdAtPickup)}
            />
            <DetailRow
              label={t("details.fields.notes")}
              value={booking.customerSpecialNotes?.trim() ? booking.customerSpecialNotes : "—"}
            />
          </dl>
        </DetailSection>

        <DetailSection title={t("details.sections.vehicle")}>
          <dl>
            <DetailRow label={t("details.fields.vehicleName")} value={booking.vehicleName} />
            <DetailRow label={t("details.fields.licensePlate")} value={booking.vehicleLicensePlate ?? "—"} />
            <DetailRow label={t("details.fields.vehicleColor")} value={booking.vehicleColor ?? "—"} />
            <DetailRow
              label={t("details.fields.vehicleUnitStatus")}
              value={
                booking.vehicleUnitStatus ? (
                  <span
                    className={[
                      "inline-flex rounded-full px-2 py-0.5 text-xs font-semibold",
                      unitStatusBadgeClass(booking.vehicleUnitStatus),
                    ].join(" ")}
                  >
                    {t(`unitStatus.${booking.vehicleUnitStatus}` as "unitStatus.AVAILABLE")}
                  </span>
                ) : (
                  "—"
                )
              }
            />
            <DetailRow label={t("details.fields.vehicleType")} value={booking.vehicleType} />
            <DetailRow
              label={t("details.fields.vehicleTypeSnapshot")}
              value={booking.vehicleTypeSnapshot ?? "—"}
            />
            <DetailRow label={t("details.fields.pickup")} value={formatMaltaDateTime(booking.pickupDateTime)} />
            <DetailRow label={t("details.fields.return")} value={formatMaltaDateTime(booking.returnDateTime)} />
            <DetailRow label={t("details.fields.billableDays")} value={booking.billableDays} />
            <DetailRow
              label={t("details.fields.actualDurationHours")}
              value={booking.actualDurationHours.toFixed(2)}
            />
          </dl>
          {booking.vehicleAssignments.length > 0 ? (
            <div className="mt-4 border-t border-slate-100 pt-4">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                {t("details.fields.vehicleHistory")}
              </h4>
              <ol className="mt-3 space-y-3">
                {booking.vehicleAssignments.map((assignment) => (
                  <li key={assignment.id} className="text-sm text-slate-800">
                    <p className="font-semibold text-slate-950">
                      {assignment.vehicleName}
                      {assignment.licensePlate ? ` · ${assignment.licensePlate}` : ""}
                      {assignment.color ? ` · ${assignment.color}` : ""}
                    </p>
                    <p className="text-slate-600">
                      {formatMaltaDateTime(assignment.startedAt)}
                      {" → "}
                      {assignment.endedAt
                        ? formatMaltaDateTime(assignment.endedAt)
                        : t("details.fields.vehicleHistoryCurrent")}
                    </p>
                    {assignment.endDisposition ? (
                      <p className="text-slate-500">
                        {t(`lifecycle.unitStatus.${assignment.endDisposition}` as "lifecycle.unitStatus.AVAILABLE")}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
        </DetailSection>
      </div>

      <DetailSection title={t("details.sections.pickupDropoff")}>
        <dl>
          <DetailRow label={t("details.fields.pickupOption")} value={booking.pickupOption} />
          <DetailRow label={t("details.fields.pickupAddress")} value={booking.pickupAddress?.trim() ? booking.pickupAddress : "—"} />
          <DetailRow
            label={t("details.fields.pickupCoordinates")}
            value={formatCoordinates(booking.pickupLatitude, booking.pickupLongitude)}
          />
          <DetailRow label={t("details.fields.dropoffOption")} value={booking.dropoffOption} />
          <DetailRow label={t("details.fields.dropoffAddress")} value={booking.dropoffAddress?.trim() ? booking.dropoffAddress : "—"} />
          <DetailRow
            label={t("details.fields.dropoffCoordinates")}
            value={formatCoordinates(booking.dropoffLatitude, booking.dropoffLongitude)}
          />
        </dl>
      </DetailSection>

      <DetailSection title={t("details.sections.addons")}>
        <dl>
          <DetailRow label={t("details.fields.cdwOption")} value={booking.cdwOption} />
          <DetailRow label={t("details.fields.cdwDailyRate")} value={formatEur(booking.cdwDailyRate)} />
          <DetailRow label={t("details.fields.helmetSize1")} value={booking.helmetSize1 ?? "—"} />
          <DetailRow label={t("details.fields.helmetSize2")} value={booking.helmetSize2 ?? "—"} />
          <DetailRow
            label={t("details.fields.storageBoxSelected")}
            value={formatYesNo(booking.storageBoxSelected)}
          />
          <DetailRow
            label={t("details.fields.storageBoxCost")}
            value={booking.storageBoxSelected ? formatEur(booking.storageBoxCost) : "—"}
          />
          <DetailRow
            label={t("details.fields.additionalDriverEnabled")}
            value={formatYesNo(booking.additionalDriverEnabled)}
          />
        </dl>
      </DetailSection>

      {booking.additionalDriverEnabled ? (
        <DetailSection title={t("details.sections.additionalDriver")}>
          <dl>
            <DetailRow label={t("details.fields.name")} value={booking.additionalDriverFullName ?? "—"} />
            <DetailRow label={t("details.fields.email")} value={booking.additionalDriverEmail ?? "—"} />
            <DetailRow label={t("details.fields.phone")} value={booking.additionalDriverPhone ?? "—"} />
            <DetailRow
              label={t("details.fields.nationality")}
              value={booking.additionalDriverNationality ?? "—"}
            />
            <DetailRow
              label={t("details.fields.dateOfBirth")}
              value={
                booking.additionalDriverDateOfBirth
                  ? formatMaltaDate(booking.additionalDriverDateOfBirth)
                  : "—"
              }
            />
            <DetailRow
              label={t("details.fields.licenseCategory")}
              value={booking.additionalDriverLicenseCategory ?? "—"}
            />
            <DetailRow
              label={t("details.fields.licenseUpload")}
              value={formatUploadPath(booking.additionalDriverLicenseUploadPath)}
            />
            <DetailRow
              label={t("details.fields.passportUpload")}
              value={formatUploadPath(booking.additionalDriverPassportUploadPath)}
            />
            <DetailRow
              label={t("details.fields.willPresentLicenseAtPickup")}
              value={formatYesNo(booking.additionalDriverWillPresentLicenseAtPickup)}
            />
            <DetailRow
              label={t("details.fields.willPresentIdAtPickup")}
              value={formatYesNo(booking.additionalDriverWillPresentIdAtPickup)}
            />
            <DetailRow
              label={t("details.fields.additionalDriverDailyRate")}
              value={formatEur(booking.additionalDriverDailyRate)}
            />
            <DetailRow
              label={t("details.fields.additionalDriverTotal")}
              value={formatEur(booking.additionalDriverTotal)}
            />
          </dl>
        </DetailSection>
      ) : null}

      <DetailSection title={t("details.sections.hotel")}>
        <dl>
          <DetailRow label={t("details.fields.hotelName")} value={booking.hotelName ?? "—"} />
          <DetailRow label={t("details.fields.hotelCode")} value={booking.hotelCode ?? "—"} />
          <DetailRow
            label={t("details.fields.hotelDiscountPercent")}
            value={formatPercent(booking.hotelDiscountPercentSnapshot)}
          />
          <DetailRow
            label={t("details.fields.hotelDiscountAmount")}
            value={formatEur(booking.hotelDiscountAmountSnapshot)}
          />
          <DetailRow
            label={t("details.fields.subtotalAfterHotelDiscountSnapshot")}
            value={formatEur(booking.subtotalAfterHotelDiscountSnapshot)}
          />
        </dl>
      </DetailSection>

      {(booking.handoverDateTime ||
        booking.returnRecordedAt ||
        booking.paymentReceivedAmount !== null ||
        booking.paymentProofUploadPath ||
        booking.securityDepositCollectedAmount !== null ||
        booking.depositRefundAmount !== null ||
        booking.depositDeductionAmount !== null) ? (
        <DetailSection title={t("details.sections.lifecycle")}>
          <dl>
            {booking.handoverDateTime ? (
              <DetailRow label={t("details.fields.handoverDateTime")} value={formatMaltaDateTime(booking.handoverDateTime)} />
            ) : null}
            {booking.paymentReceivedAmount !== null ? (
              <DetailRow label={t("details.fields.paymentReceivedAmount")} value={formatEur(booking.paymentReceivedAmount)} />
            ) : null}
            {booking.paymentMethod ? (
              <DetailRow
                label={t("details.fields.paymentMethod")}
                value={t(`paymentMethod.${booking.paymentMethod}` as "paymentMethod.CASH")}
              />
            ) : null}
            {booking.paymentProofUploadPath ? (
              <DetailRow
                label={t("details.fields.paymentProofUpload")}
                value={formatUploadPath(booking.paymentProofUploadPath)}
              />
            ) : null}
            {booking.securityDepositCollectedAmount !== null ? (
              <DetailRow
                label={t("details.fields.securityDepositCollectedAmount")}
                value={formatEur(booking.securityDepositCollectedAmount)}
              />
            ) : null}
            {booking.handoverNotes?.trim() ? (
              <DetailRow label={t("details.fields.handoverNotes")} value={booking.handoverNotes} />
            ) : null}
            {booking.returnRecordedAt ? (
              <DetailRow label={t("details.fields.returnRecordedAt")} value={formatMaltaDateTime(booking.returnRecordedAt)} />
            ) : null}
            {booking.returnNotes?.trim() ? (
              <DetailRow label={t("details.fields.returnNotes")} value={booking.returnNotes} />
            ) : null}
            {booking.depositRefundAmount !== null ? (
              <DetailRow label={t("details.fields.depositRefundAmount")} value={formatEur(booking.depositRefundAmount)} />
            ) : null}
            {booking.depositDeductionAmount !== null ? (
              <DetailRow label={t("details.fields.depositDeductionAmount")} value={formatEur(booking.depositDeductionAmount)} />
            ) : null}
            {booking.depositDeductionReason?.trim() ? (
              <DetailRow label={t("details.fields.depositDeductionReason")} value={booking.depositDeductionReason} />
            ) : null}
            {booking.completionNotes?.trim() ? (
              <DetailRow label={t("details.fields.completionNotes")} value={booking.completionNotes} />
            ) : null}
          </dl>
        </DetailSection>
      ) : null}

      <AdminBookingPriceBuildup locale={locale} booking={booking} />

      <DetailSection title={t("details.sections.audit")}>
        <dl>
          <DetailRow label={t("details.fields.termsAccepted")} value={formatYesNo(booking.termsAccepted)} />
          <DetailRow
            label={t("details.fields.termsAcceptedAt")}
            value={booking.termsAcceptedAt ? formatMaltaDateTime(booking.termsAcceptedAt) : "—"}
          />
          <DetailRow label={t("details.fields.termsVersion")} value={booking.termsVersion ?? "—"} />
          <DetailRow label={t("details.fields.consentSource")} value={booking.consentSource ?? "—"} />
        </dl>

        {booking.statusHistory.length > 0 ? (
          <div className="mt-4 overflow-x-auto">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              {t("details.sections.history")}
            </p>
            <table className="min-w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="pb-2 pr-3 font-semibold">{t("details.history.date")}</th>
                  <th className="pb-2 pr-3 font-semibold">{t("details.history.from")}</th>
                  <th className="pb-2 pr-3 font-semibold">{t("details.history.to")}</th>
                  <th className="pb-2 pr-3 font-semibold">{t("details.history.admin")}</th>
                  <th className="pb-2 font-semibold">{t("details.history.note")}</th>
                </tr>
              </thead>
              <tbody>
                {booking.statusHistory.map((entry) => (
                  <tr key={entry.id} className="border-t border-slate-100">
                    <td className="py-2 pr-3 text-slate-700">{formatMaltaDateTime(entry.createdAt)}</td>
                    <td className="py-2 pr-3 text-slate-700">
                      {entry.oldStatus
                        ? t(`status.${entry.oldStatus}` as "status.CONFIRMED")
                        : "—"}
                    </td>
                    <td className="py-2 pr-3 text-slate-700">
                      {t(`status.${entry.newStatus}` as "status.CONFIRMED")}
                    </td>
                    <td className="py-2 pr-3 text-slate-700">{entry.changedByAdminName ?? "—"}</td>
                    <td className="py-2 text-slate-700">{entry.note ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </DetailSection>
    </div>
  );
}
