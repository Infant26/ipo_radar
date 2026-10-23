"use client";

import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import { AnimatePresence, LayoutGroup, MotionConfig, motion, useReducedMotion } from "motion/react";
import {
  ArrowSquareOut,
  ArrowsClockwise,
  CaretDown,
  ChartLineUp,
  Lightning,
  MagnifyingGlass,
  SealCheck,
  Target,
  TrendUp,
  Warning,
  WarningCircle,
} from "@phosphor-icons/react";
import type { ScorePart, StockFlag, StockRow, StockVerdict } from "@/lib/stocks/compute";
import { CountUp, EASE_OUT, Ring, SPRING, Seg } from "../ui";
import TopNav from "../TopNav";

type ListRow = Omit<StockRow, "longTerm" | "shortTerm"> & {
  longTerm: { score: number | null; verdict: StockVerdict | null };
  shortTerm: { score: number | null; verdict: StockVerdict | null };
};
interface ListResponse {
  asOf: string;
  builtAt: string;
  notes: string[];
  count: number;
  rows: ListRow[];
  error?: string;
}
interface Detail {
  monthly: { date: string; close: number }[];
  adjustments: { exDate: string; factor: number; label: string }[];
  longTerm: { score: number | null; verdict: StockVerdict | null; parts: ScorePart[] };
  shortTerm: { score: number | null; verdict: StockVerdict | null; parts: ScorePart[] };
}

type Period = "1" | "2" | "3" | "4" | "5" | "yby";
type RankBy = "return" | "long" | "short";

const LONG_COLOR = "var(--emerald)";
const SHORT_COLOR = "var(--saffron)";
const NA = "n/a";
const TOP_N = 100;

const pct = (n: number | null | undefined, d = 1) =>
  n === null || n === undefined ? NA : `${n >= 0 ? "+" : ""}${(n * 100).toFixed(d)}%`;
