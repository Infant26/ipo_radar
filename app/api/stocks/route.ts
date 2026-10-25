import { NextResponse } from "next/server";
import { loadStocks, refreshStocks } from "@/lib/stocks/load";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  // ?refresh=… is the Refresh button: check NSE for a newer day before answering
  const refresh = new URL(req.url).searchParams.has("refresh");
  try {
    let data;
    let check: { updated: boolean; checkedAt: string } | null = null;
    if (refresh) {
      const r = await refreshStocks();
      data = r.data;
      check = { updated: r.updated, checkedAt: r.checkedAt };
    } else {
      data = await loadStocks();
    }
    return NextResponse.json(
      {
        check,
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
          "Cache-Control": refresh
            ? "private, no-store"
            : data.complete
              ? // short enough that a refresh's new prices reach normal page loads soon after
                "public, s-maxage=900, stale-while-revalidate=3600"
              : // still downloading history: don't let the CDN hold the partial result
                "public, s-maxage=60",
        },
      },
    );
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
