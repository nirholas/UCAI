import { $, api, busy, confirmDialog, copy, evm, gate, h, mountAuth, mountKeys, mountUsage, short, switchEvmChain, tabs, toast, user } from '/kit/kit.js';

mountAuth({ appHref: '/app/' });

const skel = (rows = 3) => h('div', { class: 'stack' }, Array.from({ length: rows }, () => h('div', { class: 'skeleton sk-row' })));
const empty = (text) => h('p', { class: 'empty-inline muted' }, text);
const tile = (label, value, extra, cls) => h('div', { class: 'card kpi' }, h('div', { class: 'l' }, label), h('div', { class: `v tabular ${cls ?? ''}` }, value), extra ? h('div', { class: 'muted' }, extra) : null);
const table = (head, rows) => h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', {}, h('tr', {}, head.map((c) => h('th', {}, c)))), h('tbody', {}, rows)));
const link = (href, text) => h('a', { href, rel: 'noopener', target: '_blank' }, text);
const pretty = (v) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));
const tone = (score) => (score >= 85 ? 'ok' : score >= 65 ? 'warn' : 'bad');
const errBox = (msg, retry) => h('div', { class: 'card empty-inline' }, h('p', { class: 'kit-err' }, msg), retry ? h('button', { class: 'btn btn-sm', onclick: retry, type: 'button' }, 'Retry') : null);

async function section(el, load, render) {
  el.replaceChildren(h('div', { class: 'card' }, skel()));
  try {
    el.replaceChildren(...[render(await load())].flat().filter(Boolean));
  } catch (e) {
    el.replaceChildren(errBox(e.message, () => section(el, load, render)));
  }
}

/* ---------------------------------------------------------------- target contract */

let chains = [];
let target = null; // { chain, address }
let summary = null;
const cache = new Map();

const chainBySlug = (slug) => chains.find((c) => c.slug === slug);
const base = () => `/api/contract/${target.chain}/${target.address}`;
const noTarget = () => empty('Load a contract above: pick a chain, paste a verified address or choose a preset.');

function cached(kind, load) {
  const key = `${kind}:${target.chain}:${target.address.toLowerCase()}`;
  if (!cache.has(key)) cache.set(key, load().catch((e) => { cache.delete(key); throw e; }));
  return cache.get(key);
}

async function loadChains() {
  const r = await api('/api/chains');
  chains = r.chains;
  $('#t-chain').replaceChildren(...chains.map((c) => h('option', { value: c.slug }, `${c.name} (${c.id})`)));
  $('#presets').replaceChildren(h('span', { class: 'muted' }, 'Presets:'), ...r.presets.map((p) => h('button', {
    class: 'btn btn-sm btn-ghost',
    onclick: () => setTarget(p.chain, p.address),
    type: 'button',
  }, p.label)));
}

function setTarget(chain, address, { switchTo } = {}) {
  $('#t-chain').value = chain;
  $('#t-address').value = address;
  target = { address, chain };
  summary = null;
  renderActive();
  if (switchTo) location.hash = switchTo;
}

const panels = {
  call: loadCall,
  codegen: loadCodegen,
  events: loadEventsPanel,
  explain: loadExplain,
  explore: loadExplore,
  scan: loadScan,
};
const rendered = new Map();

function renderActive() {
  const tab = (location.hash.slice(1) || 'explore').split('?')[0];
  const fn = panels[tab];
  if (!fn) return;
  const key = target ? `${target.chain}:${target.address}` : '';
  if (rendered.get(tab) === key) return;
  rendered.set(tab, key);
  fn();
}

/* ---------------------------------------------------------------- explore */

const getSummary = () => cached('abi', () => api(base())).then((s) => (summary = s));

function proxyLine(proxy) {
  if (!proxy?.isProxy) return null;
  const impls = proxy.implementations ?? [];
  return h('div', { class: 'callout warn' }, `Upgradeable proxy (${proxy.type}). `, impls.length ? ['Implementation: ', ...impls.flatMap((i, n) => [n ? ', ' : '', h('code', {}, short(i.address, 6)), ` ${i.name ?? ''}${i.verified ? '' : ' (unverified)'}`])] : 'Implementation could not be resolved.');
}

