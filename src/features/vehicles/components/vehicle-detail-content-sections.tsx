"use client";

import { useState } from "react";
import {
  BadgeCheck,
  CheckCircle2,
  ChevronDown,
  Cpu,
  Fuel,
  Lock,
  MapPin,
  Settings2,
  Shield,
  Users,
} from "lucide-react";
import { formatVehicleTypeLabel, type Vehicle } from "@/features/vehicles/data/vehicles";

const sectionHeadingClass = "text-lg font-bold text-[var(--ink-950)] sm:text-xl";

export function ExpandableDescription({
  text,
  className = "text-base leading-relaxed text-[var(--text-secondary)]",
}: {
  text: string;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const short = text.length > 320;

  return (
    <div>
      <p className={[className, !expanded && short ? "line-clamp-4" : ""].filter(Boolean).join(" ")}>
        {text}
      </p>
      {short ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="mt-3 flex items-center gap-1.5 text-sm font-semibold text-[var(--blue-600)] underline-offset-4 transition-colors hover:text-[var(--blue-700)] hover:underline"
        >
          {expanded ? "Show less" : "Read more"}
          <ChevronDown
            className={[
              "h-4 w-4 transition-transform",
              expanded ? "rotate-180" : "",
            ].join(" ")}
            aria-hidden
          />
        </button>
      ) : null}
    </div>
  );
}

