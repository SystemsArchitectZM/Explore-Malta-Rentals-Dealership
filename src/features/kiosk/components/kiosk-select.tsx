"use client";

import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown } from "lucide-react";
import { useId, useMemo, useState } from "react";

export type KioskSelectOption = Readonly<{
  value: string;
  label: string;
}>;

type KioskSelectProps = {
  id?: string;
  label: string;
  value: string;
  options: readonly KioskSelectOption[];
  placeholder?: string;
  hint?: string;
  /** Keep the panel no wider than the trigger (good for short values like M / L / XL). */
  matchTriggerWidth?: boolean;
  onChange: (value: string) => void;
};

export function KioskSelect({
  id: idProp,
  label,
  value,
  options,
  placeholder = "Select",
  hint,
  matchTriggerWidth = true,
  onChange,
}: KioskSelectProps) {
  const generatedId = useId();
  const id = idProp ?? generatedId;
  const [open, setOpen] = useState(false);

  const selected = useMemo(
    () => options.find((option) => option.value === value) ?? null,
    [options, value],
  );
  const display = selected?.label ?? placeholder;

  return (
    <div className="block">
      <label htmlFor={id} className="text-sm font-medium text-slate-700">
        {label}
      </label>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button
            id={id}
            type="button"
            aria-haspopup="listbox"
            aria-expanded={open}
            className="mt-2 flex min-h-14 w-full items-center gap-3 rounded-xl border-2 border-slate-300 bg-white px-4 text-left text-base font-semibold text-[#0c2340] transition hover:border-[#f9900f] focus-visible:border-[#f9900f] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f9900f]/30 data-[state=open]:border-[#f9900f] data-[state=open]:ring-2 data-[state=open]:ring-[#f9900f]/25"
          >
            <span className={`min-w-0 flex-1 truncate ${selected ? "" : "text-slate-400"}`}>
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
            sideOffset={6}
            collisionPadding={16}
            avoidCollisions
            className={[
              "z-[200] overflow-hidden rounded-xl border border-slate-200 bg-white p-1.5 shadow-xl",
              matchTriggerWidth
                ? "w-[var(--radix-popover-trigger-width)]"
                : "w-[min(var(--radix-popover-trigger-width),18rem)]",
            ].join(" ")}
          >
            <div
              role="listbox"
              aria-labelledby={id}
              className="max-h-[min(16rem,calc(100dvh-12rem))] overflow-y-auto overscroll-contain"
            >
              {options.map((option) => {
                const isSelected = option.value === value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    className={`flex min-h-12 w-full items-center gap-2 rounded-lg px-3 text-left text-base transition ${
                      isSelected
                        ? "bg-[#f9900f] font-bold text-white"
                        : "font-semibold text-[#0c2340] hover:bg-sky-100"
                    }`}
                    onClick={() => {
                      onChange(option.value);
                      setOpen(false);
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    {isSelected ? <Check className="h-4 w-4 shrink-0" aria-hidden /> : null}
                  </button>
                );
              })}
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}
