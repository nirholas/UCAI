import { $, ago, api, h, mountAuth, short } from '/kit/kit.js';

mountAuth({ appHref: '/app/' });

export const tone = (score) => (score >= 85 ? 'ok' : score >= 65 ? 'warn' : 'bad');

const skeleton = (el, n) => el.replaceChildren(...Array.from({ length: n }, () => h('div', { class: 'card stack' }, h('div', { class: 'skeleton sk-sm' }), h('div', { class: 'skeleton sk-lg' }), h('div', { class: 'skeleton sk-row' }))));
const failed = (el, msg, retry) => el.replaceChildren(h('div', { class: 'card empty-inline' }, h('p', { class: 'kit-err' }, msg), h('button', { class: 'btn btn-sm', onclick: retry, type: 'button' }, 'Retry')));

const card = (c) => {
  const href = `/app/#scan?chain=${encodeURIComponent(c.chainSlug)}&address=${encodeURIComponent(c.address)}`;
  if (!c.ok) {
    return h('a', { class: 'card', href },
      h('div', { class: 'row' }, h('strong', { class: 'grow' }, c.label), h('span', { class: 'badge' }, c.chain)),
      h('p', { class: 'kit-err' }, `Scan failed: ${c.error}`),
      h('span', { class: 'muted' }, short(c.address)));
  }
  const t = tone(c.score);
  return h('a', { class: 'card', href },
    h('div', { class: 'row' }, h('strong', { class: 'grow trunc' }, c.label), h('span', { class: 'badge' }, c.chain)),
    h('div', { class: 'score' }, h('span', { class: `score-num tabular g-${t}` }, String(c.score)), h('div', { class: 'scorebar', role: 'img', 'aria-label': `Score ${c.score} of 100` }, h('span', { class: `bg-${t}`, style: `width:${c.score}%` }))),
    h('div', { class: 'row' }, h('span', { class: `g-${t}` }, c.grade), c.proxy ? h('span', { class: 'badge' }, 'Upgradeable proxy') : null),
    c.top.length
      ? h('div', { class: 'stack' }, ...c.top.map((f) => h('div', { class: 'row' }, h('span', { class: `sev sev-${f.severity}` }, f.severity), h('span', { class: 'muted trunc grow' }, f.title))))
      : h('p', { class: 'muted' }, 'No admin-risk findings.'),
    h('span', { class: 'muted' }, `${c.name} · ${short(c.address)}`));
};

async function loadBoard() {
  const el = $('#board');
  const note = $('#board-note');
  if (!el.children.length) skeleton(el, 8);
  try {
    const live = await api('/api/live');
    if (!live.contracts.length) {
      el.replaceChildren(h('div', { class: 'card empty-inline' }, h('p', { class: 'muted' }, 'No preset contracts are configured.')));
      note.textContent = '';
      return;
    }
    el.replaceChildren(...live.contracts.map(card));
    note.textContent = live.stale ? `Verification sources are not responding; showing scans from ${ago(live.fetchedAt)}.` : `Scanned ${ago(live.fetchedAt)}. Higher scores mean fewer admin powers over your funds.`;
  } catch (e) {
    failed(el, `Live scans unavailable: ${e.message}`, loadBoard);
    note.textContent = '';
  }
}

loadBoard();
setInterval(loadBoard, 300_000);
