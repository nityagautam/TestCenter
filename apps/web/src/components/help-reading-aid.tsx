"use client";

import { useEffect, useState } from "react";

/**
 * Reading aids for `/help` — a margin table of contents that tracks the section being read,
 * and a back-to-top control.
 *
 * WHY THIS IS AN ENHANCEMENT AND NOT THE NAVIGATION
 *
 * The contents card inside the article is server-rendered and stays there. This component adds
 * a second, persistent copy in the margin and marks the reader's position in it; if the bundle
 * never arrives, the page loses a convenience rather than its navigation. That constraint comes
 * from what `/help` is for: it renders unauthenticated, goes in an invitation mail, and is the
 * page someone opens *because* the app is behaving badly. A table of contents that needs
 * JavaScript to be clickable is the wrong trade here, so every link below is a real anchor and
 * the client only decides which one is emphasised.
 *
 * WHY A SCROLL HANDLER RATHER THAN IntersectionObserver
 *
 * The obvious tool is the wrong shape. An observer reports "is this section in view", and with
 * five sections taller than the viewport several are in view at once, so the answer has to be
 * re-derived from the entries anyway. Worse, the last act is short: scrolled to the very bottom
 * of the document it may never cross whatever threshold was chosen, and the marker sticks on
 * act four while the reader is plainly in act five. Measuring tops against one reading line
 * answers the actual question — "which heading did I last pass" — and the document-end case
 * becomes an explicit branch instead of a threshold that cannot be tuned to cover it.
 */

/**
 * The line, in px from the top of the viewport, that decides which section is being read.
 *
 * Matches `.tc-help-anchor { scroll-margin-top: 7rem }` plus a little: when a reader clicks a
 * contents link, the heading lands at 7rem, and the section they just asked for must be the one
 * marked. A reading line above where anchors land would credit the *previous* section for the
 * jump the reader just made, which looks broken precisely when they are watching for it.
 */
const READING_LINE_PX = 128;

/** Far enough that the control is offering something — roughly one screen of scrolling. */
const BACK_TO_TOP_AFTER_PX = 600;

