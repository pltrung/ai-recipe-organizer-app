"use client";

type LinkInputProps = {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
};

export function LinkInput({
  value,
  onChange,
  placeholder = "Paste link...",
  disabled,
}: LinkInputProps) {
  return (
    <input
      type="url"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      className="w-full rounded-2xl border border-neutral-200 bg-white px-5 py-4 text-base text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-200 disabled:bg-neutral-50"
      autoComplete="off"
    />
  );
}