const tone = (n: number | null | undefined) => (n == null ? "" : n > 0 ? "pos" : n < 0 ? "neg" : "");
const inr = (n: number) => "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: n < 100 ? 2 : 1 });
const fmtInt = (n: number) => String(Math.round(n));
const fmtPct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
const fmtDay = (iso: string) =>
  new Date(iso + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

const verdictClass: Record<StockVerdict, string> = { Strong: "v-strong", Fair: "v-apply", Weak: "v-risky", Poor: "v-avoid" };

/** Year-by-year ranking: most up-years first, then the best worst-year, then 5-year CAGR. */
function consistencyKey(r: ListRow) {
  const ys = r.years.filter((y): y is number => y !== null);
  const up = ys.filter((y) => y > 0).length;
  return [up, ys.length ? Math.min(...ys) : -9, r.cagr[4] ?? -9];
}

export default function StocksDashboard() {
  const [data, setData] = useState<ListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [period, setPeriod] = useState<Period>("1");
  const [rankBy, setRankBy] = useState<RankBy>("return");
  const [liquidOnly, setLiquidOnly] = useState(true);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const q = useDeferredValue(query.trim().toLowerCase());
  const reduce = useReducedMotion();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/stocks");
      const json = (await res.json()) as ListResponse;
      if (!res.ok || json.error) throw new Error(json.error ?? `Request failed (${res.status})`);
      setData(json);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const universe = useMemo(() => {
    const rows = data?.rows ?? [];
    return rows.filter((r) => r.dataOk && (!liquidOnly || (r.liquidityCr ?? 0) >= 1));
  }, [data, liquidOnly]);

  const list = useMemo(() => {
    let rows = universe;
    if (q) rows = rows.filter((r) => r.symbol.toLowerCase().includes(q) || r.name.toLowerCase().includes(q));
    if (period === "yby") {
      rows = rows.filter((r) => r.years.filter((y) => y !== null).length >= 3);
    } else {
      rows = rows.filter((r) => r.cagr[+period - 1] !== null);
    }
    const sorted = [...rows].sort((a, b) => {
      if (rankBy === "long") return (b.longTerm.score ?? -1) - (a.longTerm.score ?? -1);
      if (rankBy === "short") return (b.shortTerm.score ?? -1) - (a.shortTerm.score ?? -1);
      if (period === "yby") {
        const ka = consistencyKey(a);
        const kb = consistencyKey(b);
        return kb[0] - ka[0] || kb[1] - ka[1] || kb[2] - ka[2];
      }
      return b.cagr[+period - 1]! - a.cagr[+period - 1]!;
    });
    return { total: rows.length, rows: sorted.slice(0, TOP_N) };
  }, [universe, q, period, rankBy]);

  const picks = useMemo(() => {
    const best = (f: (r: ListRow) => number | null, pool = universe) =>
      [...pool].filter((r) => f(r) !== null).sort((a, b) => f(b)! - f(a)!)[0];
    const fiveYears = universe.filter((r) => r.years.every((y) => y !== null && y > 0));
    return {
      long: best((r) => r.longTerm.score),
      short: best((r) => r.shortTerm.score),
      steady: best((r) => r.cagr[4], fiveYears),
      steadyCount: fiveYears.length,
    };
  }, [universe]);

  const periodLabel = period === "1" ? "1-year return" : period === "yby" ? "Each year" : `${period}-year CAGR`;

  return (
    <MotionConfig reducedMotion="user">
      <div className="ambient" aria-hidden />
      <main className="wrap">
        <header className="top">
          <div className="brand">
            <span className={`logo ${loading ? "sweeping" : ""}`} aria-hidden>
              <span className="sweep" />
              <Target size={22} weight="bold" />
            </span>
            <div>
              <h1>IPO Radar</h1>
              <p className="sub">
                {data ? (
                  <>
                    NSE closing prices, {fmtDay(data.asOf)}
                    <span className="sep" aria-hidden>
                      /
                    </span>
                    <span className="count upcoming">{data.count.toLocaleString("en-IN")} stocks</span>
                  </>
                ) : (
                  "NSE stocks"
                )}
              </p>
            </div>
          </div>
          <TopNav active="stocks" />
          <div className="top-right">
            <motion.button
              className="refresh"
              onClick={load}
              disabled={loading}
              whileHover={reduce ? undefined : { y: -1 }}
              whileTap={{ scale: 0.97 }}
              transition={SPRING}
            >
              <ArrowsClockwise size={17} weight="bold" className={loading ? "spin" : ""} />
              {loading ? (data ? "Refreshing" : "Calculating") : "Refresh"}
            </motion.button>
          </div>
        </header>

        {error && (
          <div className="error" role="alert">
            <WarningCircle size={20} weight="fill" />
            <div>
              <strong>Couldn’t load stock data.</strong> {error}
            </div>
            <button className="text-btn" onClick={load}>
              Try again
            </button>
          </div>
        )}
        {data?.notes.map((n) => (
          <p className="warn-line" key={n}>
            <WarningCircle size={16} weight="fill" />
            {n}
          </p>
        ))}

        {!data && !error && <StocksSkeleton />}

        {data && (
          <>
            <section className="picks" aria-label="Top picks">
              {[
                picks.long && {
                  key: "long",
                  cls: "pick-steady",
                  icon: <ChartLineUp size={16} weight="bold" />,
                  label: "Best long-term score",
                  row: picks.long,
                  score: picks.long.longTerm.score,
                  color: LONG_COLOR,
                  line: (
                    <>
                      {picks.long.cagr[4] !== null ? "5Y" : "3Y"} CAGR{" "}
                      <b className={tone(picks.long.cagr[4] ?? picks.long.cagr[2])}>{pct(picks.long.cagr[4] ?? picks.long.cagr[2])}</b>,
                      worst drop <b>{pct(picks.long.maxDD, 0)}</b>
                    </>
                  ),
                },
                picks.short && {
                  key: "short",
                  cls: "pick-listing",
                  icon: <Lightning size={16} weight="fill" />,
                  label: "Best short-term score",
                  row: picks.short,
                  score: picks.short.shortTerm.score,
                  color: SHORT_COLOR,
                  line: (
                    <>
                      3M <b className={tone(picks.short.r3m)}>{pct(picks.short.r3m)}</b>, 1Y{" "}
                      <b className={tone(picks.short.cagr[0])}>{pct(picks.short.cagr[0])}</b>
                    </>
                  ),
                },
                picks.steady && {
                  key: "steady",
                  cls: "pick-fund",
                  icon: <SealCheck size={16} weight="fill" />,
                  label: `Up all 5 years (${picks.steadyCount} stocks)`,
                  row: picks.steady,
                  score: null,
                  color: "",
                  line: (
                    <>
                      Best of them: 5Y CAGR <b className="pos">{pct(picks.steady.cagr[4])}</b>
                    </>
                  ),
                },
              ]
                .filter(Boolean)
                .map((t, i) => {
                  const tile = t as {
                    key: string; cls: string; icon: React.ReactNode; label: string; row: ListRow;
                    score: number | null; color: string; line: React.ReactNode;
                  };
                  return (
                    <motion.button
                      key={tile.key}
                      type="button"
                      className={`pick ${tile.cls}`}
                      onClick={() => {
                        setQuery(tile.row.symbol);
                        setExpanded(tile.row.symbol);
                      }}
                      initial={{ opacity: 0, y: 16 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.6, delay: 0.05 + i * 0.08, ease: EASE_OUT }}
                      whileHover={{ y: -3 }}
                      whileTap={{ scale: 0.985 }}
                    >
                      <span className="pick-label">
                        {tile.icon}
                        {tile.label}
                      </span>
                      <span className="pick-body">
                        {tile.score !== null ? (
                          <Ring value={tile.score} size={68} stroke={7} color={tile.color} delay={0.25 + i * 0.08} label={`Score ${tile.score}`}>
                            <CountUp value={tile.score} format={fmtInt} duration={1.1} />
                          </Ring>
                        ) : (
                          <YearDots years={tile.row.years} />
                        )}
                        <span className="pick-text">
                          <span className="pick-name">{tile.row.symbol}</span>
                          <span className="pick-line">{tile.line}</span>
                          <span className="pick-when">{tile.row.name}</span>
                        </span>
                      </span>
                    </motion.button>
                  );
                })}
            </section>

            <nav className="toolbar" aria-label="View">
              <Seg
                id="period"
                label="Period"
                value={period}
                onChange={(v) => {
                  setPeriod(v);
                  setExpanded(null);
                }}
                options={[
                  { value: "1", label: "1Y" },
                  { value: "2", label: "2Y" },
                  { value: "3", label: "3Y" },
                  { value: "4", label: "4Y" },
                  { value: "5", label: "5Y" },
                  { value: "yby", label: "Year by year" },
                ]}
              />
              <div className="controls">
                <span className="ctl-label">Rank by</span>
                <Seg
                  id="srank"
                  label="Rank by"
                  size="sm"
                  value={rankBy}
                  onChange={setRankBy}
                  accent={rankBy === "long" ? "color-mix(in oklab, var(--emerald) 22%, var(--panel))" : rankBy === "short" ? "var(--saffron-soft)" : undefined}
                  options={[
                    { value: "return", label: period === "yby" ? "Consistency" : "Return" },
                    { value: "long", label: "Long-term" },
                    { value: "short", label: "Short-term" },
                  ]}
                />
              </div>
            </nav>

            <div className="filters">
              <label className="search">
                <MagnifyingGlass size={16} weight="bold" aria-hidden />
                <input
                  type="search"
                  placeholder="Search symbol or company"
                  aria-label="Search stocks"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
              <label className="switch">
                <input type="checkbox" checked={liquidOnly} onChange={(e) => setLiquidOnly(e.target.checked)} />
                <span className="switch-track" aria-hidden>
                  <motion.span className="switch-thumb" layout transition={SPRING} />
                </span>
                Liquid stocks only <span className="muted">(₹1 Cr+ traded a day)</span>
              </label>
              <span className="muted small">
                Top {Math.min(TOP_N, list.total)} of {list.total.toLocaleString("en-IN")} by{" "}
                {rankBy === "return" ? (period === "yby" ? "consistency" : periodLabel) : rankBy === "long" ? "long-term score" : "short-term score"}
              </span>
            </div>

            <section className={`list stocks ${period === "yby" ? "yby" : ""}`}>
              <div className="row head">
                <span>#</span>
                <span>Stock</span>
                {period === "yby" ? (
                  <span>Each year (latest first)</span>
                ) : (
                  <span className="r">{periodLabel}</span>
                )}
                <span>Long-term</span>
                <span>Short-term</span>
                <span className="r">Risk</span>
                <span className="r">Price · Liquidity</span>
                <span />
              </div>
              {list.rows.length === 0 && (
                <div className="empty">
                  <MagnifyingGlass size={28} weight="duotone" />
                  <p>
                    {q
                      ? `No stock matches “${query}”${liquidOnly ? " among liquid stocks. Try turning off “Liquid stocks only”." : "."}`
                      : "No stocks have enough history for this period."}
                  </p>
                </div>
              )}
              <LayoutGroup>
                <AnimatePresence initial={false}>
                  {list.rows.map((r, i) => (
                    <StockItem
                      key={r.symbol}
                      row={r}
                      rank={i + 1}
                      index={i}
                      period={period}
                      open={expanded === r.symbol}
                      onToggle={() => setExpanded(expanded === r.symbol ? null : r.symbol)}
                    />
                  ))}
                </AnimatePresence>
              </LayoutGroup>
            </section>

            <footer className="foot">
              <div>
                <h2>How these are calculated</h2>
                <p>
                  Prices are NSE’s official closing prices, adjusted for bonus issues and splits (not dividends, so
                  these are price returns). Returns beyond one year are CAGR, the average yearly growth rate. “Each
                  year” splits the last five years into separate 12-month periods.
                </p>
                <p>
                  <strong className="t-emerald">Long-term score</strong>: long-run growth (30%), how consistently it
                  rose each year (20%), return per unit of risk (20%, using a 6.5% risk-free rate), worst drop from a
                  peak (15%), long-term trend (10%) and liquidity (5%).
                </p>
                <p>
                  <strong className="t-saffron">Short-term score</strong>: 12-month momentum excluding the last month
                  (25%), 3-month return (20%), 1-month return (10%), trend against its 10- and 40-week averages (20%),
                  closeness to its 52-week high (15%) and liquidity (10%).
                </p>
              </div>
              <div>
                <h2>Before you act on it</h2>
                <p>
                  Both scores use price history only. They don’t look at the business (profits, debt, valuation), and
                  past returns don’t predict future ones. Treat them as a starting list to research, not a list to buy.
                </p>
                <p>
                  Stocks with a 4x+ jump in one month and no recorded split are left out, since that’s usually a data
                  gap rather than a real gain. Illiquid stocks can be hard to sell at the shown price.
                </p>
                <p className="muted">
                  Information only, not investment advice. For personalised advice, talk to a SEBI-registered
                  investment adviser.
                </p>
              </div>
            </footer>
          </>
        )}
      </main>
    </MotionConfig>
  );
}

/* ---------------------------------------------------------------------------------------------- */

function YearDots({ years }: { years: (number | null)[] }) {
  return (
    <span className="year-dots" aria-label="Up in each of the last 5 years">
      {[...years].reverse().map((y, i) => (
        <motion.i
          key={i}
          className={y === null ? "" : y > 0 ? "up" : "down"}
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ ...SPRING, delay: 0.3 + i * 0.07 }}
        />
      ))}
    </span>
  );
}

