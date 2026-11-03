"use client";

import { useState } from "react";
import { Download, PartyPopper } from "lucide-react";
import { useRouter } from "@/i18n/navigation";
import { KioskPanel } from "@/features/kiosk/components/kiosk-panel";
import { useKioskBooking } from "@/features/kiosk/context/kiosk-booking-context";
import { downloadKioskBookingPdf } from "@/features/kiosk/lib/download-booking-pdf";
import { formatEur } from "@/lib/pricing/calculate-booking-price";

export function ConfirmStep() {
  const router = useRouter();
  const { state, resetSession } = useKioskBooking();
  const deposit = state.meta.depositAmount;
  const dueAtCounter = state.meta.dueAtCounter;
  const loyalty = state.meta.loyaltyCreditAmount ?? 0;
  const [isSavingPdf, setIsSavingPdf] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);

  const startNew = async () => {
    await resetSession();
    router.replace("/kiosk");
  };

  const saveAsPdf = async () => {
    setPdfError(null);
    setIsSavingPdf(true);
    try {
      await downloadKioskBookingPdf(state);
    } catch {
      setPdfError("Could not save the PDF. Please try again.");
    } finally {
      setIsSavingPdf(false);
    }
  };

  return (
    <KioskPanel
      title="Booking reserved"
      subtitle="Thank you — please complete payment and document checks at the counter."
      icon={<PartyPopper className="h-6 w-6" aria-hidden />}
    >
      <p className="text-sm text-slate-600">Your booking reference</p>
      <p className="mt-2 break-all text-3xl font-black tracking-tight text-[#0c2340] sm:text-4xl">
        {state.meta.bookingReference || "—"}
      </p>
      <div className="mt-6 rounded-xl border border-[#f9900f]/30 bg-[#fff8ed] px-4 py-4 text-sm text-slate-700">
        <p className="font-semibold text-[#0c2340]">Not fully completed yet</p>
        <ul className="mt-2 list-disc space-y-2 pl-5">
          <li>
            Booking status: <strong>confirmed / reserved</strong> for your dates.
          </li>
          <li>
            Payment status: <strong>pending</strong>
            {dueAtCounter != null ? (
              <>
                {" "}
                — pay <strong>{formatEur(dueAtCounter)}</strong> at the counter
                {deposit != null ? ` (includes ${formatEur(deposit)} security deposit)` : ""}.
              </>
            ) : (
              " — pay rental + security deposit at the counter."
            )}
          </li>
          {loyalty > 0 ? (
            <li>
              Loyalty credit of <strong>{formatEur(loyalty)}</strong> was applied to booking charges.
            </li>
          ) : null}
          <li>
            Documents: <strong>verify at counter</strong> — bring driving license and passport/ID.
          </li>
        </ul>
      </div>
      {pdfError ? (
        <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
          {pdfError}
        </p>
      ) : null}
      <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
        <button
          type="button"
          onClick={() => void saveAsPdf()}
          disabled={isSavingPdf}
          className="inline-flex min-h-14 items-center justify-center gap-2 rounded-xl border-2 border-[#0c2340] bg-white px-6 text-base font-bold text-[#0c2340] disabled:opacity-60"
        >
          <Download className="h-5 w-5" aria-hidden />
          {isSavingPdf ? "Saving PDF…" : "Save as PDF"}
        </button>
        <button
          type="button"
          onClick={() => void startNew()}
          className="min-h-14 rounded-xl bg-[#f9900f] px-6 text-base font-bold text-white"
        >
          Start New Booking
        </button>
      </div>
    </KioskPanel>
  );
}
