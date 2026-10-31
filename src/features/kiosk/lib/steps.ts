export const KIOSK_STEPS = [
  { id: "availability", label: "Availability" },
  { id: "vehicles", label: "Vehicles" },
  { id: "vehicle_details", label: "Vehicle Details" },
  { id: "options", label: "Options" },
  { id: "customer", label: "Customer" },
  { id: "review", label: "Review" },
  { id: "confirm", label: "Confirm" },
] as const;

export type KioskStepId = (typeof KIOSK_STEPS)[number]["id"];