function FlagChip({ flag }: { flag: StockFlag }) {
  return (
    <span className={`flag ${flag.tone}`}>
      {flag.tone === "good" ? (
        <TrendUp size={12} weight="bold" />
      ) : flag.tone === "bad" ? (
        <WarningCircle size={12} weight="fill" />
      ) : (
        <Warning size={12} weight="fill" />
      )}
      {flag.text}
    </span>
  );
}

function MiniScore({ label, score, verdict, color, delay, className }: {
  label: string; score: number | null; verdict: StockVerdict | null; color: string; delay: number; className: string;
}) {
  return (
    <div className={`score ${className}`} data-l={label}>
      <Ring value={score} size={42} stroke={4.5} color={color} delay={delay} label={`${label} ${score ?? NA}`}>
        {score !== null ? <CountUp value={score} format={fmtInt} /> : "-"}
      </Ring>
      <span className={`verdict ${verdict ? verdictClass[verdict] : "v-none"}`}>{verdict ?? "Too new"}</span>
    </div>
  );
}

/** Cell colour for a yearly return: deeper green for bigger gains, deeper rose for bigger losses. */
function yearStyle(y: number | null): React.CSSProperties {
  if (y === null) return {};
  const strength = Math.min(1, Math.abs(y) / 0.6);
  const mix = Math.round(14 + strength * 46);
  return {
    background: `color-mix(in oklab, var(${y >= 0 ? "--emerald" : "--rose"}) ${mix}%, var(--panel))`,
    color: strength > 0.55 ? "var(--panel)" : undefined,
  };
}

