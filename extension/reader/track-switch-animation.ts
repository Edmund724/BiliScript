const TRACK_SWITCH_CLASS = "is-track-switching";

export function playTrackSwitchAnimation(listEl: HTMLElement | null | undefined): void {
  if (!listEl) {
    return;
  }
  listEl.classList.remove(TRACK_SWITCH_CLASS);
  void listEl.offsetWidth;
  listEl.classList.add(TRACK_SWITCH_CLASS);
  listEl.addEventListener("animationend", () => listEl.classList.remove(TRACK_SWITCH_CLASS), { once: true });
}
