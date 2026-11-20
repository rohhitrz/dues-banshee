import type { Metadata } from "next";
import { LADDER_STEPS, formatINR } from "@dues-banshee/engine";
import {
  CA_COPY,
  CREW_COPY,
  HERO,
  KIROWEEN_LINE,
  LADDER_APPROVAL,
  LADDER_COPY,
  ROADMAP_ITEMS,
  TAX_BOMB_COPY,
} from "@/lib/landing/copy";
import { PLANS, PRICING_HEADING, PRICING_LABEL, PROBLEM_SIZE } from "@/lib/landing/pricing";
import { sharmaExample } from "@/lib/landing/sharma-example";
import styles from "./landing.module.css";

export const metadata: Metadata = {
  title: "Dues Banshee — They forgot your invoice. The taxman won't.",
  description:
    "AI collections for Udyam micro and small suppliers: reminders, legal notices and tax-bomb countdowns.",
};

export default function LandingPage() {
  const sharma = sharmaExample();
  return (
    <main className={styles.page}>
      <section aria-label="Hero" className={`${styles.section} ${styles.hero}`}>
        <div className={styles.fog} aria-hidden="true" />
        <div className={styles.candle} aria-hidden="true" />
        <h1 className={styles.heroTitle}>{HERO.title}</h1>
        <p className={styles.heroSub}>{HERO.subline}</p>
        <a className={styles.cta} href={HERO.cta.href}>
          {HERO.cta.label}
        </a>
      </section>

      <section aria-label="Ladder" className={`${styles.section} ${styles.sectionAlt}`}>
        <p className={styles.eyebrow}>The ladder</p>
        <h2 className={styles.heading}>Five steps, from a nudge to a notice</h2>
        <ol className={styles.ladderList}>
          {LADDER_STEPS.map((step, index) => {
            const copy = LADDER_COPY[step];
            return (
              <li key={step} className={styles.ladderItem}>
                <span className={styles.ladderIndex} aria-hidden="true">
                  {index + 1}
                </span>
                <span className={styles.ladderName}>{copy.name}</span>
                <span className={styles.ladderLine}>{copy.line}</span>
              </li>
            );
          })}
        </ol>
        <p className={styles.approval}>{LADDER_APPROVAL}</p>
      </section>

      <section aria-label="Tax bomb" className={styles.section}>
        <p className={styles.eyebrow}>The tax bomb</p>
        <h2 className={styles.heading}>The 31 March deadline works for you</h2>
        <div className={styles.bombCard}>
          <p className={styles.bombLabel}>
            {sharma.buyerName}: deduction at risk as of {sharma.exampleDateText}
          </p>
          <p className={styles.bombFigure}>{sharma.deductionAtRiskText}</p>
          <p className={styles.bombMeta}>{sharma.daysLeft} days left until 31 March</p>
        </div>
        <p className={styles.lede}>
          {TAX_BOMB_COPY.rule} <span className={styles.ruleTag}>{TAX_BOMB_COPY.ruleId}</span>
        </p>
        <p className={styles.ruleNote}>{TAX_BOMB_COPY.ruleSource}</p>
        <p className={styles.lede}>
          {TAX_BOMB_COPY.interest} <span className={styles.ruleTag}>{TAX_BOMB_COPY.interestRuleId}</span>
        </p>
      </section>

      <section aria-label="Problem size" className={`${styles.section} ${styles.sectionAlt}`}>
        <p className={styles.eyebrow}>The problem</p>
        <h2 className={styles.heading}>Delayed MSME payments</h2>
        <p className={styles.statFigure}>{PROBLEM_SIZE.figure}</p>
        <p className={styles.plainText}>of MSME payments are delayed.</p>
        <p className={styles.statSource}>Source: {PROBLEM_SIZE.source}</p>
      </section>

      <section aria-label="CA firms" className={styles.section}>
        <p className={styles.eyebrow}>For CA firms</p>
        <h2 className={styles.heading}>One dashboard for every client</h2>
        <p className={styles.plainText}>{CA_COPY}</p>
      </section>

      <section aria-label="Pricing" className={`${styles.section} ${styles.sectionAlt}`}>
        <p className={styles.eyebrow}>{PRICING_LABEL}</p>
        <h2 className={styles.heading}>{PRICING_HEADING}</h2>
        <div className={styles.pricingGrid}>
          {PLANS.map((plan) => (
            <article key={plan.id} className={styles.planCard}>
              <h3 className={styles.planName}>{plan.name}</h3>
              {plan.prices.length > 0 ? (
                <div className={styles.planPrices}>
                  {plan.prices.map((price) => (
                    <p key={price.suffix} className={styles.planPrice}>
                      {formatINR(price.paise, "full")}
                      <span className={styles.planSuffix}>{price.suffix}</span>
                    </p>
                  ))}
                </div>
              ) : null}
              {plan.note === null ? null : <p className={styles.planNote}>{plan.note}</p>}
              <ul className={styles.planFeatures}>
                {plan.features.map((feature) => (
                  <li key={feature}>{feature}</li>
                ))}
              </ul>
              {plan.cta === null ? null : (
                <a
                  className={styles.planCta}
                  href={plan.cta.href}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {plan.cta.label}
                </a>
              )}
            </article>
          ))}
        </div>
      </section>

      <section aria-label="Roadmap" className={styles.section}>
        <p className={styles.eyebrow}>Roadmap</p>
        <h2 className={styles.heading}>What comes next</h2>
        <ul className={styles.roadmapList}>
          {ROADMAP_ITEMS.map((item) => (
            <li key={item} className={styles.roadmapItem}>
              {item}
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="Built with Kiro" className={`${styles.section} ${styles.sectionAlt}`}>
        <p className={styles.eyebrow}>Built with Kiro</p>
        <h2 className={styles.heading}>A crew that works the ladder every morning</h2>
        <p className={styles.plainText}>{CREW_COPY.text}</p>
        <a
          className={`${styles.crewLink} ${styles.link}`}
          href={CREW_COPY.href}
          target="_blank"
          rel="noopener noreferrer"
        >
          {CREW_COPY.linkLabel}
        </a>
      </section>

      <footer aria-label="Footer" className={styles.footer}>
        <p className={styles.footerLine}>{KIROWEEN_LINE}</p>
      </footer>
    </main>
  );
}
