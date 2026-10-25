"use client";

import { motion } from "motion/react";
import { ShieldWarning, TrendDown, TrendUp } from "@phosphor-icons/react";
import type { SignalSummary } from "@/lib/stocks/compute";
import type { MarketSummary } from "@/lib/stocks/load";
import type { Signal, TradePlan } from "@/lib/stocks/technical";
import { EASE_OUT, SPRING } from "../ui";

type Rating = SignalSummary["rating"];
type Regime = NonNullable<SignalSummary["regime"]>;

export const RATING_CLASS: Record<Rating, string> = {
  Buy: "rt-buy",
  Overweight: "rt-ow",
  Hold: "rt-hold",
  Underweight: "rt-uw",
  Sell: "rt-sell",
};
export const REGIME_CLASS: Record<Regime, string> = {
  Bull: "rg-bull",
  Bear: "rg-bear",
  Recovering: "rg-mid",
  Weakening: "rg-mid",
  Sideways: "rg-mid",
};

const inr = (n: number) => "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: n < 100 ? 2 : 1 });
const pc = (n: number, d = 1) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(d)}%`;

/* ---------- market card ---------- */

function Spark({ closes, color }: { closes: number[]; color: string }) {
  if (closes.length < 2) return null;
  const W = 220;
  const H = 54;
  const lo = Math.min(...closes);
  const hi = Math.max(...closes);
  const span = hi - lo || 1;
  const d = closes
    .map((v, i) => `${i ? "L" : "M"}${((i / (closes.length - 1)) * W).toFixed(1)},${(H - 3 - ((v - lo) / span) * (H - 6)).toFixed(1)}`)
    .join(" ");
  return (
    <svg className="mspark" viewBox={`0 0 ${W} ${H}`} aria-hidden>
      <motion.path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round"
        initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 1.2, ease: EASE_OUT }} />
    </svg>
  );
}

export function MarketCard({ market }: { market: MarketSummary }) {
  const tone = market.regime === "Bull" ? "bull" : market.regime === "Bear" ? "bear" : "mid";
  const b = market.breadth;
  const other = Math.max(0, 1 - b.bull - b.bear);
  return (
    <motion.section
      className={`market m-${tone}`}
      aria-label="Market trend"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: EASE_OUT }}
    >
      <div className="market-main">
        <span className="market-label">Market trend</span>
        <h2 className="market-head">
          {tone === "bull" ? <TrendUp size={24} weight="bold" /> : tone === "bear" ? <TrendDown size={24} weight="bold" /> : null}
          {market.headline}
        </h2>
        <p className="market-guide">{market.guidance}</p>
      </div>
      <div className="market-idx">
        {market.indices.map((ix) => (
          <div key={ix.name} className="idx">
            <div className="idx-top">
              <span className="idx-name">{ix.name === "NIFTY 50" ? "Nifty 50" : "Nifty 500"}</span>
              {ix.regime && <span className={`regime ${REGIME_CLASS[ix.regime]}`}>{ix.regime}</span>}
            </div>
            <span className="num idx-val">{ix.close.toLocaleString("en-IN", { maximumFractionDigits: 0 })}</span>
            <Spark closes={ix.closes} color={ix.regime === "Bear" ? "var(--rose)" : ix.regime === "Bull" ? "var(--emerald)" : "var(--saffron)"} />
            <span className="small muted num">
              {ix.sma200 ? `${pc(ix.close / ix.sma200 - 1)} vs 200-day` : "200-day n/a"}
              {ix.offHigh !== null && `, ${pc(ix.offHigh)} from high`}
              {ix.pe !== null && `, P/E ${ix.pe.toFixed(1)}`}
            </span>
          </div>
        ))}
      </div>
      <div className="market-breadth">
        <div className="breadth-head">
          <span className="small muted">Stocks in a bull vs bear trend</span>
          <span className="small muted num">{b.counted.toLocaleString("en-IN")} liquid stocks</span>
        </div>
        <div className="breadth-bar" role="img" aria-label={`${Math.round(b.bull * 100)}% bull, ${Math.round(b.bear * 100)}% bear`}>
          {[
            ["bull", b.bull],
            ["mid", other],
            ["bear", b.bear],
          ].map(([k, v], i) => (
            <motion.span
              key={k as string}
              className={`bseg ${k}`}
              style={{ width: `${(v as number) * 100}%`, originX: 0 }}
              initial={{ scaleX: 0 }}
              animate={{ scaleX: 1 }}
              transition={{ duration: 0.8, delay: 0.2 + i * 0.1, ease: EASE_OUT }}
            />
          ))}
        </div>
        <div className="breadth-legend small num">
          <span className="pos">{Math.round(b.bull * 100)}% bull</span>
          <span className="muted">{Math.round(other * 100)}% mixed</span>
          <span className="neg">{Math.round(b.bear * 100)}% bear</span>
          <span className="muted">{Math.round(b.above200 * 100)}% above their 200-day</span>
        </div>
      </div>
    </motion.section>
  );
}

/* ---------- list cell ---------- */

const STATUS_LABEL: Record<TradePlan["status"], string> = {
  buy: "Buy zone",
  wait: "Wait",
  watch: "Watch",
  avoid: "Avoid",
};

export function SignalCell({ s, className, delay }: { s: SignalSummary | null; className: string; delay: number }) {
  if (!s) {
    return (
      <div className={className} data-l="Signal">
        <span className="small muted">Not enough daily data</span>
      </div>
    );
  }
  return (
    <div className={`sigcell ${className}`} data-l="Signal">
      <motion.span
        className={`rating ${RATING_CLASS[s.rating]}`}
        initial={{ opacity: 0, scale: 0.85 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ ...SPRING, delay }}
      >
        {s.rating}
      </motion.span>
      <span className="small nowrap">
        {s.regime && <span className={`regime ${REGIME_CLASS[s.regime]}`}>{s.regime}</span>}
        <span className={`plan-dot p-${s.swing.status}`} title={s.swing.headline}>
          {STATUS_LABEL[s.swing.status]}
        </span>
      </span>
    </div>
  );
}

/* ---------- detail ---------- */

function NetMeter({ net }: { net: number }) {
  const half = Math.abs(net) / 2;
  return (
    <div className="netmeter" role="img" aria-label={`Bull vs bear balance ${net}`}>
      <span className="nm-track">
        <span className="nm-zero" />
        <motion.span
          className={`nm-fill ${net >= 0 ? "up" : "down"}`}
          style={{ width: `${half}%`, [net >= 0 ? "left" : "right"]: "50%", originX: net >= 0 ? 0 : 1 }}
          initial={{ scaleX: 0 }}
          animate={{ scaleX: 1 }}
          transition={{ duration: 0.8, ease: EASE_OUT }}
        />
      </span>
      <span className="nm-labels small muted">
        <span>All bear</span>
        <span className="num">{net > 0 ? `+${net}` : net}</span>
        <span>All bull</span>
      </span>
    </div>
  );
}

function Case({ title, points, tone }: { title: string; points: Signal["bull"]; tone: "bull" | "bear" }) {
  return (
    <div className={`case case-${tone}`}>
      <h3>
        {tone === "bull" ? <TrendUp size={16} weight="bold" /> : <TrendDown size={16} weight="bold" />}
        {title}
        <span className="muted num"> {points.reduce((a, p) => a + p.weight, 0)} pts</span>
      </h3>
      {points.length === 0 ? (
        <p className="pd">Nothing on this side right now.</p>
      ) : (
        <ul>
          {points.map((p, i) => (
            <motion.li
              key={p.text}
              initial={{ opacity: 0, x: tone === "bull" ? -8 : 8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.4, delay: 0.1 + i * 0.04, ease: EASE_OUT }}
            >
              <span className="w num">{p.weight}</span>
              {p.text}
            </motion.li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PlanCard({ p }: { p: TradePlan }) {
  const rr = p.entry !== null && p.stop !== null && p.target !== null ? (p.target - p.entry) / (p.entry - p.stop) : null;
  return (
    <div className={`plan plan-${p.status}`}>
      <div className="plan-top">
        <span className="plan-h">{p.horizon}</span>
        <span className={`plan-dot p-${p.status}`}>{STATUS_LABEL[p.status]}</span>
      </div>
      <strong className="plan-headline">{p.headline}</strong>
      {(p.entry !== null || p.zone) && (
        <dl className="plan-levels">
          {p.zone && (
            <div>
              <dt>Buy zone</dt>
              <dd className="num">
                {inr(p.zone[0])} to {inr(p.zone[1])}
              </dd>
            </div>
          )}
          {p.entry !== null && (
            <div>
              <dt>{p.status === "watch" ? "Trigger" : "Entry"}</dt>
              <dd className="num">{inr(p.entry)}</dd>
            </div>
          )}
          {p.stop !== null && (
            <div>
              <dt>Stop-loss</dt>
              <dd className="num neg">
                {inr(p.stop)}
                {p.riskPct !== null && <small> ({(p.riskPct * 100).toFixed(1)}% risk)</small>}
              </dd>
            </div>
          )}
          {p.target !== null && (
            <div>
              <dt>Target</dt>
              <dd className="num pos">
                {inr(p.target)}
                {rr !== null && <small> ({rr.toFixed(0)}:1)</small>}
              </dd>
            </div>
          )}
        </dl>
      )}
      <p className="pd">{p.note}</p>
    </div>
  );
}

function DailyChart({ daily, plan }: { daily: { close: number[]; sma50: (number | null)[]; sma200: (number | null)[] }; plan: TradePlan }) {
  const W = 560;
  const H = 190;
  const P = 6;
  const vals = [
    ...daily.close,
    ...daily.sma50.filter((v): v is number => v !== null),
    ...daily.sma200.filter((v): v is number => v !== null),
    ...(plan.stop !== null ? [plan.stop] : []),
    ...(plan.entry !== null ? [plan.entry] : []),
  ];
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = hi - lo || 1;
  const n = daily.close.length;
  const X = (i: number) => P + (i / Math.max(1, n - 1)) * (W - 2 * P);
  const Y = (v: number) => H - P - ((v - lo) / span) * (H - 2 * P);
  const path = (arr: (number | null)[]) => {
    let d = "";
    let pen = false;
    arr.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const line = (v: number, cls: string, label: string) => (
    <g className={cls}>
      <line x1={P} x2={W - P} y1={Y(v)} y2={Y(v)} />
      <text x={P + 4} y={Y(v) - 4} textAnchor="start">
        {label} {inr(v)}
      </text>
    </g>
  );
  return (
    <figure className="dchart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Daily price with 50- and 200-day averages">
        {plan.zone && (
          <rect className="zone" x={P} width={W - 2 * P} y={Y(plan.zone[1])} height={Math.max(2, Y(plan.zone[0]) - Y(plan.zone[1]))} />
        )}
        <motion.path d={path(daily.sma200)} className="l200" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 1, ease: EASE_OUT }} />
        <motion.path d={path(daily.sma50)} className="l50" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 1, delay: 0.1, ease: EASE_OUT }} />
        <motion.path d={path(daily.close)} className="lpx" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 1.1, delay: 0.15, ease: EASE_OUT }} />
        {plan.stop !== null && line(plan.stop, "lv stop", "Stop")}
        {plan.entry !== null && line(plan.entry, "lv entry", plan.status === "watch" ? "Trigger" : "Entry")}
      </svg>
      <figcaption className="legend small">
        <span><i className="k px" />Price</span>
        <span><i className="k s50" />50-day</span>
        <span><i className="k s200" />200-day</span>
        {plan.zone && <span><i className="k zn" />Swing buy zone</span>}
      </figcaption>
    </figure>
  );
}

export function SignalDetail({
  signal,
  daily,
}: {
  signal: Signal;
  daily: { close: number[]; sma50: (number | null)[]; sma200: (number | null)[] } | null;
}) {
  const i = signal.indicators;
  const c = i.close;
  const ind: [string, string, string?][] = [
    ["50-day SMA", i.sma50 !== null ? `${inr(i.sma50)} (${pc(c / i.sma50 - 1)})` : "n/a", i.sma50 !== null ? (c > i.sma50 ? "pos" : "neg") : ""],
    ["200-day SMA", i.sma200 !== null ? `${inr(i.sma200)} (${pc(c / i.sma200 - 1)})` : "n/a", i.sma200 !== null ? (c > i.sma200 ? "pos" : "neg") : ""],
    ["10-day EMA", i.ema10 !== null ? inr(i.ema10) : "n/a"],
    ["RSI (14)", i.rsi !== null ? `${i.rsi.toFixed(0)}${i.rsi > 70 ? " overbought" : i.rsi < 30 ? " oversold" : ""}` : "n/a", i.rsi !== null ? (i.rsi > 70 || i.rsi < 30 ? "neg" : i.rsi >= 50 ? "pos" : "") : ""],
    ["MACD / signal", i.macd !== null && i.macdSignal !== null ? `${i.macd.toFixed(2)} / ${i.macdSignal.toFixed(2)}` : "n/a", i.macd !== null && i.macdSignal !== null ? (i.macd > i.macdSignal ? "pos" : "neg") : ""],
    ["Bollinger (20, 2)", i.bollLower !== null && i.bollUpper !== null ? `${inr(i.bollLower)} to ${inr(i.bollUpper)}` : "n/a"],
    ["ATR (14)", i.atr !== null ? `${inr(i.atr)} (${((i.atr / c) * 100).toFixed(1)}% a day)` : "n/a"],
    ["VWMA (20)", i.vwma !== null ? inr(i.vwma) : "n/a", i.vwma !== null ? (c > i.vwma ? "pos" : "neg") : ""],
    ["52-week range", i.low52 !== null && i.high52 !== null ? `${inr(i.low52)} to ${inr(i.high52)}` : "n/a"],
  ];
  return (
    <div className="sigdetail">
      <div className="sig-head">
        <div>
          <span className="small muted">Bull vs bear verdict</span>
          <div className="sig-verdict">
            <span className={`rating big ${RATING_CLASS[signal.rating]}`}>{signal.rating}</span>
            {signal.regime && <span className={`regime ${REGIME_CLASS[signal.regime]}`}>{signal.regime} trend</span>}
          </div>
        </div>
        <NetMeter net={signal.net} />
      </div>
      {signal.caps.length > 0 && (
        <p className="caps">
          <ShieldWarning size={16} weight="fill" />
          Risk checks: {signal.caps.join(". ")}.
        </p>
      )}
      <div className="cols cases">
        <Case title="Bull case" points={signal.bull} tone="bull" />
        <Case title="Bear case" points={signal.bear} tone="bear" />
      </div>
      <div className="plans">
        <PlanCard p={signal.swing} />
        <PlanCard p={signal.positional} />
      </div>
      <div className="cols">
        <div>
          <h3>
            Last year, daily <span className="muted">(adjusted)</span>
          </h3>
          {daily ? <DailyChart daily={daily} plan={signal.swing} /> : <div className="sk chart-sk" />}
        </div>
        <div>
          <h3>Indicators</h3>
          <dl className="ratios">
            {ind.map(([k, v, t]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>
                  <span className={`num ${t ?? ""}`}>{v}</span>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </div>
  );
}