function fnRow(f) {
  return h('tr', {},
    h('td', {}, h('code', {}, f.signature), h('div', { class: 'muted' }, f.description)),
    h('td', {}, h('span', { class: 'badge' }, f.mutability)),
    h('td', { class: 'nowrap' }, h('code', {}, f.selector)),
    h('td', {}, f.outputs.length ? h('code', {}, f.outputs.map((o) => o.type).join(', ')) : h('span', { class: 'muted' }, '—')),
    h('td', {}, h('button', { class: 'btn btn-sm', onclick: () => { pendingFn = f.signature; location.hash = 'call'; }, type: 'button' }, f.mutability === 'view' || f.mutability === 'pure' ? 'Read' : 'Simulate')));
}

function loadExplore() {
  const el = $('#explore');
  if (!target) return el.replaceChildren(h('div', { class: 'card' }, noTarget()));
  section(el, getSummary, (s) => {
    const reads = s.functions.filter((f) => f.mutability === 'view' || f.mutability === 'pure');
    const writes = s.functions.filter((f) => !(f.mutability === 'view' || f.mutability === 'pure'));
    return [
      h('div', { class: 'card stack' },
        h('div', { class: 'row' }, h('h2', { class: 'grow' }, s.name), h('span', { class: 'badge' }, s.chain), link(s.explorer, 'Explorer ↗')),
        h('code', { class: 'muted trunc' }, s.address),
        proxyLine(s.proxy),
        h('dl', { class: 'kv' },
          h('dt', {}, 'Compiler'), h('dd', {}, s.compiler || '—'),
          h('dt', {}, 'Language'), h('dd', {}, s.language || '—'),
          h('dt', {}, 'Verified via'), h('dd', {}, s.verifiedVia),
          h('dt', {}, 'Source files'), h('dd', {}, String(s.sourceFiles ?? '—')))),
      h('div', { class: 'grid' }, tile('Read functions', String(reads.length)), tile('Write functions', String(writes.length)), tile('Events', String(s.events.length))),
      h('div', { class: 'card stack' },
        h('h3', {}, 'Functions as MCP tools'),
        s.functions.length ? table(['Signature', 'Mutability', 'Selector', 'Returns', ''], s.functions.map(fnRow)) : empty('This ABI declares no functions.')),
      h('div', { class: 'card stack' },
        h('h3', {}, 'Events'),
        s.events.length ? h('div', { class: 'fn-list' }, s.events.map((e) => h('code', {}, e))) : empty('This ABI declares no events.')),
    ];
  });
}

/* ---------------------------------------------------------------- scan */

function loadScan() {
  const el = $('#scan');
  if (!target) return el.replaceChildren(h('div', { class: 'card' }, noTarget()));
  section(el, () => cached('scan', () => api(`${base()}/scan`)), (r) => {
    const t = tone(r.score);
    return [
      h('div', { class: 'card stack' },
        h('div', { class: 'row' }, h('h2', { class: 'grow' }, r.name), h('span', { class: 'badge' }, r.chain)),
        h('div', { class: 'score' }, h('span', { class: `score-num tabular g-${t}` }, String(r.score)), h('div', { class: 'scorebar', role: 'img', 'aria-label': `Score ${r.score} of 100` }, h('span', { class: `bg-${t}`, style: `width:${r.score}%` }))),
        h('div', { class: 'row' }, h('strong', { class: `g-${t}` }, r.grade), r.proxy?.isProxy ? h('span', { class: 'badge' }, 'Upgradeable proxy') : null, h('span', { class: 'muted grow' }, `Scanned ${new Date(r.scannedAt).toLocaleString()}`)),
        r.owner
          ? h('p', { class: 'muted' }, 'Owner: ', h('code', {}, r.owner.address), r.owner.renounced ? ' (renounced)' : r.owner.isContract ? ' (a contract, possibly a multisig or timelock)' : ' (an externally owned account)')
          : h('p', { class: 'muted' }, 'No owner() function: ownership is not Ownable-style.')),
      h('div', { class: 'grid' }, ['critical', 'high', 'medium', 'low'].map((s) => tile(s[0].toUpperCase() + s.slice(1), String(r.counts[s] ?? 0), null, r.counts[s] ? (s === 'critical' || s === 'high' ? 'g-bad' : 'g-warn') : ''))),
      h('div', { class: 'card stack' },
        h('h3', {}, 'Findings'),
        r.findings.length
          ? r.findings.map((f) => h('div', { class: `finding ${f.severity}` },
            h('div', { class: 'row' }, h('span', { class: `sev sev-${f.severity}` }, f.severity), h('strong', { class: 'grow' }, f.title), h('span', { class: 'muted tabular' }, `−${f.penalty}`)),
            h('p', { class: 'muted' }, f.detail),
            f.functions?.length ? h('div', { class: 'fn-list' }, f.functions.map((n) => h('code', {}, n))) : null))
          : empty('No admin-risk findings: no mint, pause, blacklist, fee or upgrade powers were detected.')),
      r.positives.length ? h('div', { class: 'card stack' }, h('h3', {}, 'Positive signals'), h('ul', {}, r.positives.map((p) => h('li', {}, p)))) : null,
    ];
  });
}

