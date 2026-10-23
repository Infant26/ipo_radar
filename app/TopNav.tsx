"use client";

import Link from "next/link";
import { motion } from "motion/react";
import { SPRING } from "./ui";

const ITEMS = [
  { href: "/", key: "ipos", label: "IPOs" },
  { href: "/stocks", key: "stocks", label: "Stocks" },
] as const;

/** Page switcher shared by the IPO and Stocks pages; the pill slides between them. */
export default function TopNav({ active }: { active: "ipos" | "stocks" }) {
  return (
    <nav className="topnav seg" aria-label="Pages">
      {ITEMS.map((it) => {
        const on = it.key === active;
        return (
          <Link key={it.key} href={it.href} className={on ? "on" : ""} aria-current={on ? "page" : undefined}>
            {on && <motion.span layoutId="topnav-pill" className="seg-pill" transition={SPRING} />}
            <span className="seg-text">{it.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