function StockItem({ row: r, rank, index, period, open, onToggle }: {
  row: ListRow; rank: number; index: number; period: Period; open: boolean; onToggle: () => void;
}) {
  const main = period === "yby" ? null : r.cagr[+period - 1];
  const rowFlags = r.flags.some((f) => f.tone !== "good") ? r.flags.filter((f) => f.tone !== "good").slice(0, 2) : r.flags.slice(0, 2);
  const others = [0, 1, 2, 3, 4].filter((k) => String(k + 1) !== period && r.cagr[k] !== null);
  const d = Math.min(index, 14) * 0.035;

  return (
    <motion.div
      layout="position"
      className={`item ${open ? "open" : ""}`}
      id={`s-${r.symbol}`}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, transition: { duration: 0.12 } }}
      transition={{ layout: SPRING, opacity: { duration: 0.4, delay: d }, y: { duration: 0.5, delay: d, ease: EASE_OUT } }}
    >
      <button className="row" onClick={onToggle} aria-expanded={open}>
        <span className={`rank r${rank <= 3 ? rank : ""}`}>{rank}</span>
        <div className="name">
          <strong>{r.symbol}</strong>
          <span className="meta">
            <span className="muted co">{r.name}</span>
            {r.industry && <span className="chip">{r.industry}</span>}
          </span>
          {rowFlags.length > 0 && (
            <span className="flags">
              {rowFlags.map((f) => (
                <FlagChip key={f.text} flag={f} />
              ))}
            </span>
          )}
        </div>
        {period === "yby" ? (
          <div className="years c-full" data-l="Each year (latest first)">
            {r.years.map((y, k) => (
              <motion.span
                key={k}
                className="ycell num"
                style={yearStyle(y)}
                title={`${k === 0 ? "Last 12 months" : `${k}-${k + 1} years ago`}: ${pct(y)}`}
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.35, delay: d + 0.1 + k * 0.04, ease: EASE_OUT }}
              >
                {y === null ? "-" : pct(y, 0)}
              </motion.span>
            ))}
          </div>
        ) : (
          <div className="r c-a" data-l={period === "1" ? "1-year return" : `${period}-year CAGR`}>
            <span className={`num big ${tone(main)}`}>
              {main !== null && main !== undefined ? <CountUp value={main * 100} format={fmtPct} /> : NA}
            </span>
            <span className="num small muted nowrap">
              {others.slice(0, 3).map((k, i) => (
                <span key={k}>
                  {i > 0 && " "}
                  {k + 1}Y <span className={tone(r.cagr[k])}>{pct(r.cagr[k], 0)}</span>
                </span>
              ))}
            </span>
          </div>
        )}
        <MiniScore label="Long-term" score={r.longTerm.score} verdict={r.longTerm.verdict} color={LONG_COLOR} delay={0.12 + d} className="c-a" />
        <MiniScore label="Short-term" score={r.shortTerm.score} verdict={r.shortTerm.verdict} color={SHORT_COLOR} delay={0.18 + d} className="c-b" />
        <div className="r c-a" data-l="Risk">
          <span className="num">{r.vol !== null ? `${(r.vol * 100).toFixed(0)}% vol` : NA}</span>
          <span className="num small muted nowrap">{r.maxDD !== null ? `worst drop ${pct(r.maxDD, 0)}` : ""}</span>
        </div>
        <div className="r c-b" data-l="Price · Liquidity">
          <span className="num">{inr(r.price)}</span>
          <span className={`num small nowrap ${r.liquidityCr !== null && r.liquidityCr < 1 ? "neg" : "muted"}`}>
            {r.liquidityCr !== null ? `₹${r.liquidityCr < 10 ? r.liquidityCr.toFixed(1) : Math.round(r.liquidityCr).toLocaleString("en-IN")} Cr/day` : NA}
          </span>
        </div>
        <motion.span className="caret" animate={{ rotate: open ? 180 : 0 }} transition={SPRING} aria-hidden>
          <CaretDown size={16} weight="bold" />
        </motion.span>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="detail"
            className="detail-clip"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ height: { duration: 0.42, ease: EASE_OUT }, opacity: { duration: 0.25 } }}
          >
            <StockDetail row={r} />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function StockDetail({ row: r }: { row: ListRow }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/stocks/${encodeURIComponent(r.symbol)}`)
      .then((res) => res.json())
      .then((j) => {
        if (!live) return;
        if (j.error) setErr(j.error);
        else setDetail(j);
      })
      .catch((e) => live && setErr((e as Error).message));
    return () => {
      live = false;
    };
  }, [r.symbol]);

  const stats: [string, string, string?][] = [
    ["1 week", pct(r.r1w), tone(r.r1w)],
    ["1 month", pct(r.r1m), tone(r.r1m)],
    ["3 months", pct(r.r3m), tone(r.r3m)],
    ["6 months", pct(r.r6m), tone(r.r6m)],
    ["1 year", pct(r.cagr[0]), tone(r.cagr[0])],
    ["3Y CAGR", pct(r.cagr[2]), tone(r.cagr[2])],
    ["5Y CAGR", pct(r.cagr[4]), tone(r.cagr[4])],
    ["From 52-week high", pct(r.fromHigh), tone(r.fromHigh)],
    ["Volatility", r.vol !== null ? `${(r.vol * 100).toFixed(1)}% a year` : NA],
    ["Return per unit of risk", r.sharpe !== null ? r.sharpe.toFixed(2) : NA],
    ["Worst drop from a peak", pct(r.maxDD, 0)],
    ["Trend", r.aboveMa40 === null ? NA : `${r.aboveMa10 ? "Above" : "Below"} 10-week, ${r.aboveMa40 ? "above" : "below"} 40-week average`],
  ];

  return (
    <div className="detail">
      {r.flags.length > 0 && (
        <div className="flags all">
          {r.flags.map((f) => (
            <FlagChip key={f.text} flag={f} />
          ))}
        </div>
      )}

      <div className="cols">
        <div>
          <h3>
            Price, last {Math.max(1, Math.round(r.historyMonths / 12))} year{r.historyMonths >= 24 ? "s" : ""}{" "}
            <span className="muted">(monthly, adjusted)</span>
          </h3>
          {detail ? <PriceChart points={detail.monthly} /> : err ? <p className="pd">{err}</p> : <div className="sk chart-sk" />}
          <h3 className="sub-h">Each year</h3>
          <YearBars years={r.years} />
        </div>
        <div>
          <h3>Key numbers</h3>
          <dl className="ratios">
            {stats.map(([k, v, t]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>
                  <span className={`num ${t ?? ""}`}>{v}</span>
                </dd>
              </div>
            ))}
          </dl>
          {detail && detail.adjustments.length > 0 && (
            <p className="pd peers">
              Adjusted for: {detail.adjustments.map((a) => `${a.label} (ex ${fmtDay(a.exDate)})`).join("; ")}
            </p>
          )}
        </div>
      </div>

      {detail && (
        <div className="cols">
          <Parts title="Long-term score" parts={detail.longTerm.parts} color={LONG_COLOR} />
          <Parts title="Short-term score" parts={detail.shortTerm.parts} color={SHORT_COLOR} />
        </div>
      )}

      <a className="more" href={`https://www.nseindia.com/get-quotes/equity?symbol=${encodeURIComponent(r.symbol)}`} target="_blank" rel="noreferrer">
        {r.symbol} on NSE <ArrowSquareOut size={14} weight="bold" />
      </a>
    </div>
  );
}