/* ---------------------------------------------------------------- explain */

const briefList = (title, items, emptyText) => h('div', { class: 'card stack' }, h('h3', {}, title), items.length ? h('div', { class: 'stack' }, items.map((f) => h('div', {}, h('code', {}, f.signature), h('div', { class: 'muted' }, f.description)))) : empty(emptyText));

function loadExplain() {
  const el = $('#explain');
  if (!target) return el.replaceChildren(h('div', { class: 'card' }, noTarget()));
  section(el, () => cached('explain', () => api(`${base()}/explain`)), (r) => [
    h('div', { class: 'card stack' },
      h('div', { class: 'row' }, h('h2', { class: 'grow' }, r.name), h('span', { class: 'badge' }, r.kind), h('span', { class: 'badge' }, r.chain)),
      h('p', {}, r.summary),
      r.standards.length ? h('div', { class: 'row' }, r.standards.map((s) => h('span', { class: 'badge' }, s))) : null,
      proxyLine(r.proxy)),
    h('div', { class: 'card stack' },
      h('h3', {}, 'Live state'),
      r.state.length
        ? table(['Function', 'Type', 'Value'], r.state.map((s) => h('tr', {}, h('td', {}, h('code', {}, s.function)), h('td', { class: 'muted' }, s.type), h('td', { class: s.ok ? 'trunc' : 'kit-err' }, s.ok ? pretty(s.value) : `Call failed: ${s.value}`))))
        : empty('This contract has no argument-free view functions to read.')),
    h('div', { class: 'grid-2' },
      briefList('Reads', r.reads, 'No read functions.'),
      briefList('Writes', r.writes, 'No write functions.')),
    briefList('Admin functions', r.admin, 'No admin-only functions were detected.'),
  ]);
}

/* ---------------------------------------------------------------- read / write */

let pendingFn = null;
const isRead = (f) => f.mutability === 'view' || f.mutability === 'pure';

function argInput(p, i) {
  const name = p.name || `arg${i}`;
  const complex = p.type.endsWith(']') || p.type.startsWith('tuple');
  const placeholder = p.type === 'address' ? '0x…' : p.type === 'bool' ? 'true or false' : complex ? 'JSON, e.g. ["0x…","0x…"]' : p.type.startsWith('uint') || p.type.startsWith('int') ? 'integer (decimal string)' : p.type;
  const input = complex
    ? h('textarea', { class: 'input', name: `a${i}`, placeholder, required: true, rows: 3, spellcheck: 'false' })
    : h('input', { class: 'input', name: `a${i}`, placeholder, required: true, spellcheck: 'false' });
  return h('label', { class: 'field' }, h('span', {}, `${name} `, h('code', { class: 'muted' }, p.type)), input);
}

