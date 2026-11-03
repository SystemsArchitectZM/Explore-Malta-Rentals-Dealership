"use client";

import type { KioskBookingState } from "@/features/kiosk/lib/types";
import { formatEur } from "@/lib/pricing/calculate-booking-price";
import { INSURANCE_PLANS, isInsurancePlanCode } from "@/lib/pricing/insurance-plans";
import { LOGO_PATH } from "@/lib/site-brand-copy";

const MARGIN_X = 20;
const PAGE_WIDTH = 210;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2;
const LOGO_HEIGHT_MM = 18;
const NAVY: [number, number, number] = [12, 35, 64];
const ORANGE: [number, number, number] = [249, 144, 15];
const SLATE: [number, number, number] = [71, 85, 105];
const MUTED: [number, number, number] = [100, 116, 139];

function dash(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : "—";
}

function insuranceLabel(plan: KioskBookingState["addons"]["cdwPlan"]): string {
  if (plan && isInsurancePlanCode(plan)) {
    return INSURANCE_PLANS[plan].label;
  }
  return "—";
}

type PdfDoc = InstanceType<typeof import("jspdf").jsPDF>;

async function loadLogoDataUrl(): Promise<{ dataUrl: string; widthMm: number; heightMm: number } | null> {
  try {
    const response = await fetch(LOGO_PATH);
    if (!response.ok) return null;
    const blob = await response.blob();
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error ?? new Error("Failed to read logo"));
      reader.readAsDataURL(blob);
    });

    const dimensions = await new Promise<{ width: number; height: number }>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => reject(new Error("Failed to decode logo"));
      img.src = dataUrl;
    });

    const aspect =
      dimensions.width > 0 && dimensions.height > 0 ? dimensions.width / dimensions.height : 1;
    return {
      dataUrl,
      widthMm: LOGO_HEIGHT_MM * aspect,
      heightMm: LOGO_HEIGHT_MM,
    };
  } catch {
    return null;
  }
}

function ensureSpace(doc: PdfDoc, y: number, needed: number): number {
  const pageHeight = doc.internal.pageSize.getHeight();
  if (y + needed <= pageHeight - 18) return y;
  doc.addPage();
  return 20;
}

function drawSectionTitle(doc: PdfDoc, title: string, y: number): number {
  y = ensureSpace(doc, y, 14);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.setTextColor(...NAVY);
  doc.text(title, MARGIN_X, y);
  y += 3;
  doc.setDrawColor(...ORANGE);
  doc.setLineWidth(0.6);
  doc.line(MARGIN_X, y, MARGIN_X + 36, y);
  return y + 8;
}

function drawRow(doc: PdfDoc, label: string, value: string, y: number): number {
  const labelWidth = 52;
  const valueLines = doc.splitTextToSize(value, CONTENT_WIDTH - labelWidth) as string[];
  const blockHeight = Math.max(6, valueLines.length * 5);
  y = ensureSpace(doc, y, blockHeight + 2);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(...MUTED);
  doc.text(label, MARGIN_X, y);

  doc.setTextColor(...NAVY);
  doc.text(valueLines, MARGIN_X + labelWidth, y);
  return y + blockHeight;
}

/**
 * Builds and downloads a booking summary PDF for the kiosk confirm screen.
 */
