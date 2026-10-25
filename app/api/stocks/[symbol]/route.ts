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
    // Last year of daily closes with the 50- and 200-day averages, for the chart
    const bars = data.bars.get(key);
    let daily: { close: number[]; sma50: (number | null)[]; sma200: (number | null)[] } | null = null;
    if (bars) {
      const c = bars.close;
      const sma = (n: number) =>
        c.map((_, i) => (i >= n - 1 ? c.slice(i - n + 1, i + 1).reduce((a, v) => a + v, 0) / n : null));
      const keep = Math.min(250, c.length);
      const r2 = (v: number | null) => (v === null ? null : Math.round(v * 100) / 100);
      daily = {
        close: c.slice(-keep).map((v) => r2(v)!),
        sma50: sma(50).slice(-keep).map(r2),
        sma200: sma(200).slice(-keep).map(r2),
      };
    }
    const signal = data.signals.get(key) ?? null;
    return NextResponse.json({ ...series, longTerm: row.longTerm, shortTerm: row.shortTerm, signal, daily }, {
      headers: { "Cache-Control": "public, s-maxage=21600, stale-while-revalidate=86400" },
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