function renderFnForm(f) {
  const form = $('#fn-form');
  $('#fn-desc').textContent = f.description;
  const fields = f.inputs.map(argInput);
  const payable = f.mutability === 'payable';
  const u = user();
  const fromField = isRead(f) ? null : h('label', { class: 'field' }, 'From (sender)', h('input', { class: 'input', name: 'from', placeholder: '0x…', spellcheck: 'false', value: u?.chain === 'evm' ? u.address : '', required: u?.chain !== 'evm' }));
  const valueField = payable ? h('label', { class: 'field' }, `Value (wei)`, h('input', { class: 'input', inputmode: 'numeric', name: 'value', placeholder: '0' })) : null;
  form.replaceChildren(
    ...(fields.length ? fields : [h('p', { class: 'muted' }, 'This function takes no arguments.')]),
    fromField,
    valueField,
    h('div', { class: 'row end' }, h('button', { class: 'btn btn-primary', type: 'submit' }, isRead(f) ? 'Read' : 'Simulate')),
  );
  form.onsubmit = (ev) => {
    ev.preventDefault();
    const data = new FormData(form);
    const args = f.inputs.map((_, i) => String(data.get(`a${i}`) ?? '').trim());
    const out = $('#fn-out');
    out.replaceChildren(h('div', { class: 'card' }, skel(2)));
    busy(form.querySelector('[type=submit]'), async () => {
      try {
        if (isRead(f)) {
          const r = await api(`${base()}/read`, { body: { args, function: f.signature } });
          out.replaceChildren(h('div', { class: 'card stack' }, h('div', { class: 'row' }, h('strong', { class: 'grow' }, r.function), h('span', { class: 'badge' }, 'eth_call')), h('pre', { class: 'code result-body' }, pretty(r.result))));
        } else {
          const body = { args, function: f.signature };
          const from = String(data.get('from') ?? '').trim();
          const value = String(data.get('value') ?? '').trim();
          if (from) body.from = from;
          if (value) body.value = value;
          out.replaceChildren(simView(await api(`${base()}/simulate`, { body })));
        }
      } catch (e) {
        out.replaceChildren(errBox(e.message));
        throw e;
      }
    });
  };
}

function simView(r) {
  const s = r.simulation;
  const chain = chains.find((c) => c.id === r.tx.chainId);
  const sendOut = h('div');
  const canSend = s.success && user()?.chain === 'evm' && r.tx.from.toLowerCase() === user().address.toLowerCase();
  const send = h('button', {
    class: 'btn btn-primary',
    disabled: canSend ? null : true,
    onclick: async (ev) => {
      const btn = ev.currentTarget;
      if (!(await confirmDialog(`Send ${r.function} on ${r.chain} from your wallet? This is a real transaction and costs gas.`, 'Open wallet'))) return;
      await busy(btn, async () => {
        try {
          await switchEvmChain({ currency: { decimals: 18, name: chain.currency, symbol: chain.currency }, explorer: chain.explorer, id: chain.id, name: chain.name, rpc: chain.rpc });
          const provider = evm();
          const hash = await provider.request({ method: 'eth_sendTransaction', params: [{ data: r.tx.data, from: r.tx.from, to: r.tx.to, value: r.tx.value }] });
          sendOut.replaceChildren(h('div', { class: 'callout ok' }, 'Submitted: ', link(`${chain.explorer}/tx/${hash}`, short(hash, 8))));
          toast('Transaction submitted', 'success');
        } catch (e) {
          const msg = e?.code === 4001 ? 'You rejected the transaction in your wallet.' : e?.message ?? String(e);
          sendOut.replaceChildren(h('p', { class: 'kit-err' }, msg));
          throw e;
        }
      });
    },
    type: 'button',
  }, 'Send from wallet');
  return h('div', { class: 'card stack' },
    h('div', { class: 'row' }, h('strong', { class: 'grow' }, r.function), h('span', { class: `badge ${s.success ? 'g-ok' : 'g-bad'}` }, s.success ? 'Would succeed' : 'Would revert')),
    s.success
      ? h('div', { class: 'grid' }, tile('Estimated gas', s.gas ?? '—'), tile('Chain', r.chain))
      : h('div', { class: 'callout bad' }, s.error),
    s.success && s.result !== undefined && s.result !== null ? h('pre', { class: 'code result-body' }, pretty(s.result)) : null,
    h('details', {}, h('summary', {}, 'Unsigned transaction'), h('pre', { class: 'code result-body' }, pretty(r.tx))),
    h('p', { class: 'muted' }, r.note),
    h('div', { class: 'row end' },
      canSend ? null : h('span', { class: 'muted grow' }, s.success ? 'Sign in with the sender EVM wallet to send.' : 'Fix the revert before sending.'),
      send),
    sendOut);
}

