import { z } from "zod";

const optionalNoteSchema = z.string().trim().max(500).optional();

export const handOverVehicleSchema = z.object({
  paymentReceivedAmount: z.coerce.number().min(0),
  paymentMethod: z.enum(["CASH", "CARD", "BANK", "OTHER"]),
  paymentConfirmed: z.boolean(),
  securityDepositCollectedAmount: z.coerce.number().min(0),
  depositCollectedConfirmed: z.boolean(),
  handoverDateTime: z.coerce.date(),
  handoverNotes: z.string().trim().max(1000).optional(),
  vehicleUnitId: z.string().cuid().optional(),
  note: optionalNoteSchema,
});

export const markVehicleReturnedSchema = z.object({
  returnRecordedAt: z.coerce.date(),
  returnNotes: z.string().trim().max(1000).optional(),
  unitStatusAfterReturn: z.enum(["AVAILABLE", "MAINTENANCE"]),
  note: optionalNoteSchema,
});

export const completeBookingSchema = z
  .object({
    depositOutcome: z.enum(["REFUNDED", "DEDUCTED"]),
    depositRefundAmount: z.coerce.number().min(0).optional(),
    depositDeductionAmount: z.coerce.number().min(0).optional(),
    depositDeductionReason: z.string().trim().max(500).optional(),
    unitStatusAfterCompletion: z.enum(["AVAILABLE", "MAINTENANCE", "NOT_AVAILABLE"]).default("AVAILABLE"),
    completionNotes: z.string().trim().max(1000).optional(),
    note: optionalNoteSchema,
  })
  .superRefine((value, ctx) => {
    if (value.depositOutcome === "DEDUCTED") {
      if (value.depositDeductionAmount === undefined || value.depositDeductionAmount <= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Deduction amount is required when deposit is deducted",
          path: ["depositDeductionAmount"],
        });
      }
      if (!value.depositDeductionReason?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Deduction reason is required when deposit is deducted",
          path: ["depositDeductionReason"],
        });
      }
    }
  });

export const cancelBookingSchema = z.object({
  /**
   * Legacy flag. Accepted for API compatibility but ignored for payment status.
   * Cancellation never marks a Stripe rental payment as REFUNDED.
   */
  refundPayment: z.boolean().default(false),
  depositOutcome: z.enum(["UNCHANGED", "REFUNDED", "DEDUCTED"]).default("UNCHANGED"),
  depositRefundAmount: z.coerce.number().min(0).optional(),
  depositDeductionAmount: z.coerce.number().min(0).optional(),
  depositDeductionReason: z.string().trim().max(500).optional(),
  note: optionalNoteSchema,
  emailSubject: z.string().trim().min(1).max(200),
  emailBody: z.string().trim().min(1).max(8000),
});

export const restoreCancelledBookingSchema = z.object({
  note: optionalNoteSchema,
});

export type HandOverVehicleInput = z.infer<typeof handOverVehicleSchema>;
export type MarkVehicleReturnedInput = z.infer<typeof markVehicleReturnedSchema>;
export type CompleteBookingInput = z.infer<typeof completeBookingSchema>;
export type CancelBookingInput = z.infer<typeof cancelBookingSchema>;
export type RestoreCancelledBookingInput = z.infer<typeof restoreCancelledBookingSchema>;
