import Link from "next/link";

export default function LandingPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#fafafa] px-4">
      <h1 className="text-4xl font-semibold tracking-tight text-neutral-900">
        Recipe Cloud
      </h1>
      <p className="mt-3 max-w-md text-center text-neutral-600">
        Paste links from YouTube, TikTok, blogs—anywhere. AI extracts and
        merges them into one clean recipe.
      </p>
      <div className="mt-10 flex gap-3">
        <Link
          href="/create"
          className="rounded-2xl bg-neutral-900 px-6 py-3 text-sm font-medium text-white transition hover:bg-neutral-800"
        >
          Create Recipe
        </Link>
        <Link
          href="/dashboard"
          className="rounded-2xl border border-neutral-200 bg-white px-6 py-3 text-sm font-medium text-neutral-700 transition hover:bg-neutral-50"
        >
          Dashboard
        </Link>
      </div>
    </div>
  );
}
