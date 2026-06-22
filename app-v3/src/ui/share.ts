import type { Headline } from '../domain/headline';
import { shareFlexLabel } from '../domain/flexSource';
import type { ComparisonRun } from '../types/result';
import { el } from './dom';
import { fmtDate } from './format';
import { LOGO_PATHS } from './icons';

// --- structured claims (pure, testable) -------------------------------------

export interface ShareClaims {
  period: string;
  // Flexible vs Agile on the user's own usage (both as estimates).
  estimate: { cheaper: string; dearer: string; pct: number } | null;
  // The alternative tariff vs what the user actually paid.
  actual: { altLabel: string; currentLabel: string; pct: number; cheaper: boolean } | null;
}

// Returns null when there's nothing trustworthy + comparative to share (and never
// in the all-pre-switch case — that's old usage, not a current-tariff result).
export function computeShareClaims(run: ComparisonRun, headline: Headline): ShareClaims | null {
  if (!headline.trustworthy || headline.previousTariffOnly !== null) return null;
  const comp = headline.comparison;
  if (comp.altTotal === null) return null;

  let estimate: ShareClaims['estimate'] = null;
  if (headline.summaryAgile !== null) {
    const flex = headline.summaryFlex;
    const agile = headline.summaryAgile;
    const peak = Math.max(flex, agile);
    if (peak > 0 && flex !== agile) {
      estimate = {
        cheaper: flex < agile ? shareFlexLabel(run.context.flexColumnSource) : 'Agile',
        dearer: flex < agile ? 'Agile' : shareFlexLabel(run.context.flexColumnSource),
        pct: (Math.abs(flex - agile) / peak) * 100,
      };
    }
  }

  let actual: ShareClaims['actual'] = null;
  const useActual = headline.summaryHasActual && headline.actualComparable;
  if (useActual && headline.summaryActual > 0) {
    actual = {
      altLabel: comp.altLabel,
      currentLabel: headline.currentTariffLabel,
      pct: (Math.abs(comp.altTotal - headline.summaryActual) / headline.summaryActual) * 100,
      cheaper: comp.altTotal < headline.summaryActual,
    };
  }

  if (!estimate && !actual) return null;
  return {
    period: `${fmtDate(run.context.periodFrom)} – ${fmtDate(run.context.periodTo)}`,
    estimate,
    actual,
  };
}

// The plain-text share (clipboard + text-only Web Share). PERCENTAGES ONLY.
export function buildShareText(run: ComparisonRun, headline: Headline): string | null {
  const c = computeShareClaims(run, headline);
  if (!c) return null;
  const claims: string[] = [];
  if (c.estimate)
    claims.push(
      `On my half-hourly usage, ${c.estimate.cheaper} worked out ${c.estimate.pct.toFixed(1)}% cheaper than ${c.estimate.dearer}.`,
    );
  if (c.actual)
    claims.push(
      `${c.actual.altLabel} would have been ${c.actual.pct.toFixed(1)}% ${c.actual.cheaper ? 'cheaper' : 'dearer'} than what I actually paid on ${c.actual.currentLabel}.`,
    );
  return [
    `I checked my Octopus usage with the auth.energy tariff checker (${c.period}):`,
    '',
    ...claims,
    '',
    'Try it: authenergy.github.io/agile-compare  #DynamicTariffCheck',
  ].join('\n');
}

// --- share image (canvas → PNG, optimised for social) -----------------------

const CARD = 1080; // square — displays well across LinkedIn / X / Instagram
const LOGO_D = [...LOGO_PATHS.matchAll(/d="([^"]+)"/g)].map((m) => m[1] ?? '');

function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxW && line) {
      lines.push(line);
      line = w;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// Draw the branded share card. Pure canvas (no external fonts/images → CSP-safe).
function drawShareCard(ctx: CanvasRenderingContext2D, c: ShareClaims): void {
  const W = CARD;
  const ink = '#0e1622';
  const blue = '#4a9eea';
  const white = '#f2f6fa';
  const muted = '#93a1b2';
  const font = (w: string, px: number): string =>
    `${w} ${px}px "Helvetica Neue", Arial, sans-serif`;

  const bg = ctx.createLinearGradient(0, 0, 0, W);
  bg.addColorStop(0, ink);
  bg.addColorStop(1, '#18222e');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, W);
  ctx.fillStyle = blue;
  ctx.fillRect(0, 0, W, 10); // accent bar

  // brand mark + wordmark
  ctx.save();
  ctx.translate(80, 86);
  const s = 78 / 43.969;
  ctx.scale(s, s);
  ctx.fillStyle = white;
  for (const d of LOGO_D) ctx.fill(new Path2D(d));
  ctx.restore();
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillStyle = white;
  ctx.font = font('700', 40);
  ctx.fillText('Octopus Tariff Check', 168, 120);
  ctx.fillStyle = muted;
  ctx.font = font('500', 27);
  ctx.fillText('by auth.energy', 168, 158);

  // hero: the bigger of the two claims as a giant %
  const hero = c.estimate
    ? {
        pct: c.estimate.pct,
        caption: `${c.estimate.cheaper} cheaper than ${c.estimate.dearer}`,
        eyebrow: 'On my real Octopus usage',
      }
    : c.actual
      ? {
          pct: c.actual.pct,
          caption: `${c.actual.altLabel} ${c.actual.cheaper ? 'cheaper' : 'dearer'} than I paid`,
          eyebrow: `vs my ${c.actual.currentLabel} bill`,
        }
      : null;

  ctx.textAlign = 'center';
  if (hero) {
    ctx.fillStyle = muted;
    ctx.font = font('600', 34);
    ctx.fillText(hero.eyebrow.toUpperCase(), W / 2, 396);
    ctx.fillStyle = blue;
    ctx.font = font('800', 230);
    ctx.fillText(`${hero.pct.toFixed(0)}%`, W / 2, 596);
    ctx.fillStyle = white;
    ctx.font = font('700', 54);
    for (const [i, line] of wrap(ctx, hero.caption, W - 160).entries()) {
      ctx.fillText(line, W / 2, 672 + i * 64);
    }
  }

  // secondary claim (when both exist)
  if (c.estimate && c.actual) {
    ctx.fillStyle = muted;
    ctx.font = font('500', 31);
    const sub = `${c.actual.altLabel} ${c.actual.cheaper ? 'cheaper' : 'dearer'} than my bill by ${c.actual.pct.toFixed(0)}%`;
    ctx.fillText(sub, W / 2, 792);
  }

  // footer
  ctx.fillStyle = muted;
  ctx.font = font('500', 28);
  ctx.fillText(c.period, W / 2, 908);
  ctx.fillStyle = blue;
  ctx.font = font('700', 36);
  ctx.fillText('#DynamicTariffCheck', W / 2, 968);
  ctx.fillStyle = white;
  ctx.font = font('500', 28);
  ctx.fillText('authenergy.github.io/agile-compare', W / 2, 1012);
}