export function KeyInfoBar({ vehicle }: { vehicle: Vehicle }) {
  const specs = [
    {
      icon: <Cpu className="h-5 w-5" aria-hidden />,
      label: "Engine",
      value: vehicle.engine || "—",
    },
    {
      icon: <Settings2 className="h-5 w-5" aria-hidden />,
      label: "Transmission",
      value: vehicle.transmission,
    },
    {
      icon: <Fuel className="h-5 w-5" aria-hidden />,
      label: "Fuel",
      value: vehicle.fuel,
    },
    {
      icon: <Users className="h-5 w-5" aria-hidden />,
      label: "Seats",
      value: String(vehicle.seats),
    },
    {
      icon: <Shield className="h-5 w-5" aria-hidden />,
      label: "Helmets",
      value: vehicle.helmetIncludedCount > 0 ? `${vehicle.helmetIncludedCount} included` : "On request",
    },
  ];

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className="grid grid-cols-2 gap-px bg-slate-200">
        {specs.map((spec) => (
          <div
            key={spec.label}
            className="flex flex-col items-center gap-1.5 bg-white px-3 py-4 text-center last:col-span-2"
          >
            <span className="text-[var(--blue-500)]">{spec.icon}</span>
            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
              {spec.label}
            </span>
            <span className="text-sm font-semibold text-[#0c2340]">{spec.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function FeaturesList({ vehicle }: { vehicle: Vehicle }) {
  const items = [
    vehicle.helmetIncludedCount > 0 && `${vehicle.helmetIncludedCount} helmet(s) included`,
    vehicle.supportsStorageBox && "Storage box available",
    vehicle.transmission === "Automatic" && "Automatic transmission",
    vehicle.fuel !== "Human powered" && "Petrol engine",
    vehicle.fuel === "Human powered" && "Eco-friendly — no fuel cost",
    "Safety briefing at pickup",
    "Phone holder accessory",
    "Email & phone support during rental",
    vehicle.engine && `${vehicle.engine} engine`,
  ].filter(Boolean) as string[];

  return (
    <ul className="grid gap-x-6 sm:grid-cols-2">
      {items.map((item) => (
        <li
          key={item}
          className="flex items-start gap-2.5 border-b border-slate-100 py-2.5 text-sm leading-relaxed text-slate-800"
        >
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden />
          {item}
        </li>
      ))}
    </ul>
  );
}

export function LocationSection({ location }: { location: string }) {
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2.5 text-sm leading-relaxed text-slate-800">
        <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-[#f9900f]" aria-hidden />
        <span>
          Pickup & return at <span className="font-semibold text-[#0c2340]">{location}</span> — Explore
          Malta Rentals, Pietà
        </span>
      </div>
      <p className="text-xs leading-relaxed text-slate-500">
        Hotel delivery and custom drop-off available on request — ask us on WhatsApp.
      </p>
      <div className="aspect-[16/6] overflow-hidden rounded-xl bg-slate-100 shadow-sm ring-1 ring-slate-200">
        <iframe
          title={`Map showing ${location}`}
          src="https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d12971.66892988892!2d14.487860399999999!3d35.896389!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x130e4541df9b1f5b%3A0x88e68b52e93fdc6b!2sPiet%C3%A0%2C%20Malta!5e0!3m2!1sen!2smt!4v1700000000000"
          className="h-full w-full border-0"
          allowFullScreen
          loading="lazy"
          referrerPolicy="no-referrer-when-downgrade"
        />
      </div>
    </div>
  );
}

export function PoliciesSection({ vehicle }: { vehicle: Vehicle }) {
  const isBike = vehicle.type !== "Bicycle";
  const cellClass = "border-b border-slate-100 py-4";
  const bodyClass = "mt-1.5 text-sm leading-relaxed text-slate-600";

  return (
    <dl className="grid gap-x-8 sm:grid-cols-2">
      <div className={cellClass}>
        <dt className="flex items-center gap-2 text-sm font-semibold text-[#0c2340]">
          <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden />
          Cancellation
        </dt>
        <dd className={bodyClass}>
          No payment charged online during initial reservation. Availability confirmed after review.
          Contact support early for changes.
        </dd>
      </div>
      <div className={cellClass}>
        <dt className="flex items-center gap-2 text-sm font-semibold text-[#0c2340]">
          <BadgeCheck className="h-4 w-4 text-[var(--blue-500)]" aria-hidden />
          Licence requirement
        </dt>
        <dd className={bodyClass}>
          {isBike
            ? vehicle.engine === "50cc"
              ? "Category B (standard car licence) typically accepted for 50cc — confirm at booking."
              : "Motorcycle licence required (A, A1 or A2 depending on your country)."
            : "No licence required for bicycle rental — must follow local road rules."}
        </dd>
      </div>
      <div className={cellClass}>
        <dt className="flex items-center gap-2 text-sm font-semibold text-[#0c2340]">
          <Lock className="h-4 w-4 text-slate-400" aria-hidden />
          Security deposit
        </dt>
        <dd className={bodyClass}>
          {vehicle.securityDepositEUR != null
            ? `EUR ${vehicle.securityDepositEUR} refundable deposit required at handover.`
            : "Deposit amount confirmed when booking is reviewed."}
        </dd>
      </div>
      <div className={cellClass}>
        <dt className="flex items-center gap-2 text-sm font-semibold text-[#0c2340]">
          <Shield className="h-4 w-4 text-slate-400" aria-hidden />
          Documents at pickup
        </dt>
        <dd className={bodyClass}>
          Valid driving licence + government-issued ID or passport required at handover.
        </dd>
      </div>
    </dl>
  );
}

export function VehicleSpecsList({ vehicle }: { vehicle: Vehicle }) {
  const typeLabel = formatVehicleTypeLabel(vehicle.apiVehicleType);
  const brandModel = [vehicle.brand, vehicle.model].filter(Boolean).join(" ") || null;

  const rows = [
    { label: "Vehicle type", value: typeLabel },
    { label: "Brand / Model", value: brandModel ?? "Not specified" },
    { label: "Engine", value: vehicle.engine || "—" },
    { label: "Transmission", value: vehicle.transmission },
    { label: "Fuel", value: vehicle.fuel },
    { label: "Seats", value: String(vehicle.seats) },
    {
      label: "Color",
      value:
        vehicle.availableColors && vehicle.availableColors.length > 0
          ? vehicle.availableColors.map((color) => color.label).join(", ")
          : vehicle.color ?? "—",
    },
    {
      label: "Storage box",
      value: vehicle.supportsStorageBox ? "Supported (optional add-on)" : "Not supported",
    },
    { label: "Helmets included", value: String(vehicle.helmetIncludedCount) },
    { label: "Pickup location", value: vehicle.location },
  ];

  return (
    <dl className="grid gap-x-8 sm:grid-cols-2">
      {rows.map(({ label, value }) => (
        <div
          key={label}
          className="flex items-baseline justify-between gap-4 border-b border-slate-100 py-3"
        >
          <dt className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
            {label}
          </dt>
          <dd className="text-right text-sm font-semibold text-[#0c2340]">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function VehicleDetailSections({
  vehicle,
  headingClassName = sectionHeadingClass,
}: {
  vehicle: Vehicle;
  headingClassName?: string;
}) {
  return (
    <div className="space-y-8">
      <section aria-labelledby="kiosk-v-about-h">
        <h4 id="kiosk-v-about-h" className={headingClassName}>
          About this vehicle
        </h4>
        <div className="mt-3">
          <ExpandableDescription
            text={vehicle.description}
            className="text-sm leading-relaxed text-slate-600 sm:text-base"
          />
        </div>
      </section>

      <KeyInfoBar vehicle={vehicle} />

      <section aria-labelledby="kiosk-v-features-h">
        <h4 id="kiosk-v-features-h" className={headingClassName}>
          What&apos;s included
        </h4>
        <div className="mt-4">
          <FeaturesList vehicle={vehicle} />
        </div>
      </section>

      <hr className="border-slate-200" />

      <section aria-labelledby="kiosk-v-specs-h">
        <h4 id="kiosk-v-specs-h" className={headingClassName}>
          Specifications
        </h4>
        <div className="mt-4">
          <VehicleSpecsList vehicle={vehicle} />
        </div>
      </section>

      <hr className="border-slate-200" />

      <section aria-labelledby="kiosk-v-location-h">
        <h4 id="kiosk-v-location-h" className={headingClassName}>
          Location &amp; pickup
        </h4>
        <div className="mt-4">
          <LocationSection location={vehicle.location} />
        </div>
      </section>

      <hr className="border-slate-200" />

      <section aria-labelledby="kiosk-v-policies-h">
        <h4 id="kiosk-v-policies-h" className={headingClassName}>
          Policies &amp; requirements
        </h4>
        <div className="mt-4">
          <PoliciesSection vehicle={vehicle} />
        </div>
      </section>
    </div>
  );
}