function loadCall() {
  const sel = $('#fn-select');
  const out = $('#fn-out');
  if (!target) {
    sel.replaceChildren();
    $('#fn-form').replaceChildren(noTarget());
    $('#fn-desc').textContent = '';
    return;
  }
  $('#fn-form').replaceChildren(skel(2));
  out.replaceChildren();
  getSummary().then((s) => {
    if (!s.functions.length) {
      sel.replaceChildren();
      $('#fn-form').replaceChildren(empty('This ABI declares no functions.'));
      return;
    }
    const groups = [['Read', s.functions.filter(isRead)], ['Write', s.functions.filter((f) => !isRead(f))]].filter(([, l]) => l.length);
    sel.replaceChildren(...groups.map(([g, l]) => h('optgroup', { label: g }, l.map((f) => h('option', { value: f.signature }, f.signature)))));
    const pick = s.functions.find((f) => f.signature === pendingFn) ?? s.functions[0];
    pendingFn = null;
    sel.value = pick.signature;
    sel.onchange = () => {
      out.replaceChildren();
      renderFnForm(s.functions.find((f) => f.signature === sel.value));
    };
    renderFnForm(pick);
  }).catch((e) => {
    rendered.delete('call');
    $('#fn-form').replaceChildren(errBox(e.message, loadCall));
  });
}

/* ---------------------------------------------------------------- events */

function eventsView(r, explorer) {
  const head = h('p', { class: 'muted' }, `Blocks ${r.fromBlock}–${r.toBlock} (${r.blocksScanned} scanned) · ${r.events.length} event(s)${r.truncated ? ', truncated to the limit' : ''}`);
  if (!r.events.length) return h('div', { class: 'card stack' }, head, empty('No matching events in this block range. Try more blocks or another event.'));
  return h('div', { class: 'card stack' }, head, table(['Block', 'Event', 'Arguments', 'Tx'], r.events.map((e) => h('tr', {},
    h('td', { class: 'tabular' }, e.block ?? 'pending'),
    h('td', {}, h('code', {}, e.event ?? 'unknown')),
    h('td', {}, h('pre', { class: 'code result-body' }, pretty(e.args))),
    h('td', { class: 'nowrap' }, e.tx ? link(`${explorer}/tx/${e.tx}`, short(e.tx, 6)) : '—')))));
}

function loadEventsPanel() {
  const sel = $('#ev-select');
  const out = $('#ev-out');
  if (!target) {
    sel.replaceChildren();
    out.replaceChildren(h('div', { class: 'card' }, noTarget()));
    return;
  }
  out.replaceChildren();
  getSummary().then((s) => {
    sel.replaceChildren(h('option', { value: '' }, 'All events'), ...s.events.map((e) => h('option', { value: e }, e)));
    if (!s.events.length) out.replaceChildren(h('div', { class: 'card' }, empty('This ABI declares no events.')));
  }).catch((e) => {
    rendered.delete('events');
    out.replaceChildren(errBox(e.message, loadEventsPanel));
  });
}

function bindEvents() {
  const form = $('#ev-form');
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (!target) return toast('Load a contract first', 'error');
    const q = new URLSearchParams();
    for (const k of ['event', 'blocks', 'limit']) if (form[k].value) q.set(k, form[k].value);
    const explorer = chainBySlug(target.chain)?.explorer ?? '';
    const out = $('#ev-out');
    out.replaceChildren(h('div', { class: 'card' }, skel(4)));
    busy(form.querySelector('[type=submit]'), async () => {
      try {
        out.replaceChildren(eventsView(await api(`${base()}/events?${q}`), explorer));
      } catch (e) {
        out.replaceChildren(errBox(e.message));
        throw e;
      }
    });
  });
}

