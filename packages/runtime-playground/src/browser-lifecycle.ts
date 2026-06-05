import type { Page } from "playwright"
import type { BrowserProbeLifecycleArtifact, BrowserProbeLifecycleSummary } from "./browser-artifacts.js"

export function browserProbeLifecycleInitScript(selectors: string[]): string {
  return `
(() => {
  const selectors = ${JSON.stringify(selectors)};
  const state = globalThis.__wpCodeboxBrowserProbe = globalThis.__wpCodeboxBrowserProbe || { checkpoints: [], longTasks: [] };
  if (!Array.isArray(selectors) || selectors.length === 0 || state.lifecycleObserverInstalled) {
    return;
  }

  const now = () => {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now();
    }
    return Date.now();
  };

  const lifecycle = state.lifecycle = state.lifecycle || {
    schema: 'wp-codebox/browser-lifecycle/v1',
    version: 1,
    startedAtMs: now(),
    selectors: {},
  };

  const selectorStates = new Map();
  for (const selector of selectors) {
    const key = String(selector || '').trim();
    if (!key || selectorStates.has(key)) {
      continue;
    }
    const metrics = lifecycle.selectors[key] = lifecycle.selectors[key] || {
      selector: key,
      first_seen_ms: null,
      first_visible_ms: null,
      first_child_ms: null,
      first_iframe_ms: null,
      first_visible_iframe_ms: null,
      first_button_ms: null,
      first_visible_button_ms: null,
      stable_visible_ms: null,
      removed_count: 0,
      peak_child_count: 0,
      peak_iframe_count: 0,
      peak_visible_iframe_count: 0,
      peak_button_count: 0,
      peak_visible_button_count: 0,
      final_child_count: 0,
      final_iframe_count: 0,
      final_visible_iframe_count: 0,
      final_button_count: 0,
      final_visible_button_count: 0,
    };
    selectorStates.set(key, { metrics, elements: new Set(), visibleSinceMs: null, stableTimer: null });
  }

  const visibleStableDelayMs = 250;
  const buttonSelector = 'button, input[type="button"], input[type="submit"], input[type="reset"], [role="button"]';

  function elapsedMs() {
    return Math.max(0, Math.round(now() - lifecycle.startedAtMs));
  }

  function isVisible(element) {
    if (!element || typeof element.getClientRects !== 'function') {
      return false;
    }
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(element) : null;
    if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) {
      return false;
    }
    return element.getClientRects().length > 0;
  }

  function descendants(element, selector) {
    if (!element || typeof element.querySelectorAll !== 'function') {
      return [];
    }
    try {
      return Array.from(element.querySelectorAll(selector));
    } catch {
      return [];
    }
  }

  function updateFirst(metrics, field, count, sampleMs) {
    if (count > 0 && metrics[field] === null) {
      metrics[field] = sampleMs;
    }
  }

  function sampleSelector(selector, tracked) {
    const metrics = tracked.metrics;
    const sampleMs = elapsedMs();
    let elements = [];
    try {
      elements = Array.from(document.querySelectorAll(selector));
    } catch {
      elements = [];
    }

    for (const element of tracked.elements) {
      if (!elements.includes(element)) {
        metrics.removed_count += 1;
      }
    }
    tracked.elements = new Set(elements);

    const visibleElements = elements.filter(isVisible);
    const childCount = elements.reduce((total, element) => total + (element.children ? element.children.length : 0), 0);
    const iframes = elements.flatMap((element) => descendants(element, 'iframe'));
    const buttons = elements.flatMap((element) => descendants(element, buttonSelector));
    const visibleIframeCount = iframes.filter(isVisible).length;
    const visibleButtonCount = buttons.filter(isVisible).length;

    updateFirst(metrics, 'first_seen_ms', elements.length, sampleMs);
    updateFirst(metrics, 'first_visible_ms', visibleElements.length, sampleMs);
    updateFirst(metrics, 'first_child_ms', childCount, sampleMs);
    updateFirst(metrics, 'first_iframe_ms', iframes.length, sampleMs);
    updateFirst(metrics, 'first_visible_iframe_ms', visibleIframeCount, sampleMs);
    updateFirst(metrics, 'first_button_ms', buttons.length, sampleMs);
    updateFirst(metrics, 'first_visible_button_ms', visibleButtonCount, sampleMs);

    metrics.peak_child_count = Math.max(metrics.peak_child_count, childCount);
    metrics.peak_iframe_count = Math.max(metrics.peak_iframe_count, iframes.length);
    metrics.peak_visible_iframe_count = Math.max(metrics.peak_visible_iframe_count, visibleIframeCount);
    metrics.peak_button_count = Math.max(metrics.peak_button_count, buttons.length);
    metrics.peak_visible_button_count = Math.max(metrics.peak_visible_button_count, visibleButtonCount);
    metrics.final_child_count = childCount;
    metrics.final_iframe_count = iframes.length;
    metrics.final_visible_iframe_count = visibleIframeCount;
    metrics.final_button_count = buttons.length;
    metrics.final_visible_button_count = visibleButtonCount;

    if (visibleElements.length > 0) {
      if (tracked.visibleSinceMs === null) {
        tracked.visibleSinceMs = sampleMs;
      }
      if (metrics.stable_visible_ms === null && tracked.stableTimer === null) {
        tracked.stableTimer = setTimeout(() => {
          tracked.stableTimer = null;
          sampleSelector(selector, tracked);
          if (tracked.visibleSinceMs !== null && tracked.metrics.stable_visible_ms === null) {
            tracked.metrics.stable_visible_ms = tracked.visibleSinceMs;
          }
        }, visibleStableDelayMs);
      }
    } else {
      tracked.visibleSinceMs = null;
      if (tracked.stableTimer !== null) {
        clearTimeout(tracked.stableTimer);
        tracked.stableTimer = null;
      }
    }
  }

  function sampleAll() {
    for (const [selector, tracked] of selectorStates) {
      sampleSelector(selector, tracked);
    }
  }

  function installRootObserver() {
    sampleAll();
    if (typeof MutationObserver === 'undefined' || !document.documentElement) {
      return false;
    }
    const observer = new MutationObserver(sampleAll);
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'] });
    state.lifecycleObserverInstalled = true;
    return true;
  }

  if (!installRootObserver()) {
    if (typeof MutationObserver !== 'undefined') {
      const documentObserver = new MutationObserver(() => {
        if (document.documentElement && installRootObserver()) {
          documentObserver.disconnect();
        }
      });
      documentObserver.observe(document, { childList: true });
    }
    if (typeof document.addEventListener === 'function') {
      document.addEventListener('DOMContentLoaded', installRootObserver, { once: true });
    }
    const interval = setInterval(() => {
      if (document.documentElement && installRootObserver()) {
        clearInterval(interval);
      }
    }, 25);
  }

  state.collectLifecycle = () => {
    sampleAll();
    return lifecycle;
  };
})();
`
}

