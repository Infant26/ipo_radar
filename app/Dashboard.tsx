"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, LayoutGroup, MotionConfig, motion, useReducedMotion } from "motion/react";
import {
  ArrowSquareOut,
  ArrowsClockwise,
  Buildings,
  CaretDown,
  CheckCircle,
  Lightning,
  Scales,
  SealCheck,
  Target,
  TrendDown,
  TrendUp,
  Warning,
  WarningCircle,
} from "@phosphor-icons/react";
import type { Flag, FundVerdict, Ipo, IpoResponse, Verdict } from "@/lib/types";
import { CountUp, EASE_OUT, Ring, SPRING, Seg } from "./ui";
import TopNav from "./TopNav";

// v3: GMP became the median of several sources, so older baselines aren't comparable
const STORE_KEY = "ipo-radar:gmp-v3";
const NA = "n/a";

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
  n === null || n === undefined ? NA : "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: digits });

const x = (n: number | null | undefined) =>
  n === null || n === undefined ? NA : `${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}x`;

const short = (n: number | null) => (n === null ? "-" : n >= 10 ? n.toFixed(0) : n.toFixed(1));

const pct = (n: number | null | undefined) =>
  n === null || n === undefined ? NA : `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : NA;

const todayIST = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());

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
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

const money = (n: number) => `₹${Math.abs(n).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const tone = (n: number | null | undefined) => (n == null ? "" : n > 0 ? "pos" : n < 0 ? "neg" : "");
const crore = (n: number | null) =>
  n === null ? NA : n.toLocaleString("en-IN", { maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : 1 });
const fmtInr2 = (n: number) => "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
const fmtInt = (n: number) => String(Math.round(n));

const LISTING_COLOR = "var(--saffron)";
const FUND_COLOR = "var(--cyan)";

export default function Dashboard() {
  const [data, setData] = useState<IpoResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [seen, setSeen] = useState<Record<string, Seen>>({});
  const [justChanged, setJustChanged] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<{ text: string; ok: boolean } | null>(null);
  const [tab, setTab] = useState<Tab>("apply");
  const [filter, setFilter] = useState<Filter>("all");
  const [rankBy, setRankBy] = useState<RankBy>("listing");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const reduce = useReducedMotion();

  const refresh = useCallback(async (manual: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/ipos?t=${Date.now()}`, { cache: "no-store" });
      const json = (await res.json()) as IpoResponse;
      if (!json.ipos?.length) {
        throw new Error(
          json.sources?.map((s) => `${s.name}: ${s.error ?? "no data"}`).join(". ") ||
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
        setToast({
          text:
            `Updated, ${changed ? `${changed} GMP change${changed > 1 ? "s" : ""}` : "no GMP changes"}` +
            (failed ? `. ${failed} source${failed > 1 ? "s" : ""} failed` : ""),
          ok: failed === 0,
        });
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
      // Strong on both: the best of each IPO's weaker score
      both: best((i) =>
        i.score !== null && i.fundamentals.score !== null ? Math.min(i.score, i.fundamentals.score) : null,
      ),
    };
  }, [data]);

  /** Jump from a pick tile to its row and open it. */
  const focusIpo = (id: string) => {
    setTab("apply");
    setFilter("all");
    setExpanded(id);
    requestAnimationFrame(() =>
      setTimeout(
        () => document.getElementById(id)?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" }),
        60,
      ),
    );
  };

  const failedSources = data?.sources.filter((s) => !s.ok) ?? [];

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
                Mainboard IPOs on NSE and BSE
                {data && (
                  <>
                    <span className="sep" aria-hidden>
                      /
                    </span>
                    <span className="count open">{stats.open} open</span>
                    <span className="count upcoming">{stats.upcoming} upcoming</span>
                  </>
                )}
              </p>
            </div>
          </div>
          <TopNav active="ipos" />
          <div className="top-right">
            {data && (
              <span
                className={`status ${failedSources.length ? "bad" : "ok"}`}
                title={data.sources.map((s) => `${s.name}: ${s.ok ? `${s.count} rows` : s.error}`).join("\n")}
              >
                <i aria-hidden />
                {failedSources.length
                  ? `${failedSources.length} source${failedSources.length > 1 ? "s" : ""} failed`
                  : `Live from ${new Set(data.sources.map((s) => s.name.split(" ")[0])).size} sources, updated ${timeAgo(data.fetchedAt, now)}`}
              </span>
            )}
            <motion.button
              className="refresh"
              onClick={() => refresh(true)}
              disabled={loading}
              whileHover={reduce ? undefined : { y: -1 }}
              whileTap={{ scale: 0.97 }}
              transition={SPRING}
            >
              <ArrowsClockwise size={17} weight="bold" className={loading ? "spin" : ""} />
              {loading ? "Refreshing" : "Refresh"}
            </motion.button>
          </div>
        </header>

        {data && failedSources.length > 0 && (
          <p className="warn-line">
            <WarningCircle size={16} weight="fill" />
            {failedSources.map((s) => `${s.name}: ${s.error ?? "no data"}`).join(". ")}
          </p>
        )}

        {error && (
          <div className="error" role="alert">
            <WarningCircle size={20} weight="fill" />
            <div>
              <strong>Couldn’t load IPO data.</strong> {error}
            </div>
            <button className="text-btn" onClick={() => refresh(true)}>
              Try again
            </button>
          </div>
        )}

        {!data && !error && <Skeleton />}

        {data && (
          <>
            <Picks stats={stats} onPick={focusIpo} />

            <nav className="toolbar" aria-label="View">
              <Seg
                id="tab"
                label="View"
                value={tab}
                onChange={setTab}
                options={[
                  { value: "apply", label: "Apply ranking" },
                  { value: "past", label: "Closed & listed" },
                ]}
              />
              {tab === "apply" && (
                <div className="controls">
                  <span className="ctl-label">Rank by</span>
                  <Seg
                    id="rank"
                    label="Rank by"
                    size="sm"
                    value={rankBy}
                    onChange={setRankBy}
                    accent={rankBy === "listing" ? "var(--saffron-soft)" : "var(--cyan-soft)"}
                    options={[
                      { value: "listing", label: "Listing gain" },
                      { value: "fundamentals", label: "Fundamentals" },
                    ]}
                  />
                  <Seg
                    id="filter"
                    label="Status"
                    size="sm"
                    value={filter}
                    onChange={setFilter}
                    options={[
                      { value: "all", label: "All" },
                      { value: "open", label: "Open" },
                      { value: "upcoming", label: "Upcoming" },
                    ]}
                  />
                </div>
              )}
            </nav>

            <AnimatePresence mode="wait" initial={false}>
              {tab === "apply" ? (
                <motion.section
                  key="apply"
                  className="list"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.22, ease: EASE_OUT }}
                >
                  <div className="row head">
                    <span>#</span>
                    <span>IPO</span>
                    <span className={rankBy === "listing" ? "sorted" : ""}>Listing score</span>
                    <span className={rankBy === "fundamentals" ? "sorted" : ""}>Fundamentals</span>
                    <span className="r">GMP</span>
                    <span className="r">Profit / lot</span>
                    <span className="r">Subscription</span>
                    <span />
                  </div>
                  {applyList.length === 0 && (
                    <div className="empty">
                      <Target size={28} weight="duotone" />
                      <p>
                        No {filter === "all" ? "open or upcoming" : filter} mainboard IPOs right now. New issues
                        usually appear about a week before they open.
                      </p>
                      <button className="text-btn" onClick={() => refresh(true)}>
                        Check again
                      </button>
                    </div>
                  )}
                  <LayoutGroup>
                    <AnimatePresence initial={false}>
                      {applyList.map((ipo, idx) => (
                        <IpoRow
                          key={ipo.id}
                          ipo={ipo}
                          rank={idx + 1}
                          index={idx}
                          seen={seen[ipo.name]}
                          flash={justChanged.has(ipo.name)}
                          open={expanded === ipo.id}
                          onToggle={() => setExpanded(expanded === ipo.id ? null : ipo.id)}
                        />
                      ))}
                    </AnimatePresence>
                  </LayoutGroup>
                </motion.section>
              ) : (
                <motion.div
                  key="past"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.22, ease: EASE_OUT }}
                >
                  <GmpTrack ipos={pastList} />
                  <PastList ipos={pastList} />
                </motion.div>
              )}
            </AnimatePresence>

            <footer className="foot">
              <div>
                <h2>How the scores work</h2>
                <p>
                  <strong className="t-saffron">Listing score</strong> estimates the listing-day gain: GMP as a share of
                  the price (45%), QIB demand (20%), overall subscription relative to how far bidding has gone (15%),
                  GMP momentum (10%) and market buzz (10%).
                </p>
                <p>
                  <strong className="t-cyan">Fundamentals</strong> rates the business for holding beyond listing day:
                  profitability (20%), multi-year profit growth (15%), revenue growth (10%), latest part-year results
                  (10%), ROE and ROA (15%), valuation against listed peers and PEG (15%), debt (10%) and how much of
                  the issue is fresh money (5%). Ratios are judged against standard bands, so ROE above 25% is
                  excellent and debt/equity under 0.3 is conservative.
                </p>
                <p>Both scores skip data that isn’t available instead of scoring it as zero.</p>
              </div>
              <div>
                <h2>Reading the numbers</h2>
                <p>
                  The small badge beside a GMP is its last move since you refreshed in this browser, and it stays until
                  the GMP moves again. The line under it compares today’s GMP with the last one logged before today.
                </p>
                <p>
                  Closed &amp; listed compares each listing with its final GMP. “vs GMP” is the actual gain minus the
                  gain GMP implied, in percentage points.
                </p>
                <p>
                  <strong>Sources.</strong> GMP is the median of InvestorGain and IPOji; a green seal means they agree,
                  an amber warning means they differ by more than 10% of the GMP. Subscription comes from NSE’s official
                  bid data while NSE lists the issue, otherwise from InvestorGain. Financials, GMP history and listing
                  results come from InvestorGain.
                </p>
                <p className="muted">
                  GMP is an unofficial grey-market indicator and changes quickly. Financials are the company’s restated
                  prospectus figures. Information only, not investment advice.
                </p>
              </div>
            </footer>
          </>
        )}

        <AnimatePresence>
          {toast && (
            <motion.div
              className={`toast ${toast.ok ? "" : "bad"}`}
              role="status"
              initial={{ opacity: 0, y: 24, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 12, scale: 0.98 }}
              transition={SPRING}
            >
              {toast.ok ? <CheckCircle size={18} weight="fill" /> : <WarningCircle size={18} weight="fill" />}
              {toast.text}
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </MotionConfig>
  );
}

/* ---------------------------------------------------------------------------------------------- */

type Stats = { topListing?: Ipo; topFund?: Ipo; both?: Ipo };

function Picks({ stats, onPick }: { stats: Stats; onPick: (id: string) => void }) {
  if (!stats.topListing && !stats.topFund) {
    return (
      <section className="picks empty-picks">
        <p>No mainboard IPO is open or upcoming right now. Picks show up here as soon as one is announced.</p>
      </section>
    );
  }
  const tiles = [
    stats.topListing && {
      key: "listing",
      cls: "pick-listing",
      icon: <Lightning size={16} weight="fill" />,
      label: "Best listing gain",
      ipo: stats.topListing,
      main: { value: stats.topListing.score, color: LISTING_COLOR },
      line: (
        <>
          GMP <b className={tone(stats.topListing.gmpPct)}>{pct(stats.topListing.gmpPct)}</b>
          {stats.topListing.profitPerLot !== null && <>, {inr(stats.topListing.profitPerLot)} a lot</>}
        </>
      ),
    },
    stats.topFund && {
      key: "fund",
      cls: "pick-fund",
      icon: <Buildings size={16} weight="fill" />,
      label: "Strongest business",
      ipo: stats.topFund,
      main: { value: stats.topFund.fundamentals.score, color: FUND_COLOR },
      line: (
        <>
          Fundamentals <b>{stats.topFund.fundamentals.verdict}</b>
          {stats.topFund.fundamentals.data?.sector && <>, {stats.topFund.fundamentals.data.sector}</>}
        </>
      ),
    },
    stats.both && {
      key: "both",
      cls: "pick-both",
      icon: <Scales size={16} weight="fill" />,
      label: "Best on both",
      ipo: stats.both,
      main: null,
      line: (
        <>
          Listing <b className="t-saffron">{stats.both.score}</b>, fundamentals{" "}
          <b className="t-cyan">{stats.both.fundamentals.score}</b>
        </>
      ),
    },
  ].filter(Boolean) as {
    key: string;
    cls: string;
    icon: React.ReactNode;
    label: string;
    ipo: Ipo;
    main: { value: number | null; color: string } | null;
    line: React.ReactNode;
  }[];

  return (
    <section className="picks" aria-label="Top picks">
      {tiles.map((t, i) => (
        <motion.button
          key={t.key}
          type="button"
          className={`pick ${t.cls}`}
          onClick={() => onPick(t.ipo.id)}
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.05 + i * 0.08, ease: EASE_OUT }}
          whileHover={{ y: -3 }}
          whileTap={{ scale: 0.985 }}
        >
          <span className="pick-label">
            {t.icon}
            {t.label}
          </span>
          <span className="pick-body">
            {t.main ? (
              <Ring value={t.main.value} size={68} stroke={7} color={t.main.color} delay={0.25 + i * 0.08} label={`Score ${t.main.value}`}>
                {t.main.value !== null && <CountUp value={t.main.value} format={fmtInt} duration={1.1} />}
              </Ring>
            ) : (
              <span className="dual" aria-label={`Listing ${t.ipo.score}, fundamentals ${t.ipo.fundamentals.score}`}>
                <Ring value={t.ipo.score} size={68} stroke={6} color={LISTING_COLOR} delay={0.4} />
                <span className="dual-inner">
                  <Ring value={t.ipo.fundamentals.score} size={48} stroke={6} color={FUND_COLOR} delay={0.5} />
                </span>
              </span>
            )}
            <span className="pick-text">
              <span className="pick-name">{t.ipo.name}</span>
              <span className="pick-line">{t.line}</span>
              <span className="pick-when">
                <span className={`chip s-${t.ipo.status}`}>{statusLabel[t.ipo.status]}</span>
                {timing(t.ipo)}
              </span>
            </span>
          </span>
        </motion.button>
      ))}
    </section>
  );
}

/* ---------------------------------------------------------------------------------------------- */

function ScoreCell({
  label,
  score,
  verdict,
  cls,
  empty,
  color,
  className = "",
  delay,
}: {
  className?: string;
  label: string;
  score: number | null;
  verdict: string | null;
  cls: string;
  empty: string;
  color: string;
  delay: number;
}) {
  return (
    <div className={`score ${className}`} data-l={label}>
      <Ring value={score} size={42} stroke={4.5} color={color} delay={delay} label={`${label} ${score ?? NA}`}>
        {score !== null ? <CountUp value={score} format={fmtInt} /> : "-"}
      </Ring>
      <span className={`verdict ${verdict ? cls : "v-none"}`}>{verdict ?? empty}</span>
    </div>
  );
}

/** Marker beside the GMP: do the GMP sources agree? */
function Agreement({ ipo }: { ipo: Ipo }) {
  if (ipo.gmpAgreement !== "agree" && ipo.gmpAgreement !== "differ") return null;
  const list = ipo.gmpQuotes.map((q) => `${q.source} ${fmtInr2(q.gmp)}`).join(", ");
  return ipo.gmpAgreement === "agree" ? (
    <span className="agree ok" title={`${ipo.gmpQuotes.length} sources agree: ${list}`} aria-label={`${ipo.gmpQuotes.length} sources agree`}>
      <SealCheck size={13} weight="fill" />
    </span>
  ) : (
    <span className="agree differ" title={`Sources differ: ${list}`} aria-label="GMP sources differ">
      <Warning size={13} weight="fill" />
    </span>
  );
}

function FlagChip({ flag }: { flag: Flag }) {
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

function Parts({
  title,
  parts,
  note,
  color,
  open,
}: {
  title: string;
  parts: Ipo["scoreParts"];
  note?: string;
  color: string;
  open: boolean;
}) {
  return (
    <div className="parts">
      <h3>{title}</h3>
      {note && <p className="pd">{note}</p>}
      {parts.map((p, i) => (
        <div key={p.key} className={`part ${p.value === null ? "na" : ""}`}>
          <div className="ph">
            <span>{p.label}</span>
            <span className="num muted">
              {p.value === null ? "not counted" : `${Math.round(p.value * p.weight)} / ${p.weight}`}
            </span>
          </div>
          <div className="pbar">
            <motion.i
              style={{ background: color, originX: 0 }}
              initial={{ scaleX: 0 }}
              animate={{ scaleX: open ? p.value ?? 0 : 0 }}
              transition={{ duration: 0.7, delay: 0.12 + i * 0.045, ease: EASE_OUT }}
            />
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
  index,
  seen,
  flash,
  open,
  onToggle,
}: {
  ipo: Ipo;
  rank: number;
  index: number;
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
    n == null ? NA : `${n.toLocaleString("en-IN", { maximumFractionDigits: d })}%`;
  const mult = (n: number | null | undefined) =>
    n == null ? NA : `${n.toLocaleString("en-IN", { maximumFractionDigits: 1 })}x`;

  const ratioRows: [string, string, string | null][] = [
    ["ROE", pctv(r.roe), band(r.roe ?? null, [[8, "below avg"], [15, "acceptable"], [25, "good"]], "excellent")],
    ["ROA", pctv(r.roa), band(r.roa ?? null, [[3, "below avg"], [6, "acceptable"], [12, "good"]], "excellent")],
    ["ROCE", pctv(r.roce), null],
    ["Net margin", pctv(r.netMargin), band(r.netMargin ?? null, [[3, "below avg"], [10, "acceptable"], [20, "good"]], "excellent")],
    ["EBITDA margin", pctv(r.ebitdaMargin), band(r.ebitdaMargin ?? null, [[5, "below avg"], [15, "acceptable"], [25, "good"]], "excellent")],
    ["Debt / equity", r.de == null ? NA : r.de.toFixed(2), band(r.de ?? null, [[0.3, "conservative"], [0.8, "moderate"], [2, "elevated"]], "high risk")],
    ["P/E", mult(r.pe), r.pe != null && r.pe <= 0 ? "loss" : band(r.pe ?? null, [[10, "value"], [20, "fair"], [35, "growth"]], "premium")],
    ["P/B", mult(r.pb), band(r.pb ?? null, [[1, "value"], [2.5, "fair"], [5, "growth"]], "premium")],
    ["P/S", mult(r.ps), band(r.ps ?? null, [[1, "value"], [3, "fair"], [8, "growth"]], "premium")],
    ["PEG", r.peg == null ? NA : r.peg.toFixed(2), band(r.peg ?? null, [[0.5, "cheap"], [1, "fair"], [2, "fully valued"]], "overvalued")],
  ];

  const rowFlags = f.flags.some((fl) => fl.tone !== "good")
    ? f.flags.filter((fl) => fl.tone !== "good").slice(0, 2)
    : f.flags.slice(0, 2);

  return (
    <motion.div
      layout="position"
      className={`item ${open ? "open" : ""}`}
      id={ipo.id}
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, transition: { duration: 0.15 } }}
      transition={{ layout: SPRING, opacity: { duration: 0.45, delay: index * 0.05 }, y: { duration: 0.55, delay: index * 0.05, ease: EASE_OUT } }}
    >
      <button className="row" onClick={onToggle} aria-expanded={open}>
        <span className={`rank r${rank <= 3 ? rank : ""}`}>{rank}</span>
        <div className="name">
          <strong>{ipo.name}</strong>
          <span className="meta">
            <span className={`chip s-${ipo.status}`}>{statusLabel[ipo.status]}</span>
            <span className="muted">{timing(ipo)}</span>
          </span>
          {rowFlags.length > 0 && (
            <span className="flags">
              {rowFlags.map((fl) => (
                <FlagChip key={fl.text} flag={fl} />
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
          color={LISTING_COLOR}
          delay={0.15 + index * 0.05}
          className="c-a"
        />
        <ScoreCell
          label="Fundamentals"
          score={f.score}
          verdict={f.verdict}
          cls={f.verdict ? fundClass[f.verdict] : ""}
          empty={fd ? "Not enough data" : "No financials"}
          color={FUND_COLOR}
          delay={0.22 + index * 0.05}
          className="c-b"
        />
        <div className="r c-a" data-l="GMP">
          <span className="gmp-line">
            {seen?.move ? (
              <span
                className={`move ${seen.move > 0 ? "pos" : "neg"}`}
                title={`Last move you saw: ${seen.move > 0 ? "up" : "down"} ${money(seen.move)}${seen.at ? ` (updated ${seen.at})` : ""}`}
              >
                {seen.move > 0 ? <TrendUp size={11} weight="bold" /> : <TrendDown size={11} weight="bold" />}
                {money(seen.move).slice(1)}
                {seen.at && <small>{seen.at.replace(/^\S+\s/, "")}</small>}
              </span>
            ) : null}
            {ipo.gmp !== null ? (
              <CountUp
                key={flash ? "flash" : "still"}
                value={ipo.gmp}
                from={flash && seen?.move ? ipo.gmp - seen.move : ipo.gmp}
                format={fmtInr2}
                className={`num big ${tone(ipo.gmp)} ${flash ? "flash" : ""}`}
              />
            ) : (
              <span className="small muted">No GMP yet</span>
            )}
          </span>
          {ipo.price ? (
            <span className="num small nowrap">
              <Agreement ipo={ipo} />
              <span className={tone(ipo.gmpPct)}>{pct(ipo.gmpPct)}</span>
              <span className="muted"> on {inr(ipo.price)}</span>
            </span>
          ) : (
            <span className="small muted">Price band TBA</span>
          )}
          {ipo.gmpDayChange && (
            <span
              className="num small nowrap day"
              title={`${money(ipo.gmpDayChange.from)} on ${ipo.gmpDayChange.since}, the last GMP logged before today`}
            >
              {ipo.gmpDayChange.change === 0 ? (
                <span className="muted">Flat</span>
              ) : (
                <span className={tone(ipo.gmpDayChange.change)}>
                  {ipo.gmpDayChange.change > 0 ? <TrendUp size={12} weight="bold" /> : <TrendDown size={12} weight="bold" />}
                  {money(ipo.gmpDayChange.change)}
                </span>
              )}
              <span className="muted"> vs {ipo.gmpDayChange.since}</span>
            </span>
          )}
        </div>
        <div className="r c-b" data-l="Profit / lot">
          {ipo.profitPerLot !== null ? (
            <>
              <span className={`num big ${tone(ipo.profitPerLot)}`}>{inr(ipo.profitPerLot)}</span>
              <span className="num small muted nowrap">
                {ipo.lot} sh, min {inr(ipo.minInvestment)}
              </span>
            </>
          ) : (
            <span className="small muted">{ipo.lot ? `${ipo.lot} sh a lot` : "Lot size TBA"}</span>
          )}
        </div>
        <div className="r c-a" data-l="Subscription">
          {s.total === null && s.qib === null ? (
            <span className="small muted">{ipo.status === "upcoming" ? `Bids open ${fmtDate(ipo.openDate)}` : "No data yet"}</span>
          ) : (
            <>
              <span className="num">
                {s.source === "NSE" && (
                  <span className="src-tag" title={`Official NSE data${s.updatedAt ? `, ${s.updatedAt}` : ""}`}>
                    NSE
                  </span>
                )}
                {x(s.total)}
              </span>
              <span className="num small muted nowrap" title="QIB, NII, Retail">
                Q {short(s.qib)} N {short(s.nii)} R {short(s.retail)}
              </span>
            </>
          )}
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
            <div className="detail">
              {f.flags.length > 0 && (
                <div className="flags all">
                  {f.flags.map((fl) => (
                    <FlagChip key={fl.text} flag={fl} />
                  ))}
                </div>
              )}

              <div className="cols">
                <Parts title="Listing score" parts={ipo.scoreParts} color={LISTING_COLOR} open={open} />
                <Parts
                  title="Fundamentals"
                  parts={f.parts}
                  color={FUND_COLOR}
                  open={open}
                  note={fd ? `Based on ${Math.round(f.coverage * 100)}% of the factors; the rest weren’t reported.` : undefined}
                />
              </div>

              {fd && fd.periods.length > 0 && (
                <div className="fin">
                  <h3>
                    Financials <span className="muted">(₹ crore, restated)</span>
                  </h3>
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
                        Listed peers (P/E): {fd.peers.map((p) => `${p.name} ${p.pe ?? NA}`).join(", ")}
                        {fd.peerMedianPe && `. Median ${fd.peerMedianPe.toFixed(1)}`}
                      </p>
                    )}
                  </div>
                )}
                <div>
                  <h3>Issue</h3>
                  <dl className="facts">
                    <div><dt>Sector</dt><dd>{fd?.sector ?? NA}</dd></div>
                    <div><dt>Issue size</dt><dd>{ipo.sizeCr ? `₹${ipo.sizeCr.toLocaleString("en-IN")} Cr` : NA}</dd></div>
                    <div><dt>Offer for sale</dt><dd>{fd?.ofsPct != null ? `${Math.round(fd.ofsPct)}% of issue` : NA}</dd></div>
                    <div><dt>Market cap</dt><dd>{fd?.marketCapCr ? `₹${crore(fd.marketCapCr)} Cr` : NA}</dd></div>
                    <div><dt>Promoter holding</dt><dd>{fd?.promoterPre != null ? `${fd.promoterPre}% to ${fd.promoterPost ?? NA}%` : NA}</dd></div>
                    <div><dt>Bidding</dt><dd>{fmtDate(ipo.openDate)} to {fmtDate(ipo.closeDate)}</dd></div>
                    <div><dt>Allotment</dt><dd>{fmtDate(ipo.allotmentDate)}</dd></div>
                    <div><dt>Listing</dt><dd>{fmtDate(ipo.listingDate)}</dd></div>
                    <div><dt>GMP range</dt><dd>{ipo.gmpLow !== null ? `${inr(ipo.gmpLow, 2)} to ${inr(ipo.gmpHigh, 2)}` : NA}</dd></div>
                    <div><dt>Retail allotment odds</dt><dd>{s.retail && s.retail > 1 ? `About 1 in ${Math.ceil(s.retail)}` : s.retail !== null ? "Very likely" : NA}</dd></div>
                    <div><dt>Subscription data</dt><dd>{s.source ? `${s.source}${s.updatedAt ? `, ${s.updatedAt}` : ""}` : NA}</dd></div>
                  </dl>
                  {ipo.gmpQuotes.length > 0 && (
                    <>
                      <h3 className="sub-h">GMP by source</h3>
                      <ul className="quotes">
                        {ipo.gmpQuotes.map((q) => (
                          <li key={q.source}>
                            <span>{q.source}</span>
                            <span className="num">{fmtInr2(q.gmp)}</span>
                            <span className="muted small">{q.updatedAt ?? ""}</span>
                          </li>
                        ))}
                      </ul>
                      <p className="pd">
                        {ipo.gmpAgreement === "differ"
                          ? `Sources disagree by ${money(Math.max(...ipo.gmpQuotes.map((q) => q.gmp)) - Math.min(...ipo.gmpQuotes.map((q) => q.gmp)))}. The dashboard uses the median, ${inr(ipo.gmp, 2)}.`
                          : ipo.gmpAgreement === "agree"
                            ? `Sources agree. The dashboard uses the median, ${inr(ipo.gmp, 2)}.`
                            : "Only one source quotes a GMP for this IPO so far."}
                      </p>
                    </>
                  )}
                  {ipo.gmpHistory.length > 0 && (
                    <>
                      <h3 className="sub-h">GMP history</h3>
                      <GmpSpark history={ipo.gmpHistory} />
                      <ol className="history">
                        {ipo.gmpHistory.slice(0, 8).map((h, i) => {
                          const older = ipo.gmpHistory[i + 1]?.gmp;
                          const d = h.gmp !== null && older != null ? h.gmp - older : null;
                          return (
                            <li key={h.at}>
                              <span className="muted">{h.at}</span>
                              <span className="num">{inr(h.gmp, 2)}</span>
                              <span className={`num ${d ? tone(d) : "muted"}`}>
                                {d === null ? "" : d === 0 ? "flat" : `${d > 0 ? "+" : "-"}${money(d)}`}
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
                  Full details on InvestorGain <ArrowSquareOut size={14} weight="bold" />
                </a>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

/** Small line chart of the GMP log, oldest to newest; the line draws itself in. */
function GmpSpark({ history }: { history: Ipo["gmpHistory"] }) {
  const pts = [...history].reverse().filter((h) => h.gmp !== null) as { at: string; gmp: number }[];
  if (pts.length < 2) return null;
  const W = 280;
  const H = 64;
  const P = 6;
  const vals = pts.map((p) => p.gmp);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = hi - lo || 1;
  const xy = pts.map((p, i) => [P + (i / (pts.length - 1)) * (W - 2 * P), H - P - ((p.gmp - lo) / span) * (H - 2 * P)]);
  const d = xy.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join(" ");
  const up = vals[vals.length - 1] >= vals[0];
  const color = up ? "var(--emerald)" : "var(--rose)";
  const last = xy[xy.length - 1];
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} role="img"
      aria-label={`GMP from ${fmtInr2(vals[0])} to ${fmtInr2(vals[vals.length - 1])}`}>
      <motion.path
        d={`${d} L${last[0].toFixed(1)},${H} L${xy[0][0].toFixed(1)},${H} Z`}
        fill={color}
        initial={{ opacity: 0 }}
        animate={{ opacity: 0.12 }}
        transition={{ duration: 0.8, delay: 0.5 }}
      />
      <motion.path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={2.2}
        strokeLinejoin="round"
        strokeLinecap="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 1, delay: 0.2, ease: EASE_OUT }}
      />
      <motion.circle
        cx={last[0]}
        cy={last[1]}
        r={3.5}
        fill={color}
        initial={{ scale: 0 }}
        animate={{ scale: 1 }}
        transition={{ ...SPRING, delay: 1.05 }}
      />
    </svg>
  );
}

/* ---------------------------------------------------------------------------------------------- */

function PastList({ ipos }: { ipos: Ipo[] }) {
  // Scale for the vs-GMP bars: the largest gap shown spans half the bar
  const maxGap = Math.max(10, ...ipos.map((i) => Math.abs(i.listing?.gapPts ?? 0)));
  return (
    <section className="list past">
      <div className="row head">
        <span>IPO</span>
        <span className="r">Issue price</span>
        <span className="r">Final GMP</span>
        <span className="r">Listed at</span>
        <span>vs GMP</span>
        <span className="r">Profit / lot</span>
        <span className="r">Subscribed</span>
      </div>
      {ipos.length === 0 && (
        <div className="empty">
          <p>No recently closed or listed mainboard IPOs. They show up here once bidding ends.</p>
        </div>
      )}
      {ipos.map((ipo, idx) => {
        const L = ipo.listing;
        const finalGmp = ipo.gmpAtListing ?? ipo.gmp;
        const gap = L?.gapPts ?? null;
        return (
          <motion.div
            className="row"
            key={ipo.id}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, delay: Math.min(idx, 12) * 0.035, ease: EASE_OUT }}
          >
            <div className="name">
              <a href={ipo.url ?? undefined} target="_blank" rel="noreferrer">
                {ipo.name}
              </a>
              <span className="meta">
                <span className={`chip s-${ipo.status}`}>{ipo.status === "listed" ? "Listed" : "Awaiting listing"}</span>
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
                {ipo.gmpAtClose !== null && `, ${inr(ipo.gmpAtClose, 2)} at close`}
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
            <div className="gap" data-l="vs GMP">
              {gap !== null ? (
                <>
                  <span className="gap-bar" aria-hidden>
                    <span className="gap-zero" />
                    <motion.span
                      className={`gap-fill ${gap >= 0 ? "up" : "down"} ${Math.abs(gap) <= 5 ? "inline" : ""}`}
                      // Grows out from the centre line: right for beat, left for missed
                      style={{
                        originX: gap >= 0 ? 0 : 1,
                        width: `${(Math.abs(gap) / maxGap) * 50}%`,
                        [gap >= 0 ? "left" : "right"]: "50%",
                      }}
                      initial={{ scaleX: 0 }}
                      animate={{ scaleX: 1 }}
                      transition={{ duration: 0.7, delay: 0.15 + Math.min(idx, 12) * 0.035, ease: EASE_OUT }}
                    />
                  </span>
                  <span className="gap-text">
                    <span className={`num ${Math.abs(gap) <= 5 ? "muted" : tone(gap)}`}>
                      {gap >= 0 ? "+" : ""}
                      {gap.toFixed(1)} pts
                    </span>
                    <span className="small muted">{Math.abs(gap) <= 5 ? "In line" : gap > 0 ? "Beat GMP" : "Below GMP"}</span>
                  </span>
                </>
              ) : (
                <span className="small muted">{NA}</span>
              )}
            </div>
            <div className="r" data-l="Profit / lot">
              <span className={`num ${tone(L?.profitPerLot ?? ipo.profitPerLot)}`}>{inr(L?.profitPerLot ?? ipo.profitPerLot)}</span>
              <span className="small muted">{L ? "Actual" : "Expected"}</span>
            </div>
            <div className="r" data-l="Subscribed">
              <span className="num">
                {ipo.subscription.source === "NSE" && <span className="src-tag" title="Official NSE data">NSE</span>}
                {x(ipo.subscription.total)}
              </span>
            </div>
          </motion.div>
        );
      })}
    </section>
  );
}

/** How well the final GMP predicted actual listings, across the recent ones shown. */
function GmpTrack({ ipos }: { ipos: Ipo[] }) {
  const done = ipos.filter((i) => i.listing?.expectedPct != null) as (Ipo & {
    listing: NonNullable<Ipo["listing"]> & { expectedPct: number; gapPts: number };
  })[];
  if (done.length < 3) {
    return (
      <p className="track-note">
        The GMP accuracy summary needs at least 3 recent listings; the feed has {done.length} right now. IPOs drop
        out of it about 10 days after listing.
      </p>
    );
  }

  const n = done.length;
  const above = ipos.filter((i) => i.listing && i.listing.gainPct > 0).length;
  const listedCount = ipos.filter((i) => i.listing).length;
  // "Direction": GMP of 1%+ means it called a gain; below that, a flat or negative listing
  const rightWay = done.filter((i) => (i.listing.expectedPct >= 1 ? i.listing.gainPct > 0 : i.listing.gainPct <= 1)).length;
  const gaps = done.map((i) => i.listing.gapPts);
  const meanGap = gaps.reduce((a, b) => a + b, 0) / n;
  const abs = gaps.map(Math.abs).sort((a, b) => a - b);
  const medianMiss = n % 2 ? abs[n >> 1] : (abs[n / 2 - 1] + abs[n / 2]) / 2;
  const inLine = gaps.filter((g) => Math.abs(g) <= 5).length;
  const biggest = [...done].sort((a, b) => Math.abs(b.listing.gapPts) - Math.abs(a.listing.gapPts))[0];

  const stats = [
    { label: "Called the direction", value: rightWay, of: n, note: "gain vs flat or loss", cls: "t-emerald" },
    { label: "Within 5 pts of GMP", value: inLine, of: n, note: `typical miss ±${medianMiss.toFixed(1)} pts`, cls: "t-saffron" },
    { label: "Listed above issue price", value: above, of: listedCount, note: `biggest miss: ${biggest.name} ${biggest.listing.gapPts >= 0 ? "+" : ""}${biggest.listing.gapPts.toFixed(0)} pts`, cls: "t-cyan" },
  ];

  return (
    <section className="track" aria-label="How accurate GMP has been">
      <div className="track-head">
        <h2>How accurate GMP has been</h2>
        <p className="muted">Final GMP vs actual listing, last {n} mainboard listings</p>
      </div>
      <dl className="track-stats">
        {stats.map((s, i) => (
          <motion.div
            key={s.label}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.05 + i * 0.07, ease: EASE_OUT }}
          >
            <dt>{s.label}</dt>
            <dd className="num">
              <CountUp value={s.value} format={fmtInt} className={s.cls} />
              <span className="of"> of {s.of}</span>
            </dd>
            <span className="muted">{s.note}</span>
          </motion.div>
        ))}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.26, ease: EASE_OUT }}
        >
          <dt>On average, listings were</dt>
          <dd className={`num ${tone(meanGap)}`}>
            {Math.abs(meanGap).toFixed(1)}
            <span className="of"> pts {meanGap >= 0 ? "above" : "below"}</span>
          </dd>
          <span className="muted">what GMP implied</span>
        </motion.div>
      </dl>
    </section>
  );
}

function Skeleton() {
  return (
    <div className="skeleton" aria-busy="true" aria-label="Loading IPO data">
      <div className="sk-picks">
        {[0, 1, 2].map((i) => (
          <div className="sk tile" key={i} />
        ))}
      </div>
      <div className="sk bar" />
      {[0, 1, 2, 3, 4].map((i) => (
        <div className="sk line" key={i} />
      ))}
    </div>
  );
}
