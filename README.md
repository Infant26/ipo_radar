# IPO Radar

Live dashboard for Indian **mainboard** IPOs: current GMP, subscription (QIB / NII / Retail), and an
**Apply score** that ranks open and upcoming issues.

- `app/api/ipos/route.ts`: scrapes InvestorGain (GMP + subscription) and IPOWatch (second GMP opinion, fallback) on every request. Nothing is cached, so the **Refresh** button always pulls fresh numbers.
- `lib/score.ts`: apply score (0–100): listing gain from GMP 45%, QIB demand 20%, overall subscription vs. bidding progress 15%, GMP momentum 10%, buzz rating 10%. Missing data is excluded, not scored as zero.
- `vercel.json` pins the function to Mumbai (`bom1`), close to the source sites.

```bash
npm install
npm run dev
```

Deploy: `vercel --prod` (or import the repo on vercel.com). No env vars needed.

GMP is unofficial grey-market data. Scrapers can break if a source site changes its layout; the
source pills at the top of the dashboard show which feeds succeeded.
