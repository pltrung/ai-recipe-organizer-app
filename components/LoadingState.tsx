"use client";

const STEPS = [
  "Reading recipes...",
  "Understanding ingredients...",
  "Combining best techniques...",
  "Crafting your final recipe...",
];

type LoadingStateProps = {
  step: number;
};

export function LoadingState({ step }: LoadingStateProps) {
  const current = Math.min(step, STEPS.length - 1);
  return (
    <div className="flex flex-col items-center gap-8">
      <div className="h-2 w-48 overflow-hidden rounded-full bg-neutral-100">
        <div
          className="h-full rounded-full bg-neutral-800 transition-all duration-500 ease-out"
          style={{ width: `${((current + 1) / STEPS.length) * 100}%` }}
        />
      </div>
      <p className="min-h-[1.5rem] text-lg text-neutral-600 transition-opacity duration-300">
        {STEPS[current]}
      </p>
    </div>
  );
}