export async function downloadKioskBookingPdf(state: KioskBookingState): Promise<void> {
  const [{ jsPDF }, logo] = await Promise.all([import("jspdf"), loadLogoDataUrl()]);
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const ref = dash(state.meta.bookingReference);
  const deposit = state.meta.depositAmount;
  const dueAtCounter = state.meta.dueAtCounter;
  const amountPaidOnline = state.meta.amountPaidOnline;
  const paidOnline = state.meta.paymentMode === "stripe";
  const loyalty = state.meta.loyaltyCreditAmount ?? 0;
  const subtotal = state.meta.subtotal;

  let y = 16;

  if (logo) {
    const maxWidth = 42;
    const widthMm = Math.min(logo.widthMm, maxWidth);
    const heightMm = widthMm / (logo.widthMm / logo.heightMm);
    doc.addImage(logo.dataUrl, "PNG", MARGIN_X, y, widthMm, heightMm);
    y += heightMm + 8;
  } else {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(...ORANGE);
    doc.text("Explore Malta Rentals", MARGIN_X, y + 4);
    y += 12;
  }

  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.setTextColor(...NAVY);
  doc.text("Booking reserved", MARGIN_X, y);
  y += 7;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(...SLATE);
  const subtitle = doc.splitTextToSize(
    paidOnline
      ? "Thank you — please complete document checks at the counter."
      : "Thank you — please complete payment and document checks at the counter.",
    CONTENT_WIDTH,
  ) as string[];
  doc.text(subtitle, MARGIN_X, y);
  y += subtitle.length * 5 + 6;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(...MUTED);
  doc.text("Your booking reference", MARGIN_X, y);
  y += 7;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.setTextColor(...NAVY);
  doc.text(ref, MARGIN_X, y);
  y += 10;

  const paymentLine = paidOnline
    ? amountPaidOnline != null && amountPaidOnline > 0
      ? `Payment status: paid online — ${formatEur(amountPaidOnline)} charged via Stripe${
          deposit != null ? ` (includes ${formatEur(deposit)} security deposit)` : ""
        }.`
      : "Payment status: settled online."
    : dueAtCounter != null
      ? `Payment status: pending — pay ${formatEur(dueAtCounter)} at the counter${
          deposit != null ? ` (includes ${formatEur(deposit)} security deposit)` : ""
        }.`
      : "Payment status: pending — pay rental + security deposit at the counter.";

  const statusLines: string[] = [
    "Booking status: confirmed / reserved for your dates.",
    paymentLine,
  ];
  if (loyalty > 0) {
    statusLines.push(`Loyalty credit of ${formatEur(loyalty)} was applied to booking charges.`);
  }
  statusLines.push(
    "Documents: verify at counter — bring driving license and passport/ID.",
  );

  const wrappedStatus = statusLines.flatMap(
    (line) => doc.splitTextToSize(`• ${line}`, CONTENT_WIDTH - 8) as string[],
  );
  const boxHeight = 10 + wrappedStatus.length * 5;
  y = ensureSpace(doc, y, boxHeight + 4);
  doc.setFillColor(255, 248, 237);
  doc.setDrawColor(249, 144, 15);
  doc.setLineWidth(0.3);
  doc.roundedRect(MARGIN_X, y, CONTENT_WIDTH, boxHeight, 2, 2, "FD");

  let boxY = y + 6;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.setTextColor(...NAVY);
  doc.text("Not fully completed yet", MARGIN_X + 4, boxY);
  boxY += 6;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(...SLATE);
  for (const line of wrappedStatus) {
    doc.text(line, MARGIN_X + 4, boxY);
    boxY += 5;
  }
  y += boxHeight + 10;

  y = drawSectionTitle(doc, "Vehicle", y);
  y = drawRow(doc, "Vehicle", dash(state.rental.vehicleName), y);
  y = drawRow(doc, "Type", dash(state.rental.vehicleType), y);
  if (state.rental.engineCc != null) {
    y = drawRow(doc, "Engine", `${state.rental.engineCc} cc`, y);
  }
  if (state.rental.selectedColor) {
    y = drawRow(doc, "Color", state.rental.selectedColor, y);
  }
  y = drawRow(
    doc,
    "Pickup",
    `${dash(state.rental.pickupDate)} ${dash(state.rental.pickupTime)}`,
    y,
  );
  y = drawRow(
    doc,
    "Return",
    `${dash(state.rental.returnDate)} ${dash(state.rental.returnTime)}`,
    y,
  );
  y = drawRow(
    doc,
    "Pickup location",
    state.delivery.pickupOption === "delivery"
      ? `Delivery — ${dash(state.delivery.pickupAddress)}`
      : "Office",
    y,
  );
  y = drawRow(
    doc,
    "Return location",
    state.delivery.dropoffOption === "dropoff"
      ? `Drop-off — ${dash(state.delivery.dropoffAddress)}`
      : "Office",
    y,
  );
  y += 4;

  y = drawSectionTitle(doc, "Options", y);
  y = drawRow(doc, "Insurance", insuranceLabel(state.addons.cdwPlan), y);
  if (state.addons.helmetSize1) {
    y = drawRow(doc, "Helmet 1", state.addons.helmetSize1, y);
  }
  if (state.addons.helmetSize2) {
    y = drawRow(doc, "Helmet 2", state.addons.helmetSize2, y);
  }
  y = drawRow(doc, "Storage box", state.addons.storageBox ? "Yes" : "No", y);
  y = drawRow(doc, "Additional driver", state.addons.additionalDriver ? "Yes" : "No", y);
  if (state.hotelCode.appliedCode) {
    const hotelValue =
      state.hotelCode.discountPercent != null
        ? `${state.hotelCode.appliedCode} (−${state.hotelCode.discountPercent}%)`
        : state.hotelCode.appliedCode;
    y = drawRow(doc, "Hotel code", hotelValue, y);
  }
  y += 4;

  y = drawSectionTitle(doc, "Customer", y);
  y = drawRow(doc, "Full name", dash(state.customer.fullName), y);
  y = drawRow(doc, "Phone", dash(state.customer.phone), y);
  y = drawRow(doc, "Email", dash(state.customer.email), y);
  y = drawRow(doc, "Nationality", dash(state.customer.nationality), y);
  y = drawRow(doc, "Date of birth", dash(state.customer.dateOfBirth), y);
  y = drawRow(doc, "License category", dash(state.customer.licenseCategory), y);
  if (state.customer.specialNotes.trim()) {
    y = drawRow(doc, "Special notes", state.customer.specialNotes.trim(), y);
  }

  if (state.addons.additionalDriver) {
    y += 4;
    y = drawSectionTitle(doc, "Additional driver", y);
    y = drawRow(doc, "Full name", dash(state.additionalDriver.fullName), y);
    y = drawRow(doc, "Phone", dash(state.additionalDriver.phone), y);
    y = drawRow(doc, "Email", dash(state.additionalDriver.email), y);
    y = drawRow(doc, "Nationality", dash(state.additionalDriver.nationality), y);
    y = drawRow(doc, "Date of birth", dash(state.additionalDriver.dateOfBirth), y);
    y = drawRow(doc, "License category", dash(state.additionalDriver.licenseCategory), y);
  }

  y += 4;
  y = drawSectionTitle(doc, "Payment summary", y);
  if (subtotal != null) {
    y = drawRow(doc, "Rental & add-ons", formatEur(subtotal), y);
  }
  if (loyalty > 0) {
    y = drawRow(doc, "Loyalty credit", `−${formatEur(loyalty)}`, y);
  }
  if (deposit != null) {
    y = drawRow(doc, "Security deposit", formatEur(deposit), y);
  }
  if (dueAtCounter != null) {
    y = drawRow(doc, "Due at counter", formatEur(dueAtCounter), y);
  }
  y = drawRow(doc, "Payment status", "Pending — pay at counter", y);

  y = ensureSpace(doc, y + 8, 12);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(...MUTED);
  doc.text(
    "Generated by Explore Malta Rentals kiosk. Present this reference at the counter.",
    MARGIN_X,
    y,
  );

  const safeRef = (state.meta.bookingReference || "booking").replace(/[^\w-]+/g, "_");
  doc.save(`Explore-Malta-Rentals-${safeRef}.pdf`);
}
