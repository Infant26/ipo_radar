"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Ipo, IpoResponse, Verdict } from "@/lib/types";

const PREV_KEY = "ipo-radar:prev-gmp";

type Tab = "apply" | "past";
type Filter = "all" | "open" | "upcoming";

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

function readPrev(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(PREV_KEY) ?? "{}");
  } catch {
    return {};
  }
}

export default function Dashboard() {
  const [data, setData] = useState<IpoResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [deltas, setDeltas] = useState<Record<string, number>>({});
  const [toast, setToast] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("apply");
  const [filter, setFilter] = useState<Filter>("all");
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

      // GMP change since the previous refresh
      const prev = readPrev();
      const next: Record<string, number> = {};
      const d: Record<string, number> = {};
      let changed = 0;
      for (const ipo of json.ipos) {
        if (ipo.gmp === null) continue;
        next[ipo.name] = ipo.gmp;
        if (ipo.name in prev && prev[ipo.name] !== ipo.gmp) {
          d[ipo.name] = ipo.gmp - prev[ipo.name];
          changed++;
        }
      }
      try {
        localStorage.setItem(PREV_KEY, JSON.stringify(next));
      } catch {}
      setDeltas(d);
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

  const applyList = useMemo(
    () =>
      (data?.ipos ?? [])
        .filter((i) => i.status === "open" || i.status === "upcoming")
        .filter((i) => filter === "all" || i.status === filter)
        .sort((a, b) => (b.score ?? -1) - (a.score ?? -1)),
    [data, filter],
  );

  const pastList = useMemo(
    () =>
      (data?.ipos ?? [])
        .filter((i) => i.status === "closed" || i.status === "listed")
        .sort((a, b) => (b.closeDate ?? "").localeCompare(a.closeDate ?? "")),
    [data],
  );

  const stats = useMemo(() => {
    const ipos = data?.ipos ?? [];
    const live = ipos.filter((i) => i.status === "open" || i.status === "upcoming");
    const top = [...live].sort((a, b) => (b.score ?? -1) - (a.score ?? -1))[0];
    const bestGmp = [...live].sort((a, b) => (b.gmpPct ?? -1e9) - (a.gmpPct ?? -1e9))[0];
    return {
      open: ipos.filter((i) => i.status === "open").length,
      upcoming: ipos.filter((i) => i.status === "upcoming").length,
      top,
      bestGmp,
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
            {stats.top ? (
              <p className="call">
                Best to apply for right now: <a href={`#${stats.top.id}`}>{stats.top.name}</a>,{" "}
                score <strong className="num">{stats.top.score}</strong>{" "}
                <span className={`verdict ${stats.top.verdict ? verdictClass[stats.top.verdict] : ""}`}>
                  ({stats.top.verdict})
                </span>
                {stats.top.gmpPct != null && (
                  <>
                    , GMP <strong className={`num ${tone(stats.top.gmpPct)}`}>{pct(stats.top.gmpPct)}</strong>
                  </>
                )}
                .
              </p>
            ) : (
              <p className="call">No mainboard IPO is open or upcoming right now. Check back after the next refresh.</p>
            )}
            <dl className="counts">
              <div><dt>Open</dt><dd className="num">{stats.open}</dd></div>
              <div><dt>Upcoming</dt><dd className="num">{stats.upcoming}</dd></div>
              <div>
                <dt>Highest GMP</dt>
                <dd className="num">
                  {stats.bestGmp?.gmpPct != null ? (
                    <>
                      <span className={tone(stats.bestGmp.gmpPct)}>{pct(stats.bestGmp.gmpPct)}</span>{" "}
                      <span className="muted">{stats.bestGmp.name}</span>
                    </>
                  ) : "–"}
                </dd>
              </div>
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
              <div className="seg small">
                {(["all", "open", "upcoming"] as Filter[]).map((f) => (
                  <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
                    {f === "all" ? "All" : f === "open" ? "Open" : "Upcoming"}
                  </button>
                ))}
              </div>
            )}
          </nav>

          {tab === "apply" ? (
            <section className="list">
              <div className="row head">
                <span>#</span>
                <span>IPO</span>
                <span>Apply score</span>
                <span className="r">GMP</span>
                <span className="r">Profit / lot</span>
                <span className="r">Price · Lot</span>
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
                  delta={deltas[ipo.name]}
                  open={expanded === ipo.id}
                  onToggle={() => setExpanded(expanded === ipo.id ? null : ipo.id)}
                />
              ))}
            </section>
          ) : (
            <section className="list past">
              <div className="row head">
                <span>IPO</span>
                <span className="r">Price</span>
                <span className="r">GMP</span>
                <span className="r">Subscribed</span>
                <span className="r">Listing</span>
              </div>
              {pastList.map((ipo) => (
                <div className="row" key={ipo.id}>
                  <div className="name">
                    <a href={ipo.url ?? undefined} target="_blank" rel="noreferrer">
                      {ipo.name}
                    </a>
                    <span className={`chip s-${ipo.status}`}>
                      {ipo.statusCode === "LP" ? "Listed ↑" : ipo.statusCode === "LN" ? "Listed ↓" : statusLabel[ipo.status]}
                    </span>
                  </div>
                  <span className="r num" data-l="Price">{inr(ipo.price)}</span>
                  <span className={`r num ${tone(ipo.gmp)}`} data-l="GMP">
                    {inr(ipo.gmp, 2)} <small>{pct(ipo.gmpPct)}</small>
                  </span>
                  <span className="r num" data-l="Subscribed">{x(ipo.subscription.total)}</span>
                  <span className="r muted" data-l="Listing">{timing(ipo)}</span>
                </div>
              ))}
            </section>
          )}

          <footer className="foot">
            <p>
              <strong>How the apply score works:</strong> expected listing gain from GMP (45%), QIB demand (20%),
              overall subscription relative to how far bidding has gone (15%), GMP momentum (10%) and market buzz
              (10%). Data that isn’t available yet, like subscription for upcoming IPOs, is left out rather than
              scored as zero. Click any row to see its breakdown.
            </p>
            <p className="muted">
              GMP is an unofficial grey-market indicator and can change quickly. This dashboard is for information
              only and is not investment advice. Data from InvestorGain and IPOWatch.
            </p>
          </footer>
        </>
      )}

      {toast && <div className="toast">{toast}</div>}
    </main>
  );
}