/* ---------------------------------------------------------------- codegen */

function loadCodegen() {
  const el = $('#codegen');
  if (!target) return el.replaceChildren(h('div', { class: 'card' }, noTarget()));
  section(el, () => cached('codegen', () => api(`${base()}/codegen`)), (r) => {
    if (!r.files.length) return h('div', { class: 'card' }, empty('No files were generated.'));
    const view = h('pre', { class: 'code result-body' });
    const name = h('code', { class: 'grow trunc' });
    let current = r.files[0];
    const buttons = r.files.map((f) => h('button', {
      'aria-pressed': 'false',
      class: 'btn btn-sm',
      onclick: () => show(f),
      type: 'button',
    }, f.name));
    const show = (f) => {
      current = f;
      view.textContent = f.content;
      name.textContent = f.name;
      buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(r.files[i] === f)));
    };
    show(current);
    return h('div', { class: 'card stack' },
      h('p', { class: 'muted' }, `A standalone Python FastMCP server with ${r.tools} tool(s). Save the files, run pip install -r requirements.txt, then python server.py.`),
      h('div', { class: 'row code-files' }, buttons),
      h('div', { class: 'row' }, name, h('button', { class: 'btn btn-sm', onclick: () => copy(current.content, `${current.name} copied`), type: 'button' }, 'Copy file')),
      view);
  });
}

/* ---------------------------------------------------------------- saved */

function mcpConfig(id, url) {
  return JSON.stringify({ mcpServers: { [`ucai-${id}`]: { headers: { Authorization: 'Bearer <your API key>' }, type: 'http', url } } }, null, 2);
}

function loadSaved() {
  section($('#saved'), () => api('/api/contracts'), (r) => {
    if (!r.contracts.length) return h('div', { class: 'card' }, empty('No saved contracts yet. Load one above and press "Save the loaded contract".'));
    return h('div', { class: 'card stack' },
      h('p', { class: 'muted' }, `${r.contracts.length} of ${r.max} saved`),
      table(['Contract', 'Chain', 'Tools', 'MCP endpoint', ''], r.contracts.map((c) => {
        const url = `${location.origin}${c.mcpPath}`;
        const slug = chains.find((x) => x.id === c.chainId)?.slug;
        return h('tr', {},
          h('td', {}, h('strong', {}, c.name), h('div', { class: 'muted' }, h('code', {}, short(c.address, 6)))),
          h('td', {}, c.chain),
          h('td', { class: 'tabular nowrap' }, `${c.reads} read · ${c.writes} write · ${c.events} event`),
          h('td', {}, h('code', { class: 'trunc' }, c.mcpPath)),
          h('td', { class: 'nowrap' },
            slug ? h('button', { class: 'btn btn-sm btn-ghost', onclick: () => setTarget(slug, c.address, { switchTo: 'explore' }), type: 'button' }, 'Open') : null,
            h('button', { class: 'btn btn-sm btn-ghost', onclick: () => copy(url, 'MCP URL copied'), type: 'button' }, 'Copy URL'),
            h('button', { class: 'btn btn-sm btn-ghost', onclick: () => copy(mcpConfig(c.id, url), 'mcp.json copied'), type: 'button' }, 'Copy config'),
            h('button', {
              'aria-label': `Delete ${c.name}`,
              class: 'btn btn-sm btn-ghost',
              onclick: async (ev) => {
                const btn = ev.currentTarget;
                if (!(await confirmDialog(`Delete ${c.name}? Its MCP endpoint stops working at once.`, 'Delete'))) return;
                await busy(btn, async () => {
                  await api(`/api/contracts/${c.id}`, { method: 'DELETE' });
                  toast('Deleted', 'success');
                  loadSaved();
                });
              },
              type: 'button',
            }, 'Delete')));
      })));
  });
}