function Parts({ title, parts, color }: { title: string; parts: ScorePart[]; color: string }) {
  return (
    <div className="parts">
      <h3>{title}</h3>
      {parts.map((p, i) => (
        <div key={p.key} className={`part ${p.value === null ? "na" : ""}`}>
          <div className="ph">
            <span>{p.label}</span>
            <span className="num muted">{p.value === null ? "not counted" : `${Math.round(p.value * p.weight)} / ${p.weight}`}</span>
          </div>
          <div className="pbar">
            <motion.i
              style={{ background: color, originX: 0 }}
              initial={{ scaleX: 0 }}
              animate={{ scaleX: p.value ?? 0 }}
              transition={{ duration: 0.7, delay: 0.1 + i * 0.045, ease: EASE_OUT }}
            />
          </div>
          <span className="pd">{p.detail}</span>
        </div>
      ))}
    </div>
  );
}

/** Each year's return as a bar growing up (gain) or down (loss) from a zero line. */
function YearBars({ years }: { years: (number | null)[] }) {
  const vals = [...years].reverse();
  const max = Math.max(0.2, ...vals.map((v) => Math.abs(v ?? 0)));
  const labels = ["4-5y ago", "3-4y ago", "2-3y ago", "1-2y ago", "Last 12m"];
  return (
    <div className="ybars">
      {vals.map((v, i) => (
        <div className="ybar" key={i} title={`${labels[i]}: ${pct(v)}`}>
          <span className={`ybar-val num ${tone(v)}`}>{v === null ? "-" : pct(v, 0)}</span>
          <span className="ybar-track">
            {v !== null && (
              <motion.span
                className={`ybar-fill ${v >= 0 ? "up" : "down"}`}
                style={{ height: `${(Math.abs(v) / max) * 50}%`, originY: v >= 0 ? 1 : 0 }}
                initial={{ scaleY: 0 }}
                animate={{ scaleY: 1 }}
                transition={{ duration: 0.6, delay: 0.15 + i * 0.06, ease: EASE_OUT }}
              />
            )}
          </span>
          <span className="ybar-label">{labels[i]}</span>
        </div>
      ))}
    </div>
  );
}

