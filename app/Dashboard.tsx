"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FundVerdict, Ipo, IpoResponse, Verdict } from "@/lib/types";

const STORE_KEY = "ipo-radar:gmp-v2";
const LEGACY_KEY = "ipo-radar:prev-gmp";

/** Last GMP seen in this browser, plus the most recent move (kept until the GMP moves again). */
interface Seen {
  gmp: number;
  move?: number;
  /** when the move happened, as the source reports it ("14-Oct 12:02") */
  at?: string;
}

type Tab = "apply" | "past";
type Filter = "all" | "open" | "upcoming";
type RankBy = "listing" | "fundamentals";

const inr = (n: number | null | undefined, digits = 0) =>
  n === null || n === undefined
    ? "–"
    : "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: digits });

const x = (n: number | null | undefined) =>
  n === null || n === undefined ? "–" : `${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}x`;

const short = (n: number | null) =>
  n === null ? "–" : n >= 10 ? n.toFixed(0) : n.toFixed(1);

const pct = (n: number | null | undefined) =>
  n === null || n === undefined ? "–" : `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;

const fmtDate = (iso: string | null) =>
  iso
    ? new Date(iso + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short" })
    : "–";

const todayIST = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());

function timing(ipo: Ipo): string {
  const today = todayIST();
  const days = (d: string) => Math.round((Date.parse(d) - Date.parse(today)) / 86_400_000);
  if (ipo.status === "open" && ipo.closeDate) {
    const d = days(ipo.closeDate);
    return d <= 0 ? "Closes today" : d === 1 ? "Closes tomorrow" : `Closes in ${d} days`;
  }
  if (ipo.status === "upcoming") {
    if (!ipo.openDate) return "Dates not announced";
    const d = days(ipo.openDate);
    return d <= 0 ? "Opens today" : d === 1 ? "Opens tomorrow" : `Opens ${fmtDate(ipo.openDate)}`;
  }
  if (ipo.status === "closed") return ipo.listingDate ? `Lists ${fmtDate(ipo.listingDate)}` : "Closed";
  return ipo.listingDate ? `Listed ${fmtDate(ipo.listingDate)}` : "Listed";
}

const verdictClass: Record<Verdict, string> = {
  "Strong apply": "v-strong",
  Apply: "v-apply",
  Risky: "v-risky",
  Avoid: "v-avoid",
};

const fundClass: Record<FundVerdict, string> = {
  Strong: "v-strong",
  Fair: "v-apply",
  Weak: "v-risky",
  Poor: "v-avoid",
};

const statusLabel: Record<Ipo["status"], string> = {
  open: "Open",
  upcoming: "Upcoming",
  closed: "Closed",
  listed: "Listed",
};

function timeAgo(iso: string, now: number) {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}

function readSeen(): Record<string, Seen> {
  try {
    const v2 = localStorage.getItem(STORE_KEY);
    if (v2) return JSON.parse(v2);
    // Carry over the baseline saved by the previous version
    const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) ?? "{}") as Record<string, number>;
    return Object.fromEntries(Object.entries(legacy).map(([k, gmp]) => [k, { gmp }]));
  } catch {
    return {};
  }
}

const arrow = (n: number) => (n > 0 ? "▲" : "▼");
const money = (n: number) => `₹${Math.abs(n).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

export default function Dashboard() {
  const [data, setData] = useState<IpoResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [seen, setSeen] = useState<Record<string, Seen>>({});
  const [justChanged, setJustChanged] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("apply");
  const [filter, setFilter] = useState<Filter>("all");
  const [rankBy, setRankBy] = useState<RankBy>("listing");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const refresh = useCallback(async (manual: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/ipos?t=${Date.now()}`, { cache: "no-store" });
      const json = (await res.json()) as IpoResponse;
      if (!json.ipos?.length) {
        throw new Error(
          json.sources?.map((s) => `${s.name}: ${s.error ?? "no data"}`).join(" · ") ||
            `Request failed (${res.status})`,
        );
      }

      // Compare with the GMPs this browser saw last time. A move stays on
      // screen until the GMP moves again, so a quiet refresh doesn't hide it.
      const prev = readSeen();
      const next: Record<string, Seen> = {};
      const changedNow = new Set<string>();
      for (const ipo of json.ipos) {
        if (ipo.gmp === null) continue;
        const p = prev[ipo.name];
        if (p && p.gmp !== ipo.gmp) {
          next[ipo.name] = { gmp: ipo.gmp, move: ipo.gmp - p.gmp, at: ipo.gmpUpdatedAt ?? undefined };
          changedNow.add(ipo.name);
        } else {
          next[ipo.name] = p ?? { gmp: ipo.gmp };
        }
      }
      const changed = changedNow.size;
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(next));
      } catch {}
      setSeen(next);
      setJustChanged(changedNow);
      setData(json);
      setNow(Date.now());

      if (manual) {
        const failed = json.sources.filter((s) => !s.ok).length;
        setToast(
          `Updated · ${changed ? `${changed} GMP change${changed > 1 ? "s" : ""}` : "no GMP changes"}` +
            (failed ? ` · ${failed} source${failed > 1 ? "s" : ""} failed` : ""),
        );
        clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => setToast(null), 3500);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh(false);
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  const rankScore = useCallback(
    (i: Ipo) => (rankBy === "listing" ? i.score : i.fundamentals.score) ?? -1,
    [rankBy],
  );

  const applyList = useMemo(
    () =>
      (data?.ipos ?? [])
        .filter((i) => i.status === "open" || i.status === "upcoming")
        .filter((i) => filter === "all" || i.status === filter)
        .sort((a, b) => rankScore(b) - rankScore(a)),
    [data, filter, rankScore],
  );

  const pastList = useMemo(
    () =>
      (data?.ipos ?? [])
        .filter((i) => i.status === "closed" || i.status === "listed")
        .sort(
          (a, b) =>
            Number(a.status === "listed") - Number(b.status === "listed") ||
            (b.listingDate ?? b.closeDate ?? "").localeCompare(a.listingDate ?? a.closeDate ?? ""),
        ),
    [data],
  );

  const stats = useMemo(() => {
    const ipos = data?.ipos ?? [];
    const live = ipos.filter((i) => i.status === "open" || i.status === "upcoming");
    const best = (f: (i: Ipo) => number | null) =>
      [...live].filter((i) => f(i) !== null).sort((a, b) => f(b)! - f(a)!)[0];
    return {
      open: ipos.filter((i) => i.status === "open").length,
      upcoming: ipos.filter((i) => i.status === "upcoming").length,
      topListing: best((i) => i.score),
      topFund: best((i) => i.fundamentals.score),
      // Strong on both: the higher of the two scores' minimum
      both: best((i) => (i.score !== null && i.fundamentals.score !== null ? Math.min(i.score, i.fundamentals.score) : null)),
    };
  }, [data]);

  return (
    <main className="wrap">
      <header className="top">
        <div>
          <h1>IPO Radar</h1>
          <p className="sub">
            Mainboard IPOs · NSE &amp; BSE
            {data && (
              <>
                {" · "}Updated{" "}
                <span title={new Date(data.fetchedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}>
                  {new Date(data.fetchedAt).toLocaleTimeString("en-IN", {
                    timeZone: "Asia/Kolkata",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}{" "}
                  IST ({timeAgo(data.fetchedAt, now)})
                </span>
              </>
            )}
          </p>
        </div>
        <button className="refresh" onClick={() => refresh(true)} disabled={loading}>
          <svg className={loading ? "spin" : ""} width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </header>

      {data && (
        <div className="sources">
          {data.sources.map((s) => (
            <span key={s.name} className={`src ${s.ok ? "ok" : "bad"}`} title={s.error ?? `${s.count} rows`}>
              <i />
              {s.name}
            </span>
          ))}
        </div>
      )}

      {error && (
        <div className="error">
          <strong>Couldn’t load IPO data.</strong> {error}
        </div>
      )}

      {!data && !error && <Skeleton />}

      {data && (
        <>
          <section className="summary" aria-label="Summary">
            {stats.topListing || stats.topFund ? (
              <ul className="calls">
                {stats.topListing && (
                  <li>
                    <span className="muted">Best listing gain</span>
                    <a href={`#${stats.topListing.id}`}>{stats.topListing.name}</a>
                    <span className="num">
                      {stats.topListing.score}{" "}
                      {stats.topListing.gmpPct != null && (
                        <span className={tone(stats.topListing.gmpPct)}>· GMP {pct(stats.topListing.gmpPct)}</span>
                      )}
                    </span>
                  </li>
                )}
                {stats.topFund && (
                  <li>
                    <span className="muted">Strongest business</span>
                    <a href={`#${stats.topFund.id}`}>{stats.topFund.name}</a>
                    <span className="num">
                      {stats.topFund.fundamentals.score}{" "}
                      <span className="muted">· {stats.topFund.fundamentals.verdict}</span>
                    </span>
                  </li>
                )}
                {stats.both && (
                  <li>
                    <span className="muted">Best on both</span>
                    <a href={`#${stats.both.id}`}>{stats.both.name}</a>
                    <span className="num">
                      {stats.both.score} / {stats.both.fundamentals.score}
                    </span>
                  </li>
                )}
              </ul>
            ) : (
              <p className="call">No mainboard IPO is open or upcoming right now. Check back after the next refresh.</p>
            )}
            <dl className="counts">
              <div><dt>Open</dt><dd className="num">{stats.open}</dd></div>
              <div><dt>Upcoming</dt><dd className="num">{stats.upcoming}</dd></div>
            </dl>
          </section>

          <nav className="tabs">
            <div className="seg">
              <button className={tab === "apply" ? "on" : ""} onClick={() => setTab("apply")}>
                Apply ranking
              </button>
              <button className={tab === "past" ? "on" : ""} onClick={() => setTab("past")}>
                Closed &amp; listed
              </button>
            </div>
            {tab === "apply" && (
              <div className="controls">
                <div className="seg small" role="group" aria-label="Rank by">
                  <span className="seg-label">Rank by</span>
                  <button className={rankBy === "listing" ? "on" : ""} onClick={() => setRankBy("listing")}>
                    Listing gain
                  </button>
                  <button className={rankBy === "fundamentals" ? "on" : ""} onClick={() => setRankBy("fundamentals")}>
                    Fundamentals
                  </button>
                </div>
                <div className="seg small" role="group" aria-label="Status">
                  {(["all", "open", "upcoming"] as Filter[]).map((f) => (
                    <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
                      {f === "all" ? "All" : f === "open" ? "Open" : "Upcoming"}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </nav>

          {tab === "apply" ? (
            <section className="list">
              <div className="row head">
                <span>#</span>
                <span>IPO</span>
                <span className={rankBy === "listing" ? "sorted" : ""}>Listing score</span>
                <span className={rankBy === "fundamentals" ? "sorted" : ""}>Fundamentals</span>
                <span className="r">GMP</span>
                <span className="r">Profit / lot</span>
                <span className="r">Subscription</span>
              </div>
              {applyList.length === 0 && (
                <p className="empty">
                  No {filter === "all" ? "open or upcoming" : filter} mainboard IPOs right now. New issues usually
                  appear here a week before they open; hit Refresh to check again.
                </p>
              )}
              {applyList.map((ipo, idx) => (
                <IpoRow
                  key={ipo.id}
                  ipo={ipo}
                  rank={idx + 1}
                  seen={seen[ipo.name]}
                  flash={justChanged.has(ipo.name)}
                  open={expanded === ipo.id}
                  onToggle={() => setExpanded(expanded === ipo.id ? null : ipo.id)}
                />
              ))}
            </section>
          ) : (
            <>
              <GmpTrack ipos={pastList} />
              <section className="list past">
                <div className="row head">
                  <span>IPO</span>
                  <span className="r">Issue price</span>
                  <span className="r">Final GMP</span>
                  <span className="r">Listed at</span>
                  <span className="r">vs GMP</span>
                  <span className="r">Profit / lot</span>
                  <span className="r">Subscribed</span>
                </div>
                {pastList.length === 0 && (
                  <p className="empty">No recently closed or listed mainboard IPOs. They appear here once bidding ends.</p>
                )}
                {pastList.map((ipo) => {
                  const L = ipo.listing;
                  const finalGmp = ipo.gmpAtListing ?? ipo.gmp;
                  return (
                    <div className="row" key={ipo.id}>
                      <div className="name">
                        <a href={ipo.url ?? undefined} target="_blank" rel="noreferrer">
                          {ipo.name}
                        </a>
                        <span className="meta">
                          <span className={`chip s-${ipo.status}`}>
                            {ipo.status === "listed" ? "Listed" : "Awaiting listing"}
                          </span>
                          <span className="muted">{timing(ipo)}</span>
                        </span>
                      </div>
                      <div className="r" data-l="Issue price">
                        <span className="num">{inr(ipo.price)}</span>
                      </div>
                      <div className="r" data-l="Final GMP">
                        <span className={`num ${tone(finalGmp)}`}>{inr(finalGmp, 2)}</span>
                        <span className="num small muted nowrap">
                          {L?.expectedPct != null ? pct(L.expectedPct) : pct(ipo.gmpPct)}
                          {ipo.gmpAtClose !== null && ` · ${inr(ipo.gmpAtClose, 2)} at close`}
                        </span>
                      </div>
                      <div className="r" data-l="Listed at">
                        {L ? (
                          <>
                            <span className="num">{inr(L.price, 2)}</span>
                            <span className={`num small ${tone(L.gainPct)}`}>{pct(L.gainPct)}</span>
                          </>
                        ) : (
                          <span className="small muted">Expected {inr(ipo.estListing, 2)}</span>
                        )}
                      </div>
                      <div className="r" data-l="vs GMP">
                        {L?.gapPts != null ? (
                          <>
                            <span className={`num ${Math.abs(L.gapPts) <= 5 ? "muted" : tone(L.gapPts)}`}>
                              {L.gapPts >= 0 ? "+" : ""}
                              {L.gapPts.toFixed(1)} pts
                            </span>
                            <span className="small muted">
                              {Math.abs(L.gapPts) <= 5 ? "In line" : L.gapPts > 0 ? "Beat GMP" : "Below GMP"}
                            </span>
                          </>
                        ) : (
                          <span className="small muted">–</span>
                        )}
                      </div>
                      <div className="r" data-l="Profit / lot">
                        <span className={`num ${tone(L?.profitPerLot ?? ipo.profitPerLot)}`}>
                          {inr(L?.profitPerLot ?? ipo.profitPerLot)}
                        </span>
                        <span className="small muted">{L ? "Actual" : "Expected"}</span>
                      </div>
                      <div className="r" data-l="Subscribed">
                        <span className="num">{x(ipo.subscription.total)}</span>
                      </div>
                    </div>
                  );
                })}
              </section>
            </>
          )}

          <footer className="foot">
            <p>
              <strong>Listing score</strong> estimates listing-day gain: GMP as a % of price (45%), QIB demand (20%),
              overall subscription relative to how far bidding has gone (15%), GMP momentum (10%) and market buzz
              (10%).
            </p>
            <p>
              <strong>Fundamentals</strong> rates the business itself, for holding beyond listing day: profitability
              (20%), multi-year profit growth (15%), revenue growth (10%), latest part-year results (10%), ROE and ROA
              (15%), valuation against listed peers and PEG (15%), debt (10%) and how much of the issue is fresh money
              (5%). Ratios are judged against standard bands, e.g. ROE above 25% is excellent and debt/equity under 0.3
              is conservative.
            </p>
            <p>
              <strong>GMP moves:</strong> the small ▲/▼ badge beside a GMP is the last change since you last
              refreshed in this browser, and it stays until the GMP moves again. The line underneath compares
              today’s GMP with the last one logged before today, so it’s the same on every device.
            </p>
            <p>
              <strong>Closed &amp; listed</strong> compares each listing with its final GMP (the last one before
              listing): “vs GMP” is the actual listing gain minus the gain GMP implied, in percentage points.
            </p>
            <p>
              Both scores leave out data that isn’t available rather than scoring it as zero. Click any row to see the
              breakdown, financials and peers.
            </p>
            <p className="muted">
              GMP is an unofficial grey-market indicator and can change quickly. Financials are the company’s restated
              figures from the prospectus. This dashboard is for information only and is not investment advice. Data
              from InvestorGain.
            </p>
          </footer>
        </>
      )}

      {toast && <div className="toast">{toast}</div>}
    </main>
  );
}

const tone = (n: number | null) => (n === null ? "" : n > 0 ? "pos" : n < 0 ? "neg" : "");

const crore = (n: number | null) =>
  n === null ? "–" : n.toLocaleString("en-IN", { maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : 1 });

function ScoreCell({
  label,
  score,
  verdict,
  cls,
  empty,
  className = "",
}: {
  className?: string;
  label: string;
  score: number | null;
  verdict: string | null;
  cls: string;
  empty: string;
}) {
  return (
    <div className={`score ${className}`} data-l={label}>
      <span className="sv num">{score ?? "–"}</span>
      <div className="sbar">
        <i style={{ width: `${score ?? 0}%` }} className={cls} />
      </div>
      <span className={`verdict ${verdict ? cls : "v-avoid"}`}>{verdict ?? empty}</span>
    </div>
  );
}

function Parts({ title, parts, note }: { title: string; parts: Ipo["scoreParts"]; note?: string }) {
  return (
    <div className="parts">
      <h3>{title}</h3>
      {note && <p className="pd">{note}</p>}
      {parts.map((p) => (
        <div key={p.key} className={`part ${p.value === null ? "na" : ""}`}>
          <div className="ph">
            <span>{p.label}</span>
            <span className="num muted">
              {p.value === null ? "not counted" : `${Math.round(p.value * p.weight)} / ${p.weight}`}
            </span>
          </div>
          <div className="pbar">
            <i style={{ width: `${(p.value ?? 0) * 100}%` }} />
          </div>
          <span className="pd">{p.detail}</span>
        </div>
      ))}
    </div>
  );
}

/** Ratio value with its standard band label */
function band(v: number | null, bands: [number, string][], last: string) {
  if (v === null) return null;
  for (const [limit, label] of bands) if (v < limit) return label;
  return last;
}

function IpoRow({
  ipo,
  rank,
  seen,
  flash,
  open,
  onToggle,
}: {
  ipo: Ipo;
  rank: number;
  seen?: Seen;
  flash: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const s = ipo.subscription;
  const f = ipo.fundamentals;
  const r = f.ratios;
  const fd = f.data;
  const pctv = (n: number | null | undefined, d = 1) =>
    n == null ? "–" : `${n.toLocaleString("en-IN", { maximumFractionDigits: d })}%`;
  const mult = (n: number | null | undefined) =>
    n == null ? "–" : `${n.toLocaleString("en-IN", { maximumFractionDigits: 1 })}x`;

  const ratioRows: [string, string, string | null][] = [
    ["ROE", pctv(r.roe), band(r.roe ?? null, [[8, "below avg"], [15, "acceptable"], [25, "good"]], "excellent")],
    ["ROA", pctv(r.roa), band(r.roa ?? null, [[3, "below avg"], [6, "acceptable"], [12, "good"]], "excellent")],
    ["ROCE", pctv(r.roce), null],
    ["Net margin", pctv(r.netMargin), band(r.netMargin ?? null, [[3, "below avg"], [10, "acceptable"], [20, "good"]], "excellent")],
    ["EBITDA margin", pctv(r.ebitdaMargin), band(r.ebitdaMargin ?? null, [[5, "below avg"], [15, "acceptable"], [25, "good"]], "excellent")],
    ["Debt / equity", r.de == null ? "–" : r.de.toFixed(2), band(r.de ?? null, [[0.3, "conservative"], [0.8, "moderate"], [2, "elevated"]], "high risk")],
    ["P/E", mult(r.pe), r.pe != null && r.pe <= 0 ? "loss" : band(r.pe ?? null, [[10, "value"], [20, "fair"], [35, "growth"]], "premium")],
    ["P/B", mult(r.pb), band(r.pb ?? null, [[1, "value"], [2.5, "fair"], [5, "growth"]], "premium")],
    ["P/S", mult(r.ps), band(r.ps ?? null, [[1, "value"], [3, "fair"], [8, "growth"]], "premium")],
    ["PEG", r.peg == null ? "–" : r.peg.toFixed(2), band(r.peg ?? null, [[0.5, "cheap"], [1, "fair"], [2, "fully valued"]], "overvalued")],
  ];

  return (
    <div className={`item ${open ? "open" : ""}`} id={ipo.id}>
      <button className="row" onClick={onToggle} aria-expanded={open}>
        <span className={`rank ${rank <= 3 ? "top" : ""}`}>{rank}</span>
        <div className="name">
          <strong>{ipo.name}</strong>
          <span className="meta">
            <span className={`chip s-${ipo.status}`}>{statusLabel[ipo.status]}</span>
            <span className="muted">{timing(ipo)}</span>
          </span>
          {f.flags.length > 0 && (
            <span className="flags">
              {f.flags.filter((fl) => fl.tone !== "good").slice(0, 2).map((fl) => (
                <span key={fl.text} className={`flag ${fl.tone}`}>{fl.text}</span>
              ))}
              {f.flags.every((fl) => fl.tone === "good") &&
                f.flags.slice(0, 2).map((fl) => (
                  <span key={fl.text} className="flag good">{fl.text}</span>
                ))}
            </span>
          )}
        </div>
        <ScoreCell
          label="Listing score"
          score={ipo.score}
          verdict={ipo.verdict}
          cls={ipo.verdict ? verdictClass[ipo.verdict] : ""}
          empty={ipo.price ? "Not scored" : "Price band TBA"}
          className="c-a"
        />
        <ScoreCell
          label="Fundamentals"
          score={f.score}
          verdict={f.verdict}
          cls={f.verdict ? fundClass[f.verdict] : ""}
          empty={fd ? "Not enough data" : "No financials"}
          className="c-b"
        />
        <div className="r c-a" data-l="GMP">
          <span className="gmp-line">
            {seen?.move ? (
              <span
                className={`move ${seen.move > 0 ? "pos" : "neg"}`}
                title={`Last move you saw: ${seen.move > 0 ? "up" : "down"} ${money(seen.move)}${seen.at ? ` (updated ${seen.at})` : ""}`}
              >
                {arrow(seen.move)}
                {money(seen.move).slice(1)}
                {seen.at && <small> {seen.at.replace(/^\S+\s/, "")}</small>}
              </span>
            ) : null}
            <span className={`num big ${tone(ipo.gmp)} ${flash ? "flash" : ""}`}>{inr(ipo.gmp, 2)}</span>
          </span>
          <span className="num small nowrap">
            <span className={tone(ipo.gmpPct)}>{pct(ipo.gmpPct)}</span>
            <span className="muted"> on {inr(ipo.price)}</span>
          </span>
          {ipo.gmpDayChange && (
            <span
              className="num small nowrap"
              title={`${money(ipo.gmpDayChange.from)} on ${ipo.gmpDayChange.since}, the last GMP logged before today`}
            >
              {ipo.gmpDayChange.change === 0 ? (
                <span className="muted">No change</span>
              ) : (
                <span className={tone(ipo.gmpDayChange.change)}>
                  {arrow(ipo.gmpDayChange.change)} {money(ipo.gmpDayChange.change)}
                </span>
              )}
              <span className="muted"> vs {ipo.gmpDayChange.since}</span>
            </span>
          )}
        </div>
        <div className="r c-b" data-l="Profit / lot">
          <span className={`num big ${tone(ipo.profitPerLot)}`}>{inr(ipo.profitPerLot)}</span>
          <span className="num small muted nowrap">
            {ipo.lot ?? "–"} sh · min {inr(ipo.minInvestment)}
          </span>
        </div>
        <div className="r c-a" data-l="Subscription">
          {s.total === null && s.qib === null ? (
            <span className="small muted">{ipo.status === "upcoming" ? `Bids open ${fmtDate(ipo.openDate)}` : "No data yet"}</span>
          ) : (
            <>
              <span className="num">{x(s.total)}</span>
              <span className="num small muted nowrap" title="QIB · NII · Retail">
                Q {short(s.qib)} · N {short(s.nii)} · R {short(s.retail)}
              </span>
            </>
          )}
        </div>
      </button>

      {open && (
        <div className="detail">
          {f.flags.length > 0 && (
            <div className="flags all">
              {f.flags.map((fl) => (
                <span key={fl.text} className={`flag ${fl.tone}`}>{fl.text}</span>
              ))}
            </div>
          )}

          <div className="cols">
            <Parts title="Listing score" parts={ipo.scoreParts} />
            <Parts
              title="Fundamentals"
              parts={f.parts}
              note={fd ? `Based on ${Math.round(f.coverage * 100)}% of the factors; the rest weren’t reported.` : undefined}
            />
          </div>

          {fd && fd.periods.length > 0 && (
            <div className="fin">
              <h3>Financials <span className="muted">(₹ crore, restated)</span></h3>
              <div className="tbl-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Period ended</th>
                      {fd.periods.map((p) => (
                        <th key={p.label} className="r">
                          {p.label}
                          {!p.fullYear && <span className="muted"> (part)</span>}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(
                      [
                        ["Revenue", "revenue"],
                        ["Profit after tax", "pat"],
                        ["EBITDA", "ebitda"],
                        ["Net worth", "netWorth"],
                        ["Borrowing", "borrowing"],
                        ["Total assets", "assets"],
                      ] as const
                    ).map(([label, key]) => (
                      <tr key={key}>
                        <td>{label}</td>
                        {fd.periods.map((p) => (
                          <td key={p.label} className={`r num ${key === "pat" ? tone(p.pat) : ""}`}>
                            {crore(p[key])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="cols">
            {fd && (
              <div>
                <h3>Key ratios</h3>
                <dl className="ratios">
                  {ratioRows.map(([k, v, b]) => (
                    <div key={k}>
                      <dt>{k}</dt>
                      <dd>
                        <span className="num">{v}</span>
                        {b && <span className={`band b-${b.replace(/\s+/g, "-")}`}>{b}</span>}
                      </dd>
                    </div>
                  ))}
                </dl>
                {fd.peers.length > 0 && (
                  <p className="pd peers">
                    Listed peers (P/E): {fd.peers.map((p) => `${p.name} ${p.pe ?? "–"}`).join(", ")}
                    {fd.peerMedianPe && ` · median ${fd.peerMedianPe.toFixed(1)}`}
                  </p>
                )}
              </div>
            )}
            <div>
              <h3>Issue</h3>
              <dl className="facts">
                <div><dt>Sector</dt><dd>{fd?.sector ?? "–"}</dd></div>
                <div><dt>Issue size</dt><dd>{ipo.sizeCr ? `₹${ipo.sizeCr.toLocaleString("en-IN")} Cr` : "–"}</dd></div>
                <div><dt>Offer for sale</dt><dd>{fd?.ofsPct != null ? `${Math.round(fd.ofsPct)}% of issue` : "–"}</dd></div>
                <div><dt>Market cap</dt><dd>{fd?.marketCapCr ? `₹${crore(fd.marketCapCr)} Cr` : "–"}</dd></div>
                <div><dt>Promoter holding</dt><dd>{fd?.promoterPre != null ? `${fd.promoterPre}% → ${fd.promoterPost ?? "–"}%` : "–"}</dd></div>
                <div><dt>Bidding</dt><dd>{fmtDate(ipo.openDate)} to {fmtDate(ipo.closeDate)}</dd></div>
                <div><dt>Allotment</dt><dd>{fmtDate(ipo.allotmentDate)}</dd></div>
                <div><dt>Listing</dt><dd>{fmtDate(ipo.listingDate)}</dd></div>
                <div><dt>GMP range</dt><dd>{ipo.gmpLow !== null ? `${inr(ipo.gmpLow, 2)} to ${inr(ipo.gmpHigh, 2)}` : "–"}</dd></div>
                <div><dt>Retail allotment odds</dt><dd>{s.retail && s.retail > 1 ? `~1 in ${Math.ceil(s.retail)}` : s.retail !== null ? "Very likely" : "–"}</dd></div>
                <div><dt>GMP updated</dt><dd>{ipo.gmpUpdatedAt ?? "–"}</dd></div>
              </dl>
              {ipo.gmpHistory.length > 0 && (
                <>
                  <h3 className="sub-h">GMP history</h3>
                  <ol className="history">
                    {ipo.gmpHistory.slice(0, 8).map((h, i) => {
                      const older = ipo.gmpHistory[i + 1]?.gmp;
                      const d = h.gmp !== null && older != null ? h.gmp - older : null;
                      return (
                        <li key={h.at}>
                          <span className="muted">{h.at}</span>
                          <span className="num">{inr(h.gmp, 2)}</span>
                          <span className={`num ${d ? tone(d) : "muted"}`}>
                            {d === null ? "" : d === 0 ? "–" : `${arrow(d)} ${money(d)}`}
                          </span>
                        </li>
                      );
                    })}
                  </ol>
                </>
              )}
            </div>
          </div>

          {ipo.url && (
            <a className="more" href={ipo.url} target="_blank" rel="noreferrer">
              Full details on InvestorGain ↗
            </a>
          )}
        </div>
      )}
    </div>
  );
}

/** How well the final GMP predicted actual listings, across the recent ones shown. */
function GmpTrack({ ipos }: { ipos: Ipo[] }) {
  const done = ipos.filter((i) => i.listing?.expectedPct != null) as (Ipo & {
    listing: NonNullable<Ipo["listing"]> & { expectedPct: number; gapPts: number };
  })[];
  if (done.length < 3) return null;

  const n = done.length;
  const above = ipos.filter((i) => i.listing && i.listing.gainPct > 0).length;
  const listedCount = ipos.filter((i) => i.listing).length;
  // "Direction": GMP of 1%+ means it called a gain; below that, a flat or negative listing
  const rightWay = done.filter((i) =>
    i.listing.expectedPct >= 1 ? i.listing.gainPct > 0 : i.listing.gainPct <= 1,
  ).length;
  const gaps = done.map((i) => i.listing.gapPts);
  const meanGap = gaps.reduce((a, b) => a + b, 0) / n;
  const abs = gaps.map(Math.abs).sort((a, b) => a - b);
  const medianMiss = n % 2 ? abs[n >> 1] : (abs[n / 2 - 1] + abs[n / 2]) / 2;
  const inLine = gaps.filter((g) => Math.abs(g) <= 5).length;
  const biggest = [...done].sort((a, b) => Math.abs(b.listing.gapPts) - Math.abs(a.listing.gapPts))[0];

  return (
    <section className="track" aria-label="How accurate GMP has been">
      <h2>How accurate GMP has been</h2>
      <p className="muted">Final GMP vs actual listing, last {n} mainboard listings</p>
      <dl className="track-stats">
        <div>
          <dt>Called the direction</dt>
          <dd className="num">{rightWay} of {n}</dd>
          <span className="muted">gain vs flat or loss</span>
        </div>
        <div>
          <dt>Within 5 pts of GMP</dt>
          <dd className="num">{inLine} of {n}</dd>
          <span className="muted">typical miss ±{medianMiss.toFixed(1)} pts</span>
        </div>
        <div>
          <dt>On average, listings were</dt>
          <dd className={`num ${tone(meanGap)}`}>
            {Math.abs(meanGap).toFixed(1)} pts {meanGap >= 0 ? "above" : "below"}
          </dd>
          <span className="muted">what GMP implied</span>
        </div>
        <div>
          <dt>Listed above issue price</dt>
          <dd className="num">{above} of {listedCount}</dd>
          <span className="muted">
            biggest miss: {biggest.name} {biggest.listing.gapPts >= 0 ? "+" : ""}
            {biggest.listing.gapPts.toFixed(0)} pts
          </span>
        </div>
      </dl>
    </section>
  );
}

function Skeleton() {
  return (
    <div className="skeleton" aria-busy="true" aria-label="Loading IPO data">
      <div className="sk summary-sk" />
      {[0, 1, 2, 3, 4].map((i) => (
        <div className="sk line" key={i} />
      ))}
    </div>
  );
}