export async function collectBrowserProbeLifecycle(page: Page): Promise<BrowserProbeLifecycleSummary | undefined> {
  const lifecycle = await page.evaluate(() => {
    const state = (globalThis as typeof globalThis & { __wpCodeboxBrowserProbe?: { collectLifecycle?: () => unknown; lifecycle?: unknown } }).__wpCodeboxBrowserProbe
    if (typeof state?.collectLifecycle === "function") {
      return state.collectLifecycle()
    }
    return state?.lifecycle
  })

  if (!isLifecycleSummary(lifecycle) || Object.keys(lifecycle.selectors).length === 0) {
    return undefined
  }

  return lifecycle
}

export function browserProbeLifecycleArtifact(lifecycle: BrowserProbeLifecycleSummary): BrowserProbeLifecycleArtifact {
  return {
    schema: "wp-codebox/browser-lifecycle/v1",
    version: 1,
    capturedAt: new Date().toISOString(),
    startedAtMs: lifecycle.startedAtMs,
    selectors: lifecycle.selectors,
  }
}

function isLifecycleSummary(value: unknown): value is BrowserProbeLifecycleSummary {
  return typeof value === "object" && value !== null && !Array.isArray(value) && (value as { schema?: unknown }).schema === "wp-codebox/browser-lifecycle/v1" && typeof (value as { selectors?: unknown }).selectors === "object" && (value as { selectors?: unknown }).selectors !== null
}
