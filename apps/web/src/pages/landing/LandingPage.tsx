import { Link } from 'react-router-dom';
import {
  ArrowRight,
  Check,
  ShieldCheck,
  Zap,
  TrendingUp,
} from 'lucide-react';
import { landingContent } from './landingContent';

const SEGMENT_ICON = {
  Intraday: Zap,
  Swing: TrendingUp,
} as const;

export default function LandingPage() {
  const { hero, valueProps, howItWorks, pricingTiers, disclaimer } =
    landingContent;

  return (
    <div className="min-h-screen bg-[var(--color-bg-primary)] text-[var(--color-text-primary)]">
      {/* Top bar */}
      <header className="mx-auto flex max-w-6xl items-center justify-between px-4 py-5">
        <span className="text-2xl font-bold tracking-tight">
          TD<span className="text-[var(--color-accent-blue)]">Auto</span>
        </span>
        <nav className="flex items-center gap-4">
          <Link
            to="/login"
            className="text-sm font-medium text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-primary)]"
          >
            Sign in
          </Link>
          <Link
            to="/signup"
            className="rounded-lg bg-[var(--color-accent-blue)] px-4 py-2 text-sm font-semibold text-white transition-all hover:opacity-90 active:scale-[0.98]"
          >
            Get started
          </Link>
        </nav>
      </header>

      {/* Hero */}
      <section className="mx-auto max-w-3xl px-4 py-20 text-center">
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
          {hero.title}
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-[var(--color-text-muted)]">
          {hero.subtitle}
        </p>
        <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link
            to="/signup"
            className="flex items-center justify-center gap-2 rounded-lg bg-[var(--color-accent-blue)] px-6 py-3 text-sm font-semibold text-white transition-all hover:opacity-90 active:scale-[0.98]"
          >
            {hero.ctaPrimary}
            <ArrowRight size={16} />
          </Link>
          <a
            href="#how-it-works"
            className="flex items-center justify-center gap-2 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] px-6 py-3 text-sm font-semibold text-[var(--color-text-primary)] transition-all hover:border-[var(--color-accent-blue)]"
          >
            {hero.ctaSecondary}
          </a>
        </div>
      </section>

      {/* Value props */}
      <section className="mx-auto max-w-6xl px-4 py-12">
        <div className="grid gap-6 md:grid-cols-2">
          {valueProps.map((prop) => {
            const Icon = SEGMENT_ICON[prop.segment];
            return (
              <div
                key={prop.segment}
                className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-6 shadow-xl"
              >
                <div className="flex items-center gap-3">
                  <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--color-accent-blue)]/10 text-[var(--color-accent-blue)]">
                    <Icon size={20} />
                  </span>
                  <h2 className="text-xl font-semibold">{prop.title}</h2>
                </div>
                <p className="mt-4 text-sm text-[var(--color-text-muted)]">
                  {prop.body}
                </p>
                <ul className="mt-5 flex flex-col gap-2.5">
                  {prop.bullets.map((bullet) => (
                    <li
                      key={bullet}
                      className="flex items-start gap-2 text-sm text-[var(--color-text-primary)]"
                    >
                      <Check
                        size={16}
                        className="mt-0.5 shrink-0 text-[var(--color-accent-blue)]"
                      />
                      <span>{bullet}</span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </section>

      {/* How it works */}
      <section id="how-it-works" className="mx-auto max-w-3xl px-4 py-16">
        <h2 className="text-center text-2xl font-bold tracking-tight">
          How it works
        </h2>
        <ol className="mt-8 flex flex-col gap-4">
          {howItWorks.map((step, i) => (
            <li
              key={step}
              className="flex items-start gap-4 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] px-5 py-4"
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--color-accent-blue)] text-sm font-bold text-white">
                {i + 1}
              </span>
              <span className="text-sm text-[var(--color-text-primary)]">
                {step}
              </span>
            </li>
          ))}
        </ol>
      </section>

      {/* Pricing teaser */}
      <section className="mx-auto max-w-6xl px-4 py-16">
        <h2 className="text-center text-2xl font-bold tracking-tight">
          Pricing
        </h2>
        <div className="mt-8 grid gap-6 md:grid-cols-3">
          {pricingTiers.map((tier) => (
            <div
              key={tier.name}
              className="flex flex-col rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-6 shadow-xl"
            >
              <h3 className="text-lg font-semibold">{tier.name}</h3>
              <p className="mt-1 text-sm text-[var(--color-text-muted)]">
                {tier.priceLabel}
              </p>
              <ul className="mt-5 flex flex-1 flex-col gap-2.5">
                {tier.bullets.map((bullet) => (
                  <li
                    key={bullet}
                    className="flex items-start gap-2 text-sm text-[var(--color-text-primary)]"
                  >
                    <Check
                      size={16}
                      className="mt-0.5 shrink-0 text-[var(--color-accent-blue)]"
                    />
                    <span>{bullet}</span>
                  </li>
                ))}
              </ul>
              <Link
                to="/signup"
                className="mt-6 flex items-center justify-center gap-2 rounded-lg bg-[var(--color-accent-blue)] px-4 py-2.5 text-sm font-semibold text-white transition-all hover:opacity-90 active:scale-[0.98]"
              >
                Get started
              </Link>
            </div>
          ))}
        </div>
      </section>

      {/* Disclaimer */}
      <section className="mx-auto max-w-3xl px-4 pb-12">
        <div className="flex items-start gap-3 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] px-5 py-4">
          <ShieldCheck
            size={18}
            className="mt-0.5 shrink-0 text-[var(--color-text-muted)]"
          />
          <p className="text-xs leading-relaxed text-[var(--color-text-muted)]">
            {disclaimer}
          </p>
        </div>
      </section>

      {/* Footer CTA */}
      <footer className="border-t border-[var(--color-border-subtle)]">
        <div className="mx-auto flex max-w-3xl flex-col items-center gap-5 px-4 py-16 text-center">
          <h2 className="text-2xl font-bold tracking-tight">
            Ready to trade hands-free?
          </h2>
          <Link
            to="/signup"
            className="flex items-center justify-center gap-2 rounded-lg bg-[var(--color-accent-blue)] px-6 py-3 text-sm font-semibold text-white transition-all hover:opacity-90 active:scale-[0.98]"
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