function bindSave() {
  $('#save-current').addEventListener('click', (ev) => {
    if (!target) return toast('Load a contract first', 'error');
    busy(ev.currentTarget, async () => {
      const r = await api('/api/contracts', { body: { address: target.address, chain: target.chain } });
      toast(`Saved ${r.name}`, 'success');
      loadSaved();
    });
  });
}

/* ---------------------------------------------------------------- tools */

let tools = [];

function field(name, schema, required) {
  const label = `${name}${required ? ' *' : ''}`;
  const hint = schema.description ? h('small', { class: 'muted' }, schema.description) : null;
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;
  let input;
  if (schema.enum) {
    input = h('select', { class: 'input', name }, required ? null : h('option', { value: '' }, '(default)'), schema.enum.map((v) => h('option', { selected: schema.default === v, value: String(v) }, String(v))));
  } else if (type === 'boolean') {
    input = h('select', { class: 'input', name }, h('option', { value: '' }, '(default)'), h('option', { value: 'true' }, 'true'), h('option', { value: 'false' }, 'false'));
  } else {
    let value = null;
    if (target && name === 'address') value = target.address;
    if (target && name === 'chain') value = target.chain;
    input = h('input', {
      class: 'input',
      name,
      placeholder: schema.default != null ? String(schema.default) : type === 'array' ? 'JSON array, e.g. ["0x…", "1000"]' : '',
      required: required && schema.default == null ? true : null,
      step: type === 'number' ? 'any' : null,
      type: type === 'number' || type === 'integer' ? 'number' : 'text',
      value,
    });
  }
  input.dataset.type = type ?? 'string';
  return h('label', { class: 'field' }, label, input, hint);
}

function collect(form) {
  const args = {};
  for (const el of form.querySelectorAll('[name]')) {
    const v = el.value.trim();
    if (!v) continue;
    const t = el.dataset.type;
    args[el.name] = t === 'number' || t === 'integer' ? Number(v) : t === 'boolean' ? v === 'true' : v;
  }
  return args;
}

