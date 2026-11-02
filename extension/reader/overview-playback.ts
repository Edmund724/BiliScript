import { ids } from "./state.js";

export function syncReadingOverviewActiveChapter(currentTime: unknown): void {
  const body = document.getElementById(ids.readingOverviewBody);
  if (!body) return;
  const seconds = Number(currentTime);
  const time = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const cards = Array.from(body.querySelectorAll<HTMLElement>(".biliscript-reading-ov-chapter"));
  let next: HTMLElement | null = null;

  for (const card of cards) {
    const from = Number(card.dataset.seconds) || 0;
    const to = Number(card.dataset.to) || 0;
    if (time < from) break;
    if (to > from && time >= to) continue;
    next = card;
    break;
  }

  const current = body.querySelector<HTMLElement>(".biliscript-reading-ov-chapter.is-active");
  if (current === next) return;
  current?.classList.remove("is-active");
  current?.removeAttribute("aria-current");
  if (next) {
    next.classList.add("is-active");
    next.setAttribute("aria-current", "true");
  }
}
