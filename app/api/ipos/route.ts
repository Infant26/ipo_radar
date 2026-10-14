import { NextResponse } from "next/server";
import { scrapeAll } from "@/lib/scrape";
import { enrich } from "@/lib/score";
import type { IpoResponse } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const ORDER = { open: 0, upcoming: 1, closed: 2, listed: 3 } as const;

export async function GET() {
  const { ipos, sources } = await scrapeAll();

  const enriched = ipos
    .map(enrich)
    .sort(
      (a, b) =>
        ORDER[a.status] - ORDER[b.status] ||
        (b.score ?? -1) - (a.score ?? -1) ||
        (b.listingDate ?? "").localeCompare(a.listingDate ?? ""),
    );

  const body: IpoResponse = {
    fetchedAt: new Date().toISOString(),
    sources,
    ipos: enriched,
  };

  return NextResponse.json(body, {
    status: enriched.length ? 200 : 502,
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}
