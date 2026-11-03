"use client";

import * as Popover from "@radix-ui/react-popover";
import { CalendarDays, ChevronDown } from "lucide-react";
import { useMemo, useState } from "react";
import { DayPicker } from "react-day-picker";
import { format, parse, startOfDay, subYears } from "date-fns";
import "react-day-picker/style.css";

type KioskDatePickerProps = {
  id: string;
  label: string;
  value: string;
  min?: string;
  max?: string;
  placeholder?: string;
  /** Month/year dropdowns — useful for date of birth. */
  yearDropdown?: boolean;
  size?: "default" | "large";
  onChange: (isoDate: string) => void;
};

function parseIso(value: string): Date | undefined {
  if (!value) return undefined;
  const parsed = parse(value, "yyyy-MM-dd", new Date());
  return Number.isNaN(parsed.getTime()) ? undefined : startOfDay(parsed);
}

export function KioskDatePicker({
  id,
  label,
  value,
  min,
  max,
  placeholder = "Select date",
  yearDropdown = false,
  size = "large",
  onChange,
}: KioskDatePickerProps) {
  const [open, setOpen] = useState(false);
  const selected = useMemo(() => parseIso(value), [value]);
  const minDate = useMemo(() => parseIso(min ?? ""), [min]);
  const maxDate = useMemo(() => parseIso(max ?? ""), [max]);
  const isLarge = size === "large";

  const display = selected ? format(selected, "EEE, dd MMM yyyy") : placeholder;

  const disabled = [
    ...(minDate ? [{ before: minDate }] : []),
    ...(maxDate ? [{ after: maxDate }] : []),
  ];

  const defaultMonth = useMemo(() => {
    if (selected) return selected;
    if (yearDropdown) {
      const preferred = startOfDay(subYears(new Date(), 25));
      if (maxDate && preferred > maxDate) return maxDate;
      if (minDate && preferred < minDate) return minDate;
      return preferred;
    }
    return minDate ?? maxDate ?? new Date();
  }, [selected, yearDropdown, minDate, maxDate]);

  return (
    <div className="block">
      <label
        htmlFor={id}
        className={isLarge ? "text-sm font-semibold text-slate-700" : "text-sm font-medium text-slate-700"}
      >
        {label}
      </label>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button
            id={id}
            type="button"
            className={[
              "mt-2 flex w-full items-center gap-3 rounded-xl border-2 border-slate-300 bg-white px-4 text-left font-semibold text-[#0c2340] transition hover:border-[#f9900f] focus-visible:border-[#f9900f] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f9900f]/30 data-[state=open]:border-[#f9900f] data-[state=open]:ring-2 data-[state=open]:ring-[#f9900f]/25",
              isLarge ? "min-h-16 text-lg" : "min-h-14 text-base",
            ].join(" ")}
          >
            <CalendarDays
              className={`${isLarge ? "h-6 w-6" : "h-5 w-5"} shrink-0 text-[#f9900f]`}
              aria-hidden
            />
            <span className={`min-w-0 flex-1 truncate tabular-nums ${selected ? "" : "text-slate-400"}`}>
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
            className="z-[200] w-[min(100vw-2rem,24rem)] rounded-2xl border border-slate-200 bg-white p-4 shadow-2xl"
          >
            <DayPicker
              mode="single"
              selected={selected}
              defaultMonth={defaultMonth}
              onSelect={(date) => {
                if (!date) return;
                onChange(format(startOfDay(date), "yyyy-MM-dd"));
                setOpen(false);
              }}
              disabled={disabled}
              captionLayout={yearDropdown ? "dropdown" : "label"}
              startMonth={minDate}
              endMonth={maxDate}
              className="kiosk-day-picker mx-auto"
            />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
