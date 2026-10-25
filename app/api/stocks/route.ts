import { NextResponse } from "next/server";
import { loadStocks } from "@/lib/stocks/load";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  try {
    const data = await loadStocks();
    return NextResponse.json(
      {
        asOf: data.asOf,
        builtAt: data.builtAt,
        market: data.market,
        complete: data.complete,
        notes: data.notes,
        count: data.rows.length,
        // Score breakdowns come from /api/stocks/[symbol] to keep this list small
        rows: data.rows.map(({ longTerm, shortTerm, ...r }) => ({
          ...r,
          longTerm: { score: longTerm.score, verdict: longTerm.verdict },
          shortTerm: { score: shortTerm.score, verdict: shortTerm.verdict },
        })),
      },
      {
        // Prices only change once a day, so let Vercel's CDN serve a cached copy
        headers: {
          "Cache-Control": data.complete
            ? "public, s-maxage=21600, stale-while-revalidate=86400"
            : // still downloading history: don't let the CDN hold the partial result
              "public, s-maxage=60",
        },
      },
    );
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
