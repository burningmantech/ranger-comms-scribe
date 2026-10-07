/**
 * A JPEG of what's in the window right now, for the feedback tab. html2canvas redraws the page
 * from the DOM (keeping each panel's scroll position), so it needs no permission prompt; it is
 * loaded only when someone opens the tab. Elements marked `data-feedback-ignore` are left out.
 * Resolves to null if the page can't be drawn: feedback still goes without a screenshot.
 */

const MAX_WIDTH = 1600;
const MAX_DATA_URL = 4_500_000;
const TIMEOUT_MS = 10_000;

export async function captureScreenshot(): Promise<string | null> {
  try {
    const { default: html2canvas } = await import('html2canvas-pro');
    const scale = Math.min(window.devicePixelRatio || 1, 1.5, MAX_WIDTH / Math.max(window.innerWidth, 1));
    const render = html2canvas(document.body, {
      x: window.scrollX,
      y: window.scrollY,
      width: window.innerWidth,
      height: window.innerHeight,
      scale,
      useCORS: true,
      logging: false,
      backgroundColor: '#ffffff',
      imageTimeout: 4000,
      ignoreElements: (el: Element) => el.hasAttribute('data-feedback-ignore'),
    });
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), TIMEOUT_MS));
    const canvas = await Promise.race([render, timeout]);
    if (!canvas) return null;
    for (const quality of [0.75, 0.55, 0.4]) {
      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      if (dataUrl.length <= MAX_DATA_URL) return dataUrl;
    }
    return null;
  } catch (err) {
    console.warn('Feedback screenshot failed:', err);
    return null;
  }
}
