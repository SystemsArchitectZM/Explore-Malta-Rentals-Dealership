"use client";

import * as Popover from "@radix-ui/react-popover";
import { ChevronDown, Clock } from "lucide-react";
import { useState } from "react";
import { BOOKING_TIME_SLOTS } from "@/features/booking/lib/time-slots";

type KioskTimeSelectProps = {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  slots?: readonly string[];
};

export function KioskTimeSelect({
  id,
  label,
  value,
  onChange,
  slots = BOOKING_TIME_SLOTS,
}: KioskTimeSelectProps) {
  const [open, setOpen] = useState(false);
  const display = value || "Select time";

  return (
    <div className="block">
      <label htmlFor={id} className="text-sm font-semibold text-slate-700">
        {label}
      </label>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button
            id={id}
            type="button"
            aria-haspopup="listbox"
            className="mt-2 flex min-h-16 w-full items-center gap-3 rounded-xl border-2 border-slate-300 bg-white px-4 text-left text-lg font-semibold text-[#0c2340] transition hover:border-[#f9900f] focus-visible:border-[#f9900f] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f9900f]/30 data-[state=open]:border-[#f9900f] data-[state=open]:ring-2 data-[state=open]:ring-[#f9900f]/25"
          >
            <Clock className="h-6 w-6 shrink-0 text-[#f9900f]" aria-hidden />
            <span className={`min-w-0 flex-1 truncate tabular-nums ${value ? "" : "text-slate-400"}`}>
              {display}
            </span>
            <ChevronDown
              className={`h-5 w-5 shrink-0 text-slate-400 transition ${open ? "rotate-180" : ""}`}
              aria-hidden
            />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            side="bottom"
            align="start"
            sideOffset={8}
            collisionPadding={24}
            avoidCollisions
            className="z-[200] w-[var(--radix-popover-trigger-width)] min-w-[14rem] overflow-hidden rounded-2xl border border-slate-200 bg-white p-2 shadow-2xl"
          >
            <div
              role="listbox"
              aria-labelledby={id}
              className="max-h-[min(20rem,calc(100dvh-10rem))] overflow-y-auto overscroll-contain"
            >
              {slots.map((slot) => {
                const selected = slot === value;
                return (
                  <button
                    key={slot}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className={`flex min-h-14 w-full items-center rounded-xl px-4 text-left text-lg tabular-nums transition ${
                      selected
                        ? "bg-[#f9900f] font-bold text-white"
                        : "font-semibold text-[#0c2340] hover:bg-orange-50"
                    }`}
                    onClick={() => {
                      onChange(slot);
                      setOpen(false);
                    }}
                  >
                    {slot}
                  </button>
                );
              })}
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