function openTool(t, btn) {
  for (const b of document.querySelectorAll('.tool-item')) b.setAttribute('aria-current', String(b === btn));
  const props = t.inputSchema.properties ?? {};
  const req = new Set(t.inputSchema.required ?? []);
  const out = h('div');
  const form = h('form', { class: 'stack' }, Object.entries(props).map(([k, s]) => field(k, s, req.has(k))), h('div', { class: 'row end' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Run')));
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    out.replaceChildren(skel(3));
    busy(form.querySelector('[type=submit]'), async () => {
      try {
        const r = await api(`/api/run/${encodeURIComponent(t.name)}`, { body: collect(form) });
        out.replaceChildren(h('div', { class: 'muted' }, `${r.ms} ms`), h('pre', { class: 'code result-body' }, pretty(r.result)));
        if (t.name === 'save_contract') loadSaved();
      } catch (e) {
        out.replaceChildren(h('p', { class: 'kit-err' }, e.message));
        throw e;
      }
    });
  });
  $('#tool-pane').replaceChildren(
    h('div', { class: 'row' }, h('h3', { class: 'grow' }, t.title), h('span', { class: 'badge' }, t.group)),
    h('p', { class: 'muted' }, t.description),
    h('code', { class: 'muted' }, `POST /api/run/${t.name}`),
    Object.keys(props).length ? null : h('p', { class: 'muted' }, 'This tool takes no arguments.'),
    form,
    out,
  );
}

function renderTools() {
  const q = $('#tool-filter').value.trim().toLowerCase();
  const list = $('#tool-list');
  const shown = tools.filter((t) => !q || `${t.name} ${t.title} ${t.description} ${t.group}`.toLowerCase().includes(q));
  if (!shown.length) return list.replaceChildren(empty(q ? `No tool matches "${q}".` : 'No tools available.'));
  const groups = [...new Set(shown.map((t) => t.group))];
  list.replaceChildren(...groups.flatMap((g) => [
    h('div', { class: 'muted' }, h('strong', {}, g)),
    ...shown.filter((t) => t.group === g).map((t) => {
      const b = h('button', { class: 'tool-item', type: 'button' }, t.title, h('small', {}, t.name));
      b.addEventListener('click', () => openTool(t, b));
      return b;
    }),
  ]));
}

function loadTools() {
  section($('#tool-list'), () => api('/api/tools'), (r) => {
    tools = r.tools;
    queueMicrotask(renderTools);
    return skel(1);
  });
}

/* ---------------------------------------------------------------- mcp */

function initMcp() {
  const url = `${location.origin}/mcp`;
  $('#mcp-url').textContent = url;
  $('#mcp-copy').addEventListener('click', () => copy(url, 'MCP URL copied'));
  $('#mcp-config').textContent = JSON.stringify({ mcpServers: { ucai: { headers: { Authorization: 'Bearer <your API key>' }, type: 'http', url } } }, null, 2);
  $('#mcp-curl').textContent = `curl -s ${url} \\\n  -H "Authorization: Bearer $UCAI_KEY" \\\n  -H "content-type: application/json" \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"scan_contract","arguments":{"chain":"ethereum","address":"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"}}}'`;
  section($('#mcp-tools'), () => api('/mcp', { body: { id: 1, jsonrpc: '2.0', method: 'tools/list' } }), (r) => {
    const list = r.result?.tools ?? [];
    if (!list.length) return empty('The MCP server listed no tools.');
    return [h('p', { class: 'muted' }, `${list.length} tools`), table(['Name', 'Description'], list.map((t) => h('tr', {}, h('td', { class: 'nowrap' }, h('code', {}, t.name)), h('td', {}, t.description))))];
  });
}

/* ---------------------------------------------------------------- boot */

// Deep links like #scan?chain=ethereum&address=0x… come from the landing page.
function readDeepLink() {
  const m = location.hash.match(/^#(\w+)\?(.+)$/);
  if (!m) return null;
  const q = new URLSearchParams(m[2]);
  history.replaceState(null, '', `#${m[1]}`);
  const address = q.get('address') ?? '';
  return /^0x[0-9a-fA-F]{40}$/.test(address) && q.get('chain') ? { address, chain: q.get('chain'), tab: m[1] } : null;
}

const deep = readDeepLink();
const root = $('#app');
await gate(root, { text: 'Connect an Ethereum or Solana wallet to turn verified contracts into MCP tools, scan them for admin risk, read state and simulate writes.', title: 'Sign in to UCAI Cloud' });
const u = user();
$('#who').textContent = `${u.chain === 'evm' ? 'EVM' : 'Solana'} · ${short(u.address, 6)}`;
tabs(root);

$('#target').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const address = $('#t-address').value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return toast('Enter a 0x address with 40 hex characters', 'error');
  setTarget($('#t-chain').value, address);
  const tab = (location.hash.slice(1) || 'explore').split('?')[0];
  if (!panels[tab]) location.hash = 'explore';
});
bindEvents();
bindSave();
$('#tool-filter').addEventListener('input', renderTools);

try {
  await loadChains();
} catch (e) {
  $('#presets').replaceChildren(h('span', { class: 'kit-err' }, `Chains failed to load: ${e.message}`), h('button', { class: 'btn btn-sm', onclick: () => location.reload(), type: 'button' }, 'Reload'));
}

initMcp();
loadSaved();
loadTools();
mountKeys($('#keys'), { endpointHint: `curl -s ${location.origin}/api/contract/ethereum/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48/scan -H "Authorization: Bearer $UCAI_KEY"` });
const usage = mountUsage($('#usage'));

if (deep && chainBySlug(deep.chain)) setTarget(deep.chain, deep.address);
else renderActive();

window.addEventListener('hashchange', () => {
  const link = readDeepLink();
  if (link && chainBySlug(link.chain)) setTarget(link.chain, link.address);
  const tab = location.hash.slice(1);
  if (tab === 'saved') loadSaved();
  if (tab === 'usage') usage.reload();
  renderActive();
});
