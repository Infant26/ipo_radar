import type { Metadata } from "next";
import StocksDashboard from "./StocksDashboard";

export const metadata: Metadata = {
  title: "Stocks | IPO Radar",
  description: "NSE stocks ranked by 1 to 5 year returns, with long-term and short-term scores",
};

export default function Page() {
  return <StocksDashboard />;
}
