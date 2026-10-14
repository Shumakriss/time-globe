import type { PolityProps } from './map';
import { formatYear } from './timeScale';

interface WikiSummary {
  extract?: string;
  thumbnail?: { source: string };
  content_urls?: { desktop?: { page?: string } };
}

const cache = new Map<string, Promise<WikiSummary | null>>();

function fetchSummary(title: string): Promise<WikiSummary | null> {
  let p = cache.get(title);
  if (!p) {
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`;
    p = fetch(url)
      .then((r) => (r.ok ? (r.json() as Promise<WikiSummary>) : null))
      .catch(() => null);
    cache.set(title, p);
  }
  return p;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function createInfoPanel(
  el: HTMLElement,
  colorOf: (props: PolityProps) => string,
): (props: PolityProps | null) => void {
  let token = 0;
  const close = () => {
    el.hidden = true;
    token++;
  };
  window.addEventListener('keydown', (e) => e.key === 'Escape' && close());

  return (props) => {
    if (!props) return close();
    const mine = ++token;
    const span =
      props.src === 'basemaps'
        ? `Shown ${formatYear(props.from)} – ${formatYear(props.to)} (snapshot)`
        : `This border: ${formatYear(props.from)} – ${formatYear(props.to)}`;
    const source = props.src === 'clio' ? 'Cliopatria (Seshat)' : 'historical-basemaps';
    el.innerHTML = `
      <button class="info-close" aria-label="Close">×</button>
      <div class="info-swatch" style="background:${colorOf(props)}"></div>
      <h2>${escapeHtml(props.name)}</h2>
      <p class="info-span">${span}</p>
      <div class="info-body">${props.wiki ? '<p class="info-muted">Loading summary…</p>' : ''}</div>
      <p class="info-source">Boundary data: ${source}</p>
    `;
    el.hidden = false;
    el.querySelector('.info-close')!.addEventListener('click', close);
    if (!props.wiki) return;

    fetchSummary(props.wiki).then((s) => {
      if (mine !== token) return;
      const body = el.querySelector('.info-body')!;
      if (!s?.extract) {
        body.innerHTML = '<p class="info-muted">No summary available.</p>';
        return;
      }
      const link = s.content_urls?.desktop?.page;
      body.innerHTML = `
        ${s.thumbnail ? `<img src="${s.thumbnail.source}" alt="" />` : ''}
        <p>${escapeHtml(s.extract)}</p>
        ${link ? `<a href="${link}" target="_blank" rel="noopener">Read on Wikipedia →</a>` : ''}
      `;
    });
  };
}
