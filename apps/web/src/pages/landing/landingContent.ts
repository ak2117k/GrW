/**
 * Landing page marketing copy.
 *
 * ALL user-visible copy for the public landing page lives in this module so the
 * page component stays presentational and the copy stays testable.
 *
 * IP boundary (TDA-006/§7): this copy must never expose how signals are produced.
 * It is outcome-focused only — automated Intraday & Swing execution on the user's
 * own broker account, per-user risk sizing, opt-in auto-execution, and a kill
 * switch. See landingContent.spec.ts for the enforced forbidden-term guard.
 */

export interface LandingHero {
  title: string;
  subtitle: string;
  ctaPrimary: string;
  ctaSecondary: string;
}

export interface LandingValueProp {
  segment: 'Intraday' | 'Swing';
  title: string;
  body: string;
  bullets: string[];
}

export interface LandingPricingTier {
  name: 'Intraday' | 'Swing' | 'Both';
  priceLabel: string;
  bullets: string[];
}

export interface LandingContent {
  hero: LandingHero;
  valueProps: LandingValueProp[];
  howItWorks: string[];
  pricingTiers: LandingPricingTier[];
  disclaimer: string;
}

export const landingContent: LandingContent = {
  hero: {
    title: 'Automated trading on your own broker account',
    subtitle:
      'Receive trade signals for the segments you subscribe to, sized to your own risk limits, and let opt-in auto-execution place them on your broker account — with a kill switch you control at all times.',
    ctaPrimary: 'Get started',
    ctaSecondary: 'See how it works',
  },
  valueProps: [
    {
      segment: 'Intraday',
      title: 'Intraday, handled hands-free',
      body:
        'Same-day trades placed on your own broker account, sized to the per-user risk limits you set. Auto-execution is opt-in, and you can square off everything instantly whenever you want.',
      bullets: [
        'Signals for your subscribed segments, delivered in real time',
        'Per-user position sizing that respects your daily loss limit',
        'Opt-in auto-execution on your own broker account',
        'Instant kill switch to flatten all open positions',
      ],
    },
    {
      segment: 'Swing',
      title: 'Swing positions, managed for you',
      body:
        'Multi-day positions tracked and executed on your own broker account, with sizing tuned to your risk appetite and the same one-tap kill switch you rely on intraday.',
      bullets: [
        'Signals for your subscribed segments across multiple sessions',
        'Per-user risk sizing for multi-day holds',
        'Opt-in auto-execution you can pause anytime',
        'One-tap kill switch across every open position',
      ],
    },
  ],
  howItWorks: [
    'Connect your own broker account in a few secure steps.',
    'Subscribe to the segments you want — Intraday, Swing, or both.',
    'Set your risk limits: position size and a hard daily loss cap.',
    'Turn on opt-in auto-execution, or review each signal yourself first.',
    'Stay in control with a kill switch that flattens everything instantly.',
  ],
  pricingTiers: [
    {
      name: 'Intraday',
      priceLabel: 'Launch pricing — coming soon',
      bullets: [
        'Automated same-day execution on your broker account',
        'Per-user risk sizing and daily loss cap',
        'Opt-in auto-execution with instant kill switch',
      ],
    },
    {
      name: 'Swing',
      priceLabel: 'Launch pricing — coming soon',
      bullets: [
        'Automated multi-day execution on your broker account',
        'Per-user risk sizing for longer holds',
        'Opt-in auto-execution with instant kill switch',
      ],
    },
    {
      name: 'Both',
      priceLabel: 'Launch pricing — coming soon',
      bullets: [
        'Everything in Intraday and Swing, combined',
        'One unified view of all your automated positions',
        'Per-user risk limits and a single kill switch across both',
      ],
    },
  ],
  disclaimer:
    'Trading in financial markets carries risk, and past performance does not guarantee future results. You trade on your own broker account and remain responsible for your own decisions and risk limits. This is not investment advice.',
};
