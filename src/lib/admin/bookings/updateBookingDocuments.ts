import { z } from "zod";

import { getAdminBookingById } from "@/lib/admin/bookings/getAdminBookingById";
import { recordBookingStatusChange } from "@/lib/admin/bookings/lifecycle/recordBookingStatusChange";
import type { AdminBookingDetail } from "@/lib/admin/bookings/types";
import { prisma } from "@/lib/prisma";

const uploadPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine(
    (value) => value.startsWith("uploads/") || value.startsWith("/uploads/"),
    "Upload path must be an uploads/* path",
  );

export const updateBookingDocumentsSchema = z
  .object({
    customerLicenseUploadPath: uploadPathSchema.optional(),
    customerPassportUploadPath: uploadPathSchema.optional(),
    additionalDriverLicenseUploadPath: uploadPathSchema.optional(),
    additionalDriverPassportUploadPath: uploadPathSchema.optional(),
    note: z.string().trim().max(500).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      !value.customerLicenseUploadPath &&
      !value.customerPassportUploadPath &&
      !value.additionalDriverLicenseUploadPath &&
      !value.additionalDriverPassportUploadPath
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide at least one document to update",
      });
    }
  });

export type UpdateBookingDocumentsInput = z.infer<typeof updateBookingDocumentsSchema>;

export type UpdateBookingDocumentsResult =
  | { ok: true; booking: AdminBookingDetail }
  | { ok: false; reason: "not_found" | "invalid_status" };

function normalizeUploadPath(path: string): string {
  return path.startsWith("/") ? path.slice(1) : path;
}

/**
 * Attaches / replaces customer (and optional additional-driver) ID documents
 * captured at the counter for kiosk or in-person bookings.
 */
export async function updateBookingDocuments(
  bookingId: string,
  input: UpdateBookingDocumentsInput,
  adminUserId: string,
): Promise<UpdateBookingDocumentsResult> {
  const existing = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      status: true,
      additionalDriverEnabled: true,
      customerLicenseUploadPath: true,
      customerPassportUploadPath: true,
      additionalDriverLicenseUploadPath: true,
      additionalDriverPassportUploadPath: true,
    },
  });

  if (!existing) {
    return { ok: false, reason: "not_found" };
  }

  if (
    existing.status === "COMPLETED" ||
    existing.status === "CANCELLED"
  ) {
    return { ok: false, reason: "invalid_status" };
  }

  const nextLicense = input.customerLicenseUploadPath
    ? normalizeUploadPath(input.customerLicenseUploadPath)
    : undefined;
  const nextPassport = input.customerPassportUploadPath
    ? normalizeUploadPath(input.customerPassportUploadPath)
    : undefined;
  const nextAddLicense =
    existing.additionalDriverEnabled && input.additionalDriverLicenseUploadPath
      ? normalizeUploadPath(input.additionalDriverLicenseUploadPath)
      : undefined;
  const nextAddPassport =
    existing.additionalDriverEnabled && input.additionalDriverPassportUploadPath
      ? normalizeUploadPath(input.additionalDriverPassportUploadPath)
      : undefined;

  const updatedLicensePath = nextLicense ?? existing.customerLicenseUploadPath;
  const updatedPassportPath = nextPassport ?? existing.customerPassportUploadPath;

  await prisma.$transaction(async (tx) => {
    await tx.booking.update({
      where: { id: bookingId },
      data: {
        ...(nextLicense
          ? {
              customerLicenseUploadPath: nextLicense,
              customerWillPresentLicenseAtPickup: false,
            }
          : {}),
        ...(nextPassport
          ? {
              customerPassportUploadPath: nextPassport,
              customerWillPresentIdAtPickup: false,
            }
          : {}),
        ...(nextAddLicense ? { additionalDriverLicenseUploadPath: nextAddLicense } : {}),
        ...(nextAddPassport ? { additionalDriverPassportUploadPath: nextAddPassport } : {}),
      },
    });

    const parts: string[] = [];
    if (nextLicense) parts.push("driving licence");
    if (nextPassport) parts.push("passport/ID");
    if (nextAddLicense) parts.push("additional driver licence");
    if (nextAddPassport) parts.push("additional driver passport/ID");

    await recordBookingStatusChange(tx, {
      bookingId,
      oldStatus: existing.status,
      newStatus: existing.status,
      adminUserId,
      note:
        input.note?.trim() ||
        `Counter documents updated: ${parts.join(", ")}.${
          updatedLicensePath && updatedPassportPath
            ? " Customer licence and ID are on file."
            : ""
        }`,
    });
  });

  const booking = await getAdminBookingById(bookingId);
  if (!booking) {
    return { ok: false, reason: "not_found" };
  }

  return { ok: true, booking };
}