export function HelpReadingAid({
  sections,
}: {
  sections: { id: string; title: string; number?: number }[];
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    /*
     * Smooth scrolling set here rather than in the stylesheet, so it applies to this page and
     * only while this component is mounted. Global `html { scroll-behavior: smooth }` would also
     * animate the skip link, and a skip link that takes 400ms to arrive defeats its purpose for
     * the keyboard user it exists for. The `prefers-reduced-motion` block in `globals.css`
     * carries `scroll-behavior: auto !important`, so this cannot override that preference.
     */
    const root = document.documentElement;
    const previousBehavior = root.style.scrollBehavior;
    root.style.scrollBehavior = "smooth";

    let frame = 0;

    const measure = (): void => {
      frame = 0;
      setScrolled(window.scrollY > BACK_TO_TOP_AFTER_PX);

      /*
       * At the end of the document the last section wins outright. Without this the marker
       * stalls on the second-to-last act whenever the final one is shorter than the viewport,
       * which is the common case for a closing section.
       */
      const atEnd =
        window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
      if (atEnd) {
        setActiveId(sections[sections.length - 1]?.id ?? null);
        return;
      }

      // The last heading whose top has passed the reading line. Null above the first one, which
      // is correct: the introduction belongs to no act and should not light one up.
      let current: string | null = null;
      for (const section of sections) {
        const element = document.getElementById(section.id);
        if (element && element.getBoundingClientRect().top <= READING_LINE_PX) current = section.id;
      }
      setActiveId(current);
    };

    /*
     * Coalesced to one measurement per frame. Scroll fires far more often than that, and each
     * pass reads five `getBoundingClientRect`s — cheap individually, a forced layout per event
     * if left unthrottled. `passive` because nothing here calls `preventDefault`, which lets the
     * browser keep scrolling off the main thread.
     */
    const schedule = (): void => {
      if (!frame) frame = window.requestAnimationFrame(measure);
    };

    measure();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame) window.cancelAnimationFrame(frame);
      root.style.scrollBehavior = previousBehavior;
    };
  }, [sections]);

  return (
    <>
      {/*
       * Fixed in the left margin rather than placed in a grid column, so the article keeps the
       * exact measure it was designed at. Turning the page into `[sidebar | prose]` would shift
       * the reading column off-centre and narrow it, and line length is the one typographic
       * decision a long explanatory page cannot afford to get wrong.
       *
       * `left` is derived from the centre: half the 48rem column is 24rem, and 14rem covers this
       * rail plus its gap. The `max()` keeps it off the viewport edge on the narrowest screen
       * that still shows it. Hidden below `xl`, where there is no margin to put it in — the
       * in-article contents card is the table of contents at those widths.
       */}
      <aside
        aria-label="On this page"
        className="fixed top-20 left-[max(1.5rem,calc(50%-38rem))] z-20 hidden max-h-[calc(100vh-7rem)] w-48 overflow-y-auto xl:block"
      >
        <p className="mb-2 text-[10px] font-medium tracking-wide text-[var(--color-ink-muted)] uppercase">
          On this page
        </p>
        <ol>
          {sections.map((section, index) => {
            const active = section.id === activeId;
            /* The first reference section opens a new group; the rule says so once. */
            const startsReference =
              section.number === undefined && sections[index - 1]?.number !== undefined;
            return (
              <li
                key={section.id}
                className={
                  startsReference ? "mt-2 border-t border-[var(--color-border-subtle)] pt-2" : ""
                }
              >
                <a
                  href={`#${section.id}`}
                  /*
                   * `aria-current` is the actual answer for a screen reader; the border and the
                   * weight are the sighted equivalent. Three signals for one fact, none of them
                   * colour on its own — the same reason the status badges pair a hue with a
                   * glyph. A reader who cannot separate the rail's blue from the surface still
                   * sees a heavier line of text with a rule beside it.
                   */
                  aria-current={active ? "true" : undefined}
                  className={`flex items-baseline gap-2.5 border-l-2 py-1.5 pl-3 text-[11px] leading-snug transition-colors ${
                    active
                      ? "border-[var(--color-series-1)] font-medium text-[var(--color-ink)]"
                      : "border-[var(--color-border-subtle)] text-[var(--color-ink-muted)] hover:border-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
                  }`}
                >
                  {/* Same middot stand-in as the contents card, for the same reason: the
                      column is what aligns the titles. */}
                  <span
                    className="w-2 shrink-0 font-mono text-[10px] tabular-nums"
                    aria-hidden={section.number === undefined}
                  >
                    {section.number ?? "·"}
                  </span>
                  <span className="min-w-0">{section.title}</span>
                </a>
              </li>
            );
          })}
        </ol>
      </aside>

      {/*
       * `href="#top"` rather than a button calling `scrollTo`. HTML defines `top` as the
       * beginning of the document when no element has that id, so this works as a plain link —
       * middle-clickable, focusable, and functional in the fraction of a second before
       * hydration. The smooth animation comes from the `scroll-behavior` set above, so the two
       * behaviours cannot drift apart.
       *
       * Removed from the tab order while hidden. A transparent control that still takes focus is
       * a keyboard trap you cannot see, which is worse than not offering it at all.
       */}
      <a
        href="#top"
        aria-hidden={!scrolled}
        tabIndex={scrolled ? 0 : -1}
        className={`fixed right-4 bottom-4 z-40 flex items-center gap-1.5 rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-2 text-[11px] shadow-sm transition-opacity hover:border-[var(--color-ink-muted)] ${
          scrolled ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      >
        <span aria-hidden>↑</span>
        <span>Top</span>
      </a>
    </>
  );
}