function PriceChart({ points }: { points: { date: string; close: number }[] }) {
  if (points.length < 2) return <p className="pd">Not enough history.</p>;
  const W = 520;
  const H = 150;
  const P = 6;
  const vals = points.map((p) => p.close);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = hi - lo || 1;
  const xy = points.map((p, i) => [P + (i / (points.length - 1)) * (W - 2 * P), H - P - ((p.close - lo) / span) * (H - 2 * P)]);
  const d = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const up = vals[vals.length - 1] >= vals[0];
  const color = up ? "var(--emerald)" : "var(--rose)";
  const last = xy[xy.length - 1];
  return (
    <figure className="pchart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Price from ${inr(vals[0])} to ${inr(vals[vals.length - 1])}`}>
        <motion.path
          d={`${d} L${last[0].toFixed(1)},${H} L${xy[0][0].toFixed(1)},${H} Z`}
          fill={color}
          initial={{ opacity: 0 }}
          animate={{ opacity: 0.12 }}
          transition={{ duration: 0.8, delay: 0.4 }}
        />
        <motion.path
          d={d}
          fill="none"
          stroke={color}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 1.1, ease: EASE_OUT }}
        />
        <motion.circle cx={last[0]} cy={last[1]} r={3.5} fill={color} initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ ...SPRING, delay: 1.1 }} />
      </svg>
      <figcaption className="pd">
        {fmtDay(points[0].date)}: {inr(vals[0])}. Low {inr(lo)}, high {inr(hi)}. Now {inr(vals[vals.length - 1])}.
      </figcaption>
    </figure>
  );
}

function StocksSkeleton() {
  return (
    <div className="skeleton" aria-busy="true" aria-label="Calculating returns for every NSE stock">
      <div className="sk-picks">
        {[0, 1, 2].map((i) => (
          <div className="sk tile" key={i} />
        ))}
      </div>
      <p className="muted small calc-note">
        Calculating 1 to 5 year returns for every NSE stock from official closing prices. The first load can take
        up to a minute; after that it’s cached.
      </p>
      <div className="sk bar" />
      {[0, 1, 2, 3, 4].map((i) => (
        <div className="sk line" key={i} />
      ))}
    </div>
  );
}
