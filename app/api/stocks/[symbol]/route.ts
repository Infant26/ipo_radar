import { NextResponse } from "next/server";
import { loadStocks } from "@/lib/stocks/load";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(_req: Request, { params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  try {
    const data = await loadStocks();
    const key = decodeURIComponent(symbol).toUpperCase();
    const series = data.series.get(key);
    const row = data.rows.find((r) => r.symbol === key);
    if (!series || !row) return NextResponse.json({ error: "Unknown symbol" }, { status: 404 });
    return NextResponse.json({ ...series, longTerm: row.longTerm, shortTerm: row.shortTerm }, {
      headers: { "Cache-Control": "public, s-maxage=21600, stale-while-revalidate=86400" },
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