const tone = (n: number | null) => (n === null ? "" : n > 0 ? "pos" : n < 0 ? "neg" : "");

function IpoRow({
  ipo,
  rank,
  delta,
  open,
  onToggle,
}: {
  ipo: Ipo;
  rank: number;
  delta?: number;
  open: boolean;
  onToggle: () => void;
}) {
  const s = ipo.subscription;
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
        </div>
        <div className="score" data-l="Apply score">
          <span className="sv num">{ipo.score ?? "–"}</span>
          <div className="sbar">
            <i style={{ width: `${ipo.score ?? 0}%` }} className={ipo.verdict ? verdictClass[ipo.verdict] : ""} />
          </div>
          {ipo.verdict ? (
            <span className={`verdict ${verdictClass[ipo.verdict]}`}>{ipo.verdict}</span>
          ) : (
            <span className="verdict v-avoid">{ipo.price ? "Not scored" : "Price band TBA"}</span>
          )}
        </div>
        <div className="r" data-l="GMP">
          <span className={`num big ${tone(ipo.gmp)}`}>{inr(ipo.gmp, 2)}</span>
          <span className="num small">
            <span className={tone(ipo.gmpPct)}>{pct(ipo.gmpPct)}</span>
            {delta !== undefined && delta !== 0 && (
              <span className={`delta ${delta > 0 ? "pos" : "neg"}`} title="Change since your last refresh">
                {delta > 0 ? "▲" : "▼"} {Math.abs(delta)}
              </span>
            )}
          </span>
        </div>
        <div className="r" data-l="Profit / lot">
          <span className={`num big ${tone(ipo.profitPerLot)}`}>{inr(ipo.profitPerLot)}</span>
          <span className="num small muted">Est. list {inr(ipo.estListing, 2)}</span>
        </div>
        <div className="r" data-l="Price · Lot">
          <span className="num">
            {inr(ipo.price)} <span className="muted">× {ipo.lot ?? "–"}</span>
          </span>
          <span className="num small muted">Min {inr(ipo.minInvestment)}</span>
        </div>
        <div className="r" data-l="Subscription">
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
          <div className="parts">
            {ipo.scoreParts.map((p) => (
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
          <dl className="facts">
            <div><dt>Issue size</dt><dd>{ipo.sizeCr ? `₹${ipo.sizeCr.toLocaleString("en-IN")} Cr` : "–"}</dd></div>
            <div><dt>P/E</dt><dd>{ipo.pe ?? "–"}</dd></div>
            <div><dt>Bidding</dt><dd>{fmtDate(ipo.openDate)} – {fmtDate(ipo.closeDate)}</dd></div>
            <div><dt>Allotment</dt><dd>{fmtDate(ipo.allotmentDate)}</dd></div>
            <div><dt>Listing</dt><dd>{fmtDate(ipo.listingDate)}</dd></div>
            <div><dt>GMP range</dt><dd>{ipo.gmpLow !== null ? `${inr(ipo.gmpLow, 2)} – ${inr(ipo.gmpHigh, 2)}` : "–"}</dd></div>
            <div><dt>IPOWatch GMP</dt><dd>{inr(ipo.gmpAlt, 2)}</dd></div>
            <div><dt>Retail allotment odds</dt><dd>{s.retail && s.retail > 1 ? `~1 in ${Math.ceil(s.retail)}` : s.retail !== null ? "Very likely" : "–"}</dd></div>
            <div><dt>GMP updated</dt><dd>{ipo.gmpUpdatedAt ?? "–"}</dd></div>
          </dl>
          {ipo.url && (
            <a className="more" href={ipo.url} target="_blank" rel="noreferrer">
              Full details on {ipo.source === "investorgain" ? "InvestorGain" : "IPOWatch"} ↗
            </a>
          )}
        </div>
      )}
    </div>
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
