export function getFullscreenHost(): HTMLElement | null {
  const fullscreenElement =
    document.fullscreenElement ||
    (document as unknown as { webkitFullscreenElement?: Element }).webkitFullscreenElement;
  return fullscreenElement instanceof HTMLElement ? fullscreenElement : null;
}
