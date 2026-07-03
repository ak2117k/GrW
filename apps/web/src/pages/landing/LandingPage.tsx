import { Link } from 'react-router-dom';
import {
  ArrowRight,
  Check,
  ShieldCheck,
  Zap,
  TrendingUp,
  Lock,
  Activity,
} from 'lucide-react';
import { landingContent } from './landingContent';
import { MarketCanvas } from '@/components/landing/MarketCanvas';
import { ThemeToggle } from '@/components/common';

const SEGMENT_ICON = {
  Intraday: Zap,
  Swing: TrendingUp,
} as const;

/** Public index names only — no IP/provenance. Illustrative ticks for the tape. */
const TICKER = [
  { s: 'NIFTY 50', p: '22,412.90', d: '+0.58%', up: true },
  { s: 'BANKNIFTY', p: '48,201.35', d: '+0.74%', up: true },
  { s: 'FINNIFTY', p: '21,090.15', d: '-0.21%', up: false },
];

export default function LandingPage() {
  const { hero, valueProps, howItWorks, pricingTiers, disclaimer } =
    landingContent;

  return (
    <div className="min-h-screen overflow-x-hidden bg-[var(--color-bg-primary)] text-[var(--color-text-primary)]">
      {/* Top bar */}
      <header className="relative z-20 mx-auto flex max-w-6xl items-center justify-between px-4 py-5">
        <span className="text-2xl font-bold tracking-tight">
          Gr<span className="bg-gradient-to-r from-[var(--color-accent-blue)] to-[var(--color-accent-purple)] bg-clip-text text-transparent">W</span>
        </span>
        <nav className="flex items-center gap-4">
          <ThemeToggle />
          <Link
            to="/login"
            className="text-sm font-medium text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-primary)]"
          >
            Sign in
          </Link>
          <Link
            to="/signup"
            className="rounded-lg bg-gradient-to-r from-[var(--color-accent-blue)] to-[var(--color-accent-purple)] px-4 py-2 text-sm font-semibold text-white transition-all hover:opacity-90 active:scale-[0.98]"
          >
            Get started
          </Link>
        </nav>
      </header>

      {/* Hero — the living market */}
      <section className="relative overflow-hidden">
        <div className="glow glow-cyan animate-drift -left-32 -top-24 h-80 w-80" />
        <div className="glow glow-violet animate-drift -right-24 top-40 h-96 w-96" />

        <div className="relative z-10 mx-auto grid max-w-6xl items-center gap-12 px-4 py-16 lg:grid-cols-[1.05fr_1fr] lg:py-24">
          <div>
            <span className="inline-flex items-center gap-2 rounded-full border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)]/60 px-3 py-1 text-xs font-medium text-[var(--color-text-secondary)]">
              <Activity size={13} className="text-[var(--color-accent-blue)]" />
              Automated trading, engineered
            </span>
            <h1 className="mt-5 text-4xl font-bold leading-[1.1] tracking-tight sm:text-5xl">
              {hero.title}
            </h1>
            <p className="mt-6 max-w-xl text-lg text-[var(--color-text-secondary)]">
              {hero.subtitle}
            </p>
            <div className="mt-9 flex flex-col gap-3 sm:flex-row">
              <Link
                to="/signup"
                className="flex items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-[var(--color-accent-blue)] to-[var(--color-accent-purple)] px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-[var(--glow-violet)] transition-all hover:opacity-90 active:scale-[0.98]"
              >
                {hero.ctaPrimary}
                <ArrowRight size={16} />
              </Link>
              <a
                href="#how-it-works"
                className="flex items-center justify-center gap-2 rounded-lg border border-[var(--color-border-default)] px-6 py-3 text-sm font-semibold text-[var(--color-text-primary)] transition-all hover:border-[var(--color-accent-blue)]"
              >
                {hero.ctaSecondary}
              </a>
            </div>
            <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-[var(--color-text-muted)]">
              <span className="flex items-center gap-1.5"><ShieldCheck size={14} className="text-[var(--color-accent-green)]" /> Paper-trading by default</span>
              <span className="flex items-center gap-1.5"><Zap size={14} className="text-[var(--color-accent-yellow)]" /> Instant kill switch</span>
              <span className="flex items-center gap-1.5"><Lock size={14} className="text-[var(--color-accent-blue)]" /> Broker keys encrypted</span>
            </div>
          </div>

          {/* Live market panel */}
          <div className="glass rounded-2xl p-3 shadow-2xl">
            <div className="flex items-center justify-between px-2 pb-2">
              <span className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)]">
                <span className="h-2 w-2 animate-pulse-dot rounded-full bg-[var(--color-accent-green)]" />
                NIFTY 50 · live
              </span>
              <span className="font-mono-data text-xs text-[var(--color-accent-green)]">
                22,412.90 ▲ 0.58%
              </span>
            </div>
            <div className="h-64 w-full overflow-hidden rounded-lg sm:h-72">
              <MarketCanvas className="block h-full w-full" />
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2">
              {TICKER.map((t) => (
                <div
                  key={t.s}
                  className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)]/50 px-2.5 py-2"
                >
                  <div className="truncate text-[10px] text-[var(--color-text-muted)]">{t.s}</div>
                  <div className="font-mono-data text-xs text-[var(--color-text-primary)]">{t.p}</div>
                  <div className={`font-mono-data text-[10px] ${t.up ? 'text-[var(--color-accent-green)]' : 'text-[var(--color-accent-red)]'}`}>
                    {t.d}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Value props */}
      <section className="mx-auto max-w-6xl px-4 py-12">
        <div className="grid gap-6 md:grid-cols-2">
          {valueProps.map((prop) => {
            const Icon = SEGMENT_ICON[prop.segment];
            return (
              <div key={prop.segment} className="glass rounded-2xl p-6">
                <div className="flex items-center gap-3">
                  <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--color-accent-blue)]/12 text-[var(--color-accent-blue)]">
                    <Icon size={20} />
                  </span>
                  <h2 className="text-xl font-semibold">{prop.title}</h2>
                </div>
                <p className="mt-4 text-sm text-[var(--color-text-secondary)]">
                  {prop.body}
                </p>
                <ul className="mt-5 flex flex-col gap-2.5">
                  {prop.bullets.map((bullet) => (
                    <li key={bullet} className="flex items-start gap-2 text-sm text-[var(--color-text-primary)]">
                      <Check size={16} className="mt-0.5 shrink-0 text-[var(--color-accent-green)]" />
                      <span>{bullet}</span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </section>

      {/* How it works — a real sequence, so numbered */}
      <section id="how-it-works" className="mx-auto max-w-3xl px-4 py-16">
        <h2 className="text-center text-2xl font-bold tracking-tight">How it works</h2>
        <ol className="mt-8 flex flex-col gap-4">
          {howItWorks.map((step, i) => (
            <li key={step} className="glass flex items-start gap-4 rounded-xl px-5 py-4">
              <span className="font-mono-data flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[var(--color-accent-blue)] to-[var(--color-accent-purple)] text-sm font-bold text-white">
                {i + 1}
              </span>
              <span className="pt-0.5 text-sm text-[var(--color-text-primary)]">{step}</span>
            </li>
          ))}
        </ol>
      </section>

      {/* Pricing */}
      <section className="mx-auto max-w-6xl px-4 py-16">
        <h2 className="text-center text-2xl font-bold tracking-tight">Pricing</h2>
        <div className="mt-8 grid gap-6 md:grid-cols-3">
          {pricingTiers.map((tier, i) => (
            <div
              key={tier.name}
              className={`glass flex flex-col rounded-2xl p-6 ${i === 1 ? 'ring-1 ring-[var(--color-accent-blue)]/40' : ''}`}
            >
              <h3 className="text-lg font-semibold">{tier.name}</h3>
              <p className="font-mono-data mt-1 text-sm text-[var(--color-accent-blue)]">
                {tier.priceLabel}
              </p>
              <ul className="mt-5 flex flex-1 flex-col gap-2.5">
                {tier.bullets.map((bullet) => (
                  <li key={bullet} className="flex items-start gap-2 text-sm text-[var(--color-text-primary)]">
                    <Check size={16} className="mt-0.5 shrink-0 text-[var(--color-accent-green)]" />
                    <span>{bullet}</span>
                  </li>
                ))}
              </ul>
              <Link
                to="/signup"
                className="mt-6 flex items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-[var(--color-accent-blue)] to-[var(--color-accent-purple)] px-4 py-2.5 text-sm font-semibold text-white transition-all hover:opacity-90 active:scale-[0.98]"
              >
                Get started
              </Link>
            </div>
          ))}
        </div>
      </section>

      {/* Disclaimer */}
      <section className="mx-auto max-w-3xl px-4 pb-12">
        <div className="glass flex items-start gap-3 rounded-xl px-5 py-4">
          <ShieldCheck size={18} className="mt-0.5 shrink-0 text-[var(--color-text-muted)]" />
          <p className="text-xs leading-relaxed text-[var(--color-text-muted)]">{disclaimer}</p>
        </div>
      </section>

      {/* Footer CTA */}
      <footer className="border-t border-[var(--color-border-subtle)]">
        <div className="mx-auto flex max-w-3xl flex-col items-center gap-5 px-4 py-16 text-center">
          <h2 className="text-2xl font-bold tracking-tight">Ready to trade hands-free?</h2>
          <Link
            to="/signup"
            className="flex items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-[var(--color-accent-blue)] to-[var(--color-accent-purple)] px-6 py-3 text-sm font-semibold text-white transition-all hover:opacity-90 active:scale-[0.98]"
          >
            {hero.ctaPrimary}
            <ArrowRight size={16} />
          </Link>
          <Link
            to="/login"
            className="text-sm text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-primary)]"
          >
            Already have an account? Sign in
          </Link>
        </div>
      </footer>
    </div>
  );
}
