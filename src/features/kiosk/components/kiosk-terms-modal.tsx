"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { pricingConfig } from "@/lib/pricing/calculate-booking-price";

const TERMS_SUMMARY_SECTIONS = [
  {
    heading: "Driver Requirements",
    points: [
      "Minimum age is 21 years for all rentals, including 50cc, 125cc, and ATV.",
      "A valid driving licence and passport/ID must be presented at pickup.",
      "Non-EU licence holders may need an International Driving Permit (IDP).",
    ],
  },
  {
    heading: "Rental Period",
    points: [
      "Rentals are calculated by day.",
      "Late return may incur an additional fee and extra rental day charge.",
      "No-show or delays above one hour may result in cancellation.",
    ],
  },
  {
    heading: "Payments",
    points: [
      "Full rental payment is required before vehicle release.",
      "Accepted payment methods are cash and card.",
      "Kiosk bookings are paid at the shop counter (no online card charge on this tablet).",
      "Displayed prices include VAT and basic insurance.",
    ],
  },
  {
    heading: "Security Deposit",
    points: [
      `A refundable security deposit of EUR ${pricingConfig.deposit.amount} is collected at pickup for all vehicles.`,
      "Deposit release may take up to 7-10 days after return checks.",
    ],
  },
  {
    heading: "Insurance & Liability",
    points: [
      "Third-party insurance is included; excess liability depends on vehicle category.",
      "Optional CDW can reduce excess liability according to the selected plan.",
    ],
  },
  {
    heading: "Use of Vehicle",
    points: [
      "Dangerous driving, racing, sub-renting, and taking vehicles outside Malta are prohibited.",
      "Helmets are mandatory and must be used correctly during the rental period.",
    ],
  },
  {
    heading: "Cancellation",
    points: [
      "Cancellations more than 48 hours before rental start may be eligible for a 50% refund.",
      "Cancellations within 48 hours of start time are non-refundable.",
    ],
  },
  {
    heading: "GDPR",
    points: [
      "Customer data is processed under GDPR only for rental and legal compliance.",
    ],
  },
] as const;

type KioskTermsModalProps = {
  isOpen: boolean;
  onCancel: () => void;
  onAgree: () => void;
};

export function KioskTermsModal({ isOpen, onCancel, onAgree }: KioskTermsModalProps) {
  const [mounted, setMounted] = useState(false);
  const [confirmChecked, setConfirmChecked] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!isOpen) {
      setConfirmChecked(false);
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, onCancel]);

  if (!isOpen || !mounted) {
    return null;
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-[#0a1420]/60 p-4 backdrop-blur-sm sm:p-6"
      role="presentation"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="kiosk-terms-title"
        className="flex max-h-[min(90dvh,880px)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white text-[#0c2340] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4 sm:px-6">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#f9900f]">
              Please review
            </p>
            <h3 id="kiosk-terms-title" className="mt-1 text-xl font-bold sm:text-2xl">
              Terms & conditions
            </h3>
            <p className="mt-1 text-sm text-slate-600">
              Read the summary, then confirm below to continue your booking.
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-slate-200 text-slate-600"
            aria-label="Close terms"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4 sm:px-6">
          <div className="space-y-3">
            {TERMS_SUMMARY_SECTIONS.map((section) => (
              <section
                key={section.heading}
                className="rounded-xl border border-slate-200 bg-slate-50 p-4"
              >
                <h4 className="text-sm font-bold text-[#0c2340]">{section.heading}</h4>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-relaxed text-slate-700">
                  {section.points.map((point) => (
                    <li key={point}>{point}</li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </div>

        <footer className="border-t border-slate-200 bg-slate-50 px-5 py-4 sm:px-6">
          <label className="flex min-h-12 cursor-pointer items-start gap-3 rounded-xl border border-slate-200 bg-white p-4">
            <input
              type="checkbox"
              checked={confirmChecked}
              onChange={(event) => setConfirmChecked(event.target.checked)}
              className="mt-0.5 h-5 w-5 shrink-0 accent-[#f9900f]"
            />
            <span className="text-sm font-medium text-[#0c2340]">
              I have read and agree to the terms & conditions.
            </span>
          </label>

          <div className="mt-4 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={onCancel}
              className="inline-flex min-h-12 items-center justify-center rounded-xl border-2 border-[#0c2340] px-6 text-base font-semibold text-[#0c2340]"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!confirmChecked}
              onClick={onAgree}
              className="inline-flex min-h-12 items-center justify-center rounded-xl bg-[#f9900f] px-8 text-base font-bold text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              I Agree
            </button>
          </div>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