// Sync data-URL → File so the file is ready before the share click (a Web Share
// must fire within the user gesture; an async toBlob can lose it).
function dataUrlToFile(dataUrl: string, name: string): File | null {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return null;
  try {
    const bin = atob(dataUrl.slice(comma + 1));
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new File([arr], name, { type: 'image/png' });
  } catch {
    return null;
  }
}

// --- panel ------------------------------------------------------------------

// The share panel: a preview of the social card + a button that shares the IMAGE
// via the native sheet (mobile), falling back to text share, then download +
// copy. Returns null when there's nothing to share. CSP-safe: canvas is rendered
// directly (no <img>), the PNG is shared as a File (not a loaded resource).
export function renderSharePanel(run: ComparisonRun, headline: Headline): HTMLElement | null {
  const claims = computeShareClaims(run, headline);
  const text = buildShareText(run, headline);
  if (!claims || !text) return null;

  // Build the card image (best-effort — canvas may be unavailable, e.g. jsdom).
  let imageFile: File | null = null;
  let previewEl: HTMLElement | null = null;
  const canvas = document.createElement('canvas');
  canvas.width = CARD;
  canvas.height = CARD;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    try {
      drawShareCard(ctx, claims);
      canvas.style.cssText = 'width:100%;height:auto;border-radius:var(--radius-md);display:block';
      previewEl = canvas;
      imageFile = dataUrlToFile(canvas.toDataURL('image/png'), 'octopus-tariff-check.png');
    } catch {
      previewEl = null;
    }
  }

  const btn = el('button', {
    class: 'btn btn-primary btn-md',
    type: 'button',
    text: imageFile ? 'Share' : 'Copy to clipboard',
  });
  let reset: ReturnType<typeof setTimeout> | undefined;
  const flash = (label: string): void => {
    btn.textContent = label;
    if (reset) clearTimeout(reset);
    reset = setTimeout(() => {
      btn.textContent = imageFile ? 'Share' : 'Copy to clipboard';
    }, 2200);
  };

  const nav = navigator as {
    share?: (d: { files?: File[]; text?: string; title?: string }) => Promise<void>;
    canShare?: (d: { files?: File[] }) => boolean;
    clipboard?: { writeText: (t: string) => Promise<void> };
  };
  const copyText = (): void => {
    if (nav.clipboard) {
      nav.clipboard
        .writeText(text)
        .then(() => flash('Copied!'))
        .catch(() => flash('Select the text and press Ctrl/Cmd-C'));
    } else {
      flash('Select the text and press Ctrl/Cmd-C');
    }
  };
  const downloadImage = (): void => {
    if (!imageFile) return;
    const url = URL.createObjectURL(imageFile);
    const a = document.createElement('a');
    a.href = url;
    a.download = imageFile.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  };

  btn.addEventListener('click', () => {
    const title = 'Octopus Tariff Check';
    // 1) Native share WITH the image (the optimised artifact) — mobile.
    if (imageFile && typeof nav.share === 'function' && nav.canShare?.({ files: [imageFile] })) {
      nav
        .share({ files: [imageFile], text, title })
        .then(() => flash('Shared!'))
        .catch(() => flash('Share cancelled'));
      return;
    }
    // 2) Native text share (no file support).
    if (typeof nav.share === 'function') {
      nav
        .share({ text, title })
        .then(() => flash('Shared!'))
        .catch(copyText);
      return;
    }
    // 3) Desktop fallback: save the image and copy the text.
    downloadImage();
    copyText();
  });

  const textBox = el('div', {
    class: 'mono',
    style:
      'flex:1 1 300px;min-width:0;align-self:stretch;display:flex;flex-direction:column;justify-content:center;white-space:pre-wrap;font-size:var(--text-body-sm);line-height:1.55;color:var(--text-body);background:var(--surface-sunken);border:1px solid var(--border-soft);border-radius:var(--radius-sm);padding:14px 16px',
    text,
  });
  // Image + text side by side on wide screens; flex-wrap stacks them on narrow.
  const previewWrap = previewEl
    ? el('div', { style: 'flex:0 0 320px;max-width:100%' }, [previewEl])
    : null;

  return el('div', { class: 'card', style: 'display:flex;flex-direction:column;gap:14px' }, [
    el('span', { class: 'eyebrow', text: 'Share your result' }),
    el('div', { style: 'display:flex;flex-wrap:wrap;gap:16px;align-items:stretch' }, [
      previewWrap,
      textBox,
    ]),
    el('div', {}, [btn]),
  ]);
}
