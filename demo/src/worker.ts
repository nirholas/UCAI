import {
  BaseError,
  createPublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  fallback,
  formatUnits,
  getAddress,
  http,
  isAddress,
  toFunctionSelector,
  type Abi,
  type AbiEvent,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
} from 'viem';
import { arbitrum, avalanche, base, bsc, mainnet, optimism, polygon, sepolia } from 'viem/chains';
import { ensureSchema, HttpError, json, kitRoutes, metered, readJson, requireKeyOrUser, requireUser, Router, serve, str, type KitEnv, type User } from './kit';

const APP = 'UCAI Cloud';
const VERSION = '1.0.0';
const MAX_SAVED = 25;
const LOG_CHUNK = 50;
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const ZERO = '0x0000000000000000000000000000000000000000';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, fetched_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS contracts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, chain_id INTEGER NOT NULL, address TEXT NOT NULL, name TEXT NOT NULL, abi TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE (user_id, chain_id, address));
CREATE INDEX IF NOT EXISTS contracts_user ON contracts (user_id, created_at)
`;

interface Env extends KitEnv {}

/* ---------------------------------------------------------------- chains */

interface ChainDef {
  blockscout?: string;
  currency: string;
  explorer: string;
  id: number;
  name: string;
  routescan?: boolean;
  rpc: string;
  slug: string;
  viem: Chain;
}

const CHAINS: ChainDef[] = [
  { blockscout: 'https://eth.blockscout.com', currency: 'ETH', explorer: 'https://etherscan.io', id: 1, name: 'Ethereum', rpc: 'https://ethereum-rpc.publicnode.com', slug: 'ethereum', viem: mainnet },
  { blockscout: 'https://base.blockscout.com', currency: 'ETH', explorer: 'https://basescan.org', id: 8453, name: 'Base', rpc: 'https://base-rpc.publicnode.com', slug: 'base', viem: base },
  { blockscout: 'https://arbitrum.blockscout.com', currency: 'ETH', explorer: 'https://arbiscan.io', id: 42161, name: 'Arbitrum One', rpc: 'https://arbitrum-one-rpc.publicnode.com', slug: 'arbitrum', viem: arbitrum },
  { blockscout: 'https://optimism.blockscout.com', currency: 'ETH', explorer: 'https://optimistic.etherscan.io', id: 10, name: 'OP Mainnet', rpc: 'https://optimism-rpc.publicnode.com', slug: 'optimism', viem: optimism },
  { blockscout: 'https://polygon.blockscout.com', currency: 'POL', explorer: 'https://polygonscan.com', id: 137, name: 'Polygon', rpc: 'https://polygon-bor-rpc.publicnode.com', slug: 'polygon', viem: polygon },
  { currency: 'BNB', explorer: 'https://bscscan.com', id: 56, name: 'BNB Smart Chain', rpc: 'https://bsc-rpc.publicnode.com', slug: 'bsc', viem: bsc },
  { currency: 'AVAX', explorer: 'https://snowtrace.io', id: 43114, name: 'Avalanche C-Chain', routescan: true, rpc: 'https://avalanche-c-chain-rpc.publicnode.com', slug: 'avalanche', viem: avalanche },
  { blockscout: 'https://eth-sepolia.blockscout.com', currency: 'ETH', explorer: 'https://sepolia.etherscan.io', id: 11155111, name: 'Sepolia', rpc: 'https://ethereum-sepolia-rpc.publicnode.com', slug: 'sepolia', viem: sepolia },
];

const PRESETS = [
  { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', chainId: 1, label: 'USDC' },
  { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', chainId: 1, label: 'WETH' },
  { address: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D', chainId: 1, label: 'Uniswap V2 Router' },
  { address: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2', chainId: 1, label: 'Aave V3 Pool' },
  { address: '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D', chainId: 1, label: 'Bored Ape Yacht Club' },
  { address: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43', chainId: 8453, label: 'Aerodrome Router' },
  { address: '0x10ED43C718714eb63d5aA57B78B54704E256024E', chainId: 56, label: 'PancakeSwap Router' },
  { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', chainId: 42161, label: 'USDC (Arbitrum)' },
];

function chainOf(v: unknown): ChainDef {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) throw new HttpError(400, 'chain is required');
  const c = CHAINS.find((x) => String(x.id) === s || x.slug === s || x.name.toLowerCase() === s || (s === 'mainnet' && x.id === 1) || (s === 'eth' && x.id === 1));
  if (!c) throw new HttpError(400, `Unsupported chain "${String(v)}". Use one of: ${CHAINS.map((x) => `${x.slug} (${x.id})`).join(', ')}`);
  return c;
}

const clients = new Map<number, PublicClient>();
function client(c: ChainDef): PublicClient {
  let pc = clients.get(c.id);
  if (!pc) {
    pc = createPublicClient({ batch: { multicall: true }, chain: c.viem, transport: fallback([http(c.rpc, { timeout: 15_000 }), http(undefined, { timeout: 15_000 })]) }) as PublicClient;
    clients.set(c.id, pc);
  }
  return pc;
}

function addr(v: unknown, field = 'address'): Address {
  if (typeof v !== 'string' || !isAddress(v.trim(), { strict: false })) throw new HttpError(400, `${field} must be a 0x-prefixed 20-byte address`);
  return getAddress(v.trim());
}

/* ---------------------------------------------------------------- helpers */

const bigintSafe = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);

class UpstreamError extends HttpError {}

async function getJson<T>(url: string): Promise<T | null> {
  const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'ucai-cloud/1.0 (+https://ucai.ninabrekkerese.workers.dev)' }, signal: AbortSignal.timeout(15_000) });
  if (r.status === 404) return null;
  const text = await r.text();
  if (!r.ok) throw new UpstreamError(r.status >= 500 || r.status === 429 ? 502 : 400, `${new URL(url).host} returned ${r.status}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new UpstreamError(502, `${new URL(url).host} returned invalid JSON`);
  }
}

async function cached<T extends object>(env: Env, ctx: ExecutionContext, key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T & { stale?: boolean }> {
  const row = await env.DB.prepare('SELECT value, fetched_at FROM cache WHERE key = ?').bind(key).first<{ fetched_at: number; value: string }>();
  if (row && Date.now() - row.fetched_at < ttlSeconds * 1000) return JSON.parse(row.value);
  try {
    const value = await load();
    const text = JSON.stringify(value, bigintSafe);
    if (text.length < 1_800_000) {
      ctx.waitUntil(
        env.DB.prepare('INSERT INTO cache (key, value, fetched_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, fetched_at = excluded.fetched_at').bind(key, text, Date.now()).run(),
      );
    }
    return JSON.parse(text);
  } catch (error) {
    if (row && !(error instanceof HttpError && error.status < 500)) return { ...(JSON.parse(row.value) as T), stale: true };
    throw error instanceof HttpError ? error : new HttpError(502, `Upstream unavailable: ${(error as Error).message}`);
  }
}

function rpcMessage(e: unknown): string {
  if (e instanceof BaseError) return e.shortMessage.replace(/\s+/g, ' ').slice(0, 400);
  return (e as Error).message.slice(0, 400);
}

function int(v: unknown, field: string, min: number, max: number, dflt: number): number {
  if (v === undefined || v === null || v === '') return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${field} must be an integer between ${min} and ${max}`);
  return n;
}

/* ---------------------------------------------------------------- ABI model */

interface AbiParam {
  components?: AbiParam[];
  indexed?: boolean;
  internalType?: string;
  name?: string;
  type: string;
}

interface AbiItem {
  anonymous?: boolean;
  constant?: boolean;
  inputs?: AbiParam[];
  name?: string;
  outputs?: AbiParam[];
  payable?: boolean;
  stateMutability?: string;
  type: string;
}

interface ContractInfo {
  abi: AbiItem[];
  address: Address;
  chainId: number;
  compiler: string | null;
  fetchedAt: number;
  files: { bytes: number; path: string }[];
  language: string | null;
  name: string;
  proxy: { implementations: { address: Address; name: string | null; verified: boolean }[]; isProxy: boolean; type: string | null };
  signals: Record<string, number>;
  verifiedVia: 'blockscout' | 'routescan' | 'sourcify';
}

const mutability = (x: AbiItem) => x.stateMutability ?? (x.constant ? 'view' : x.payable ? 'payable' : 'nonpayable');
const isRead = (x: AbiItem) => ['pure', 'view'].includes(mutability(x));

function canon(p: AbiParam): string {
  if (p.type.startsWith('tuple')) return `(${(p.components ?? []).map(canon).join(',')})${p.type.slice(5)}`;
  return p.type;
}
const signature = (x: AbiItem) => `${x.name}(${(x.inputs ?? []).map(canon).join(',')})`;

function normalizeAbi(raw: unknown): AbiItem[] {
  const list = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  if (!Array.isArray(list)) return [];
  return (list as AbiItem[]).filter((x) => x && typeof x.type === 'string').map((x) => (x.type === 'function' ? { ...x, stateMutability: mutability(x) } : x));
}

function mergeAbis(...abis: AbiItem[][]): AbiItem[] {
  const seen = new Set<string>();
  const out: AbiItem[] = [];
  for (const abi of abis)
    for (const x of abi) {
      if (x.type === 'constructor' || x.type === 'fallback' || x.type === 'receive') continue;
      const k = `${x.type}:${x.name ? signature(x) : ''}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(x);
    }
  return out;
}

/* ---------------------------------------------------------------- source signals */

const SIGNALS: Record<string, RegExp> = {
  assembly: /\bassembly\s*(\(\s*"memory-safe"\s*\)\s*)?\{/g,
  blockTimestamp: /\bblock\.timestamp\b/g,
  delegatecall: /\.delegatecall\s*\(/g,
  ecrecover: /\becrecover\s*\(/g,
  lowLevelCall: /\.call\s*(\{[^}]*\})?\s*\(/g,
  nonReentrant: /\bnonReentrant\b/g,
  selfdestruct: /\b(selfdestruct|suicide)\s*\(/g,
  txOrigin: /\btx\.origin\b/g,
  unchecked: /\bunchecked\s*\{/g,
};

function signalsOf(files: { content: string; path: string }[]): Record<string, number> {
  const out: Record<string, number> = { files: files.length, openZeppelin: 0 };
  for (const k of Object.keys(SIGNALS)) out[k] = 0;
  for (const f of files) {
    if (/@openzeppelin|openzeppelin/i.test(f.path)) out.openZeppelin++;
    // Library code is vetted upstream; count risky patterns in the project's own files only.
    const own = !/(@openzeppelin|openzeppelin|node_modules|\blib\/|solmate|solady)/i.test(f.path);
    const code = f.content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    for (const [k, re] of Object.entries(SIGNALS)) if (own || k === 'nonReentrant') out[k] += (code.match(re) ?? []).length;
  }
  return out;
}

/* ---------------------------------------------------------------- ABI sourcing */

interface Verified {
  abi: AbiItem[];
  compiler: string | null;
  files: { content: string; path: string }[];
  implementations: { address: Address; name: string | null }[];
  isProxy: boolean;
  language: string | null;
  name: string;
  proxyType: string | null;
  via: ContractInfo['verifiedVia'];
}

interface SourcifyV2 {
  abi?: AbiItem[];
  compilation?: { compilerVersion?: string; language?: string; name?: string };
  proxyResolution?: { implementations?: { address: string; name?: string }[]; isProxy?: boolean; proxyType?: string };
  sources?: Record<string, { content?: string }>;
}

async function fromSourcify(c: ChainDef, a: Address): Promise<Verified | null> {
  const j = await getJson<SourcifyV2>(`https://sourcify.dev/server/v2/contract/${c.id}/${a}?fields=abi,proxyResolution,compilation,sources`);
  if (!j?.abi) return null;
  return {
    abi: normalizeAbi(j.abi),
    compiler: j.compilation?.compilerVersion ?? null,
    files: Object.entries(j.sources ?? {}).map(([path, s]) => ({ content: s.content ?? '', path })),
    implementations: (j.proxyResolution?.implementations ?? []).filter((x) => isAddress(x.address, { strict: false })).map((x) => ({ address: getAddress(x.address), name: x.name ?? null })),
    isProxy: Boolean(j.proxyResolution?.isProxy),
    language: j.compilation?.language ?? null,
    name: j.compilation?.name ?? 'Contract',
    proxyType: j.proxyResolution?.proxyType ?? null,
    via: 'sourcify',
  };
}

interface BlockscoutContract {
  abi?: AbiItem[];
  additional_sources?: { file_path: string; source_code: string }[];
  compiler_version?: string;
  file_path?: string;
  language?: string;
  name?: string;
  proxy_type?: string;
  source_code?: string;
}
interface BlockscoutImpl {
  address?: string;
  address_hash?: string;
  name?: string;
}

async function fromBlockscout(c: ChainDef, a: Address): Promise<Verified | null> {
  if (!c.blockscout) return null;
  const [sc, info] = await Promise.all([
    getJson<BlockscoutContract>(`${c.blockscout}/api/v2/smart-contracts/${a}`),
    getJson<{ implementations?: BlockscoutImpl[]; proxy_type?: string }>(`${c.blockscout}/api/v2/addresses/${a}`).catch(() => null),
  ]);
  if (!sc?.abi?.length) return null;
  const impls = (info?.implementations ?? []).map((x) => ({ address: x.address_hash ?? x.address ?? '', name: x.name ?? null })).filter((x) => isAddress(x.address, { strict: false }) && x.address.toLowerCase() !== a.toLowerCase());
  return {
    abi: normalizeAbi(sc.abi),
    compiler: sc.compiler_version ?? null,
    files: [{ content: sc.source_code ?? '', path: sc.file_path ?? `${sc.name ?? 'Contract'}.sol` }, ...(sc.additional_sources ?? []).map((x) => ({ content: x.source_code, path: x.file_path }))],
    implementations: impls.map((x) => ({ address: getAddress(x.address), name: x.name })),
    isProxy: impls.length > 0,
    language: sc.language ?? null,
    name: sc.name ?? 'Contract',
    proxyType: info?.proxy_type ?? sc.proxy_type ?? null,
    via: 'blockscout',
  };
}

interface RoutescanRow {
  ABI: string;
  CompilerVersion: string;
  ContractName: string;
  Implementation?: string;
  Proxy?: string;
  SourceCode: string;
}

async function fromRoutescan(c: ChainDef, a: Address): Promise<Verified | null> {
  if (!c.routescan) return null;
  const j = await getJson<{ result?: RoutescanRow[] | string; status?: string }>(`https://api.routescan.io/v2/network/mainnet/evm/${c.id}/etherscan/api?module=contract&action=getsourcecode&address=${a}`);
  const row = Array.isArray(j?.result) ? j.result[0] : undefined;
  if (!row?.ABI?.startsWith('[')) return null;
  let files: { content: string; path: string }[] = [{ content: row.SourceCode, path: `${row.ContractName}.sol` }];
  const src = row.SourceCode.trim();
  if (src.startsWith('{')) {
    try {
      const parsed = JSON.parse(src.startsWith('{{') ? src.slice(1, -1) : src) as { sources?: Record<string, { content: string }> } & Record<string, { content: string }>;
      const sources = parsed.sources ?? parsed;
      files = Object.entries(sources).map(([path, s]) => ({ content: s?.content ?? '', path }));
    } catch {
      files = [{ content: src, path: `${row.ContractName}.sol` }];
    }
  }
  const impl = row.Proxy === '1' && row.Implementation && isAddress(row.Implementation, { strict: false }) ? [{ address: getAddress(row.Implementation), name: null }] : [];
  return { abi: normalizeAbi(row.ABI), compiler: row.CompilerVersion || null, files, implementations: impl, isProxy: impl.length > 0, language: 'Solidity', name: row.ContractName || 'Contract', proxyType: impl.length ? 'EIP1967' : null, via: 'routescan' };
}

async function findVerified(c: ChainDef, a: Address): Promise<Verified | null> {
  const errors: string[] = [];
  for (const source of [fromSourcify, fromBlockscout, fromRoutescan]) {
    try {
      const v = await source(c, a);
      if (v) return v;
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  if (errors.length) throw new HttpError(502, `Verification sources unavailable: ${errors.join('; ')}`);
  return null;
}

async function loadContract(c: ChainDef, a: Address): Promise<ContractInfo> {
  const pc = client(c);
  const v = await findVerified(c, a);
  if (!v) {
    let code: Hex | undefined;
    try {
      code = await pc.getCode({ address: a });
    } catch (e) {
      throw new HttpError(502, `${c.name} RPC failed: ${rpcMessage(e)}`);
    }
    if (!code || code === '0x') throw new HttpError(400, `${a} has no contract code on ${c.name}. It is a wallet or an undeployed address.`);
    throw new HttpError(404, `The contract at ${a} on ${c.name} is not verified on Sourcify, Blockscout or Routescan, so its ABI is not public.`);
  }
  let impls = v.implementations;
  let proxyType = v.proxyType;
  if (!impls.length) {
    const slot = await pc.getStorageAt({ address: a, slot: IMPL_SLOT }).catch(() => undefined);
    if (slot && BigInt(slot) !== 0n) {
      impls = [{ address: getAddress(`0x${slot.slice(-40)}`), name: null }];
      proxyType = 'EIP1967Proxy';
    }
  }
  const implInfo = await Promise.all(
    impls.slice(0, 3).map(async (i) => {
      const iv = await findVerified(c, i.address).catch(() => null);
      return { abi: iv?.abi ?? [], address: i.address, files: iv?.files ?? [], name: iv?.name ?? i.name, verified: Boolean(iv) };
    }),
  );
  const allFiles = [...v.files, ...implInfo.flatMap((x) => x.files)];
  return {
    abi: mergeAbis(v.abi, ...implInfo.map((x) => x.abi)),
    address: a,
    chainId: c.id,
    compiler: v.compiler,
    fetchedAt: Date.now(),
    files: allFiles.map((f) => ({ bytes: f.content.length, path: f.path })).slice(0, 300),
    language: v.language,
    name: implInfo.find((x) => x.name)?.name && impls.length ? `${v.name} → ${implInfo.find((x) => x.name)?.name}` : v.name,
    proxy: { implementations: implInfo.map((x) => ({ address: x.address, name: x.name, verified: x.verified })), isProxy: impls.length > 0 || v.isProxy, type: impls.length || v.isProxy ? proxyType : null },
    signals: signalsOf(allFiles),
    verifiedVia: v.via,
  };
}

const contract = (env: Env, ctx: ExecutionContext, c: ChainDef, a: Address) => cached(env, ctx, `abi:${c.id}:${a.toLowerCase()}`, 6 * 3600, () => loadContract(c, a));

/* ---------------------------------------------------------------- functions & JSON Schema */

interface Prop {
  additionalProperties?: boolean;
  default?: unknown;
  description?: string;
  enum?: string[];
  items?: Prop;
  maxItems?: number;
  maximum?: number;
  minItems?: number;
  minimum?: number;
  pattern?: string;
  properties?: Record<string, Prop>;
  required?: string[];
  type: string;
}

const paramName = (p: AbiParam, i: number) => (p.name && /^[A-Za-z_$][\w$]*$/.test(p.name) ? p.name : `arg${i}`);

function schemaOf(p: AbiParam): Prop {
  const t = p.type;
  const description = p.internalType && p.internalType !== t ? `${t} (${p.internalType})` : t;
  const arr = /^(.*)\[(\d*)\]$/.exec(t);
  if (arr) {
    const inner = schemaOf({ ...p, internalType: undefined, type: arr[1] });
    return arr[2] ? { description, items: inner, maxItems: Number(arr[2]), minItems: Number(arr[2]), type: 'array' } : { description, items: inner, type: 'array' };
  }
  if (t === 'tuple') {
    const comps = p.components ?? [];
    return { additionalProperties: false, description, properties: Object.fromEntries(comps.map((c, i) => [paramName(c, i), schemaOf(c)])), required: comps.map(paramName), type: 'object' };
  }
  if (t === 'address') return { description, pattern: '^0x[0-9a-fA-F]{40}$', type: 'string' };
  if (t === 'bool') return { description, type: 'boolean' };
  if (t === 'string') return { description, type: 'string' };
  const n = /^(u?)int(\d*)$/.exec(t);
  if (n) {
    const bits = Number(n[2] || 256);
    if (bits <= 32) return n[1] ? { description, maximum: 2 ** bits - 1, minimum: 0, type: 'integer' } : { description, maximum: 2 ** (bits - 1) - 1, minimum: -(2 ** (bits - 1)), type: 'integer' };
    return { description: `${description}, as a decimal string`, pattern: n[1] ? '^[0-9]+$' : '^-?[0-9]+$', type: 'string' };
  }
  const b = /^bytes(\d*)$/.exec(t);
  if (b) return { description: `${description}, 0x-prefixed hex`, pattern: b[1] ? `^0x[0-9a-fA-F]{${Number(b[1]) * 2}}$` : '^0x([0-9a-fA-F]{2})*$', type: 'string' };
  return { description, type: 'string' };
}

interface Fn {
  inputs: AbiParam[];
  item: AbiItem;
  mutability: string;
  name: string;
  outputs: AbiParam[];
  selector: string;
  signature: string;
  tool: string;
}

function functionsOf(abi: AbiItem[]): Fn[] {
  const used = new Set<string>();
  return abi
    .filter((x) => x.type === 'function' && x.name)
    .map((item) => {
      const name = item.name as string;
      let tool = name.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 56) || 'fn';
      if (used.has(tool)) {
        let i = 2;
        while (used.has(`${tool}_${i}`)) i++;
        tool = `${tool}_${i}`;
      }
      used.add(tool);
      const sig = signature(item);
      return { inputs: item.inputs ?? [], item, mutability: mutability(item), name, outputs: item.outputs ?? [], selector: toFunctionSelector(sig), signature: sig, tool };
    });
}

const eventsOf = (abi: AbiItem[]) => abi.filter((x) => x.type === 'event' && x.name && !x.anonymous);

function describeFn(f: Fn) {
  return {
    description: plainEnglish(f),
    inputs: f.inputs.map((p, i) => ({ name: paramName(p, i), type: canon(p) })),
    inputSchema: { additionalProperties: false, properties: Object.fromEntries(f.inputs.map((p, i) => [paramName(p, i), schemaOf(p)])), required: f.inputs.map(paramName), type: 'object' },
    mutability: f.mutability,
    name: f.name,
    outputs: f.outputs.map((p, i) => ({ name: p.name || `out${i}`, type: canon(p) })),
    selector: f.selector,
    signature: f.signature,
    tool: f.tool,
  };
}

function pickFunction(info: ContractInfo, ref: unknown, argCount?: number): Fn {
  const s = str(ref, 'function', 300).replace(/\s+/g, '');
  const fns = functionsOf(info.abi);
  const exact = fns.find((f) => f.signature === s || f.selector === s.toLowerCase() || f.tool === s);
  if (exact) return exact;
  const named = fns.filter((f) => f.name === s);
  if (!named.length) throw new HttpError(404, `${info.name} has no function "${s}"`);
  if (named.length === 1) return named[0];
  const byArity = named.filter((f) => f.inputs.length === argCount);
  if (byArity.length === 1) return byArity[0];
  throw new HttpError(400, `"${s}" is overloaded. Pass the full signature: ${named.map((f) => f.signature).join(', ')}`);
}

/* ---------------------------------------------------------------- argument coercion */

function parseMaybeJson(v: unknown, path: string): unknown {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (!t.startsWith('[') && !t.startsWith('{')) return v;
  try {
    return JSON.parse(t);
  } catch {
    throw new HttpError(400, `${path} is not valid JSON`);
  }
}

function coerce(p: AbiParam, v: unknown, path: string): unknown {
  const t = p.type;
  const arr = /^(.*)\[(\d*)\]$/.exec(t);
  if (arr) {
    const list = parseMaybeJson(v, path);
    if (!Array.isArray(list)) throw new HttpError(400, `${path} must be an array (${t})`);
    if (arr[2] && list.length !== Number(arr[2])) throw new HttpError(400, `${path} must have exactly ${arr[2]} items`);
    if (list.length > 500) throw new HttpError(400, `${path} has too many items (max 500)`);
    return list.map((x, i) => coerce({ ...p, type: arr[1] }, x, `${path}[${i}]`));
  }
  if (t === 'tuple') {
    const obj = parseMaybeJson(v, path);
    const comps = p.components ?? [];
    if (Array.isArray(obj)) {
      if (obj.length !== comps.length) throw new HttpError(400, `${path} must have ${comps.length} fields`);
      return comps.map((c, i) => coerce(c, obj[i], `${path}.${paramName(c, i)}`));
    }
    if (!obj || typeof obj !== 'object') throw new HttpError(400, `${path} must be an object with ${comps.map(paramName).join(', ')}`);
    const rec = obj as Record<string, unknown>;
    return comps.map((c, i) => {
      const k = paramName(c, i);
      if (rec[k] === undefined) throw new HttpError(400, `${path}.${k} is required`);
      return coerce(c, rec[k], `${path}.${k}`);
    });
  }
  if (t === 'address') return addr(v, path);
  if (t === 'bool') {
    if (typeof v === 'boolean') return v;
    if (v === 'true' || v === 1 || v === '1') return true;
    if (v === 'false' || v === 0 || v === '0') return false;
    throw new HttpError(400, `${path} must be true or false`);
  }
  if (t === 'string') {
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return String(v);
    throw new HttpError(400, `${path} must be a string`);
  }
  const n = /^(u?)int(\d*)$/.exec(t);
  if (n) {
    let x: bigint;
    try {
      if (typeof v === 'number' && !Number.isSafeInteger(v)) throw new Error('unsafe');
      x = BigInt(typeof v === 'string' ? v.trim() : (v as number | bigint));
    } catch {
      throw new HttpError(400, `${path} must be an integer (${t}); pass large values as decimal strings`);
    }
    const bits = BigInt(n[2] || 256);
    const [lo, hi] = n[1] ? [0n, (1n << bits) - 1n] : [-(1n << (bits - 1n)), (1n << (bits - 1n)) - 1n];
    if (x < lo || x > hi) throw new HttpError(400, `${path} is out of range for ${t}`);
    return x;
  }
  const b = /^bytes(\d*)$/.exec(t);
  if (b) {
    if (typeof v !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(v)) throw new HttpError(400, `${path} must be 0x-prefixed hex bytes`);
    if (b[1] && v.length !== 2 + Number(b[1]) * 2) throw new HttpError(400, `${path} must be exactly ${b[1]} bytes`);
    return v;
  }
  throw new HttpError(400, `Unsupported ABI type ${t}`);
}

function argsFor(f: Fn, raw: unknown): unknown[] {
  const v = parseMaybeJson(raw ?? [], 'args');
  if (Array.isArray(v)) {
    if (v.length !== f.inputs.length) throw new HttpError(400, `${f.signature} takes ${f.inputs.length} argument(s), got ${v.length}`);
    return f.inputs.map((p, i) => coerce(p, v[i], paramName(p, i)));
  }
  if (v && typeof v === 'object') {
    const rec = v as Record<string, unknown>;
    return f.inputs.map((p, i) => {
      const k = paramName(p, i);
      if (rec[k] === undefined) throw new HttpError(400, `${k} is required`);
      return coerce(p, rec[k], k);
    });
  }
  throw new HttpError(400, 'args must be an array (positional) or an object (by parameter name)');
}

function named(outputs: AbiParam[], decoded: unknown): unknown {
  if (outputs.length <= 1) return decoded;
  const arr = decoded as unknown[];
  return Object.fromEntries(outputs.map((o, i) => [o.name || `out${i}`, arr[i]]));
}

/* ---------------------------------------------------------------- calls, simulation, events */

async function readFn(c: ChainDef, info: ContractInfo, f: Fn, args: unknown[]) {
  if (!isRead(f.item)) throw new HttpError(400, `${f.signature} changes state. Use simulate to build the transaction.`);
  const abi = [f.item] as Abi;
  const data = encodeFunctionData({ abi, args, functionName: f.name });
  let out: Hex | undefined;
  try {
    out = (await client(c).call({ data, to: info.address })).data;
  } catch (e) {
    throw new HttpError(400, `Call reverted: ${rpcMessage(e)}`);
  }
  if (!out || out === '0x') throw new HttpError(400, `${f.signature} returned no data`);
  const decoded = decodeFunctionResult({ abi, data: out, functionName: f.name });
  return { block: null, chainId: c.id, function: f.signature, result: named(f.outputs, decoded) };
}

async function simulateFn(c: ChainDef, info: ContractInfo, f: Fn, args: unknown[], value: unknown, from: unknown, user: User) {
  if (isRead(f.item)) throw new HttpError(400, `${f.signature} is read-only. Use read instead.`);
  let account: Address;
  if (from !== undefined && from !== '') account = addr(from, 'from');
  else if (user.chain === 'evm') account = getAddress(user.address);
  else throw new HttpError(400, 'from is required: you are signed in with a Solana wallet, so pass the EVM address that would send this transaction');
  let wei = 0n;
  if (value !== undefined && value !== '' && value !== null) {
    try {
      wei = BigInt(String(value));
    } catch {
      throw new HttpError(400, 'value must be an integer amount of wei');
    }
    if (wei < 0n) throw new HttpError(400, 'value must not be negative');
    if (wei > 0n && f.mutability !== 'payable') throw new HttpError(400, `${f.signature} is not payable; value must be 0`);
  }
  const abi = [f.item] as Abi;
  const data = encodeFunctionData({ abi, args, functionName: f.name });
  const pc = client(c);
  const tx = { chainId: c.id, data, from: account, to: info.address, value: `0x${wei.toString(16)}` };
  let simulation: { error?: string; gas?: string; result?: unknown; success: boolean };
  try {
    const r = await pc.call({ account, data, to: info.address, value: wei });
    const decoded = r.data && r.data !== '0x' && f.outputs.length ? decodeFunctionResult({ abi, data: r.data, functionName: f.name }) : null;
    const gas = await pc.estimateGas({ account, data, to: info.address, value: wei }).catch(() => null);
    simulation = { gas: gas?.toString(), result: decoded === null ? null : named(f.outputs, decoded), success: true };
  } catch (e) {
    simulation = { error: rpcMessage(e), success: false };
  }
  return { chain: c.name, function: f.signature, note: 'Unsigned transaction. Nothing was sent; sign it with the from wallet to execute.', simulation, tx };
}

interface DecodedLog {
  args?: Record<string, unknown> | unknown[];
  blockNumber: bigint | null;
  eventName?: string;
  logIndex: number | null;
  transactionHash: Hex | null;
}

async function eventsFor(c: ChainDef, info: ContractInfo, eventName: unknown, blocks: unknown, limit: unknown) {
  const all = eventsOf(info.abi);
  if (!all.length) throw new HttpError(400, `${info.name} declares no events in its ABI`);
  let pick = all;
  if (eventName !== undefined && eventName !== '') {
    const e = String(eventName).replace(/\s+/g, '');
    pick = all.filter((x) => x.name === e || signature(x) === e);
    if (!pick.length) throw new HttpError(404, `No event "${e}". Events: ${all.map((x) => x.name).join(', ')}`);
  }
  const span = int(blocks, 'blocks', 1, 2000, 200);
  const max = int(limit, 'limit', 1, 200, 50);
  const pc = client(c);
  let head: bigint;
  try {
    head = await pc.getBlockNumber();
  } catch (e) {
    throw new HttpError(502, `${c.name} RPC failed: ${rpcMessage(e)}`);
  }
  const ranges: [bigint, bigint][] = [];
  for (let to = head; to > head - BigInt(span) && to >= 0n; to -= BigInt(LOG_CHUNK)) {
    const lo = to - BigInt(LOG_CHUNK) + 1n;
    const floor = head - BigInt(span) + 1n;
    ranges.push([lo < floor ? floor : lo < 0n ? 0n : lo, to]);
  }
  const logs: DecodedLog[] = [];
  let scanned = 0;
  for (let i = 0; i < ranges.length && logs.length < max; i += 4) {
    const batch = ranges.slice(i, i + 4);
    const results = await Promise.all(
      batch.map(([fromBlock, toBlock]) =>
        pc.getLogs({ address: info.address, events: pick as AbiEvent[], fromBlock, strict: false, toBlock }).catch((e: unknown) => {
          throw new HttpError(502, `eth_getLogs failed on ${c.name}: ${rpcMessage(e)}`);
        }),
      ),
    );
    for (const r of results) logs.push(...(r as unknown as DecodedLog[]));
    scanned += batch.reduce((s, [a, b]) => s + Number(b - a + 1n), 0);
  }
  logs.sort((a, b) => Number((b.blockNumber ?? 0n) - (a.blockNumber ?? 0n)) || (b.logIndex ?? 0) - (a.logIndex ?? 0));
  return {
    blocksScanned: scanned,
    chain: c.name,
    events: logs.slice(0, max).map((l) => ({ args: l.args ?? {}, block: l.blockNumber?.toString() ?? null, event: l.eventName ?? null, logIndex: l.logIndex, tx: l.transactionHash })),
    fromBlock: (head - BigInt(Math.min(scanned, span)) + 1n).toString(),
    toBlock: head.toString(),
    truncated: logs.length > max,
  };
}

async function zeroArgState(c: ChainDef, info: ContractInfo, max = 24) {
  const fns = functionsOf(info.abi).filter((f) => isRead(f.item) && !f.inputs.length && f.outputs.length).slice(0, max);
  if (!fns.length) return [];
  const results = await client(c)
    .multicall({ allowFailure: true, contracts: fns.map((f) => ({ abi: [f.item] as Abi, address: info.address, functionName: f.name })) })
    .catch(() => fns.map(() => ({ error: new Error('multicall failed'), status: 'failure' as const })));
  return fns.map((f, i) => {
    const r = results[i] as { result?: unknown; status: 'failure' | 'success' };
    return { function: f.name, ok: r.status === 'success', type: f.outputs.map(canon).join(','), value: r.status === 'success' ? JSON.parse(JSON.stringify(named(f.outputs, r.result), bigintSafe)) : null };
  });
}

/* ---------------------------------------------------------------- security scan */

type Severity = 'critical' | 'high' | 'low' | 'medium';
interface Finding {
  detail: string;
  functions?: string[];
  id: string;
  penalty: number;
  severity: Severity;
  title: string;
}

const ADMIN_RULES: { admin: boolean; detail: string; id: string; penalty: number; re: RegExp; severity: Severity; title: string }[] = [
  { admin: true, detail: 'A privileged role can create new tokens and dilute holders. The ABI cannot show who may call it: check the access control.', id: 'mint', penalty: 14, re: /^(mint|mintTo|mintFor|_mint|issue|mintTokens)$/i, severity: 'high', title: 'Supply can be increased' },
  { admin: true, detail: 'An address can be blocked from transferring or interacting.', id: 'blacklist', penalty: 15, re: /(blacklist|blocklist|denylist|blockAccount|freeze|setBot|addBot|isBot)/i, severity: 'high', title: 'Accounts can be blacklisted or frozen' },
  { admin: true, detail: 'Transfers or core operations can be halted by a privileged role.', id: 'pause', penalty: 8, re: /^(pause|unpause|setPaused|togglePause|setPause)$/i, severity: 'medium', title: 'Contract can be paused' },
  { admin: true, detail: 'Fees or taxes on transfers or swaps can be changed after deployment.', id: 'fees', penalty: 10, re: /^(set|update|change)\w*(fee|tax)\w*$/i, severity: 'medium', title: 'Fees are adjustable' },
  { admin: true, detail: 'Trading can be switched on or off, or per-transaction and per-wallet limits can be changed. Common in honeypot tokens.', id: 'limits', penalty: 10, re: /(maxTx|maxWallet|maxTransaction|setMaxTx|setMaxWallet|enableTrading|setTradingEnabled|openTrading|setSwapEnabled|tradingActive)/i, severity: 'medium', title: 'Trading limits or a trading switch' },
  { admin: true, detail: 'The contract logic can be replaced, so any behaviour can change after you interact.', id: 'upgrade', penalty: 12, re: /^(upgradeTo|upgradeToAndCall|changeImplementation|setImplementation|upgrade)$/i, severity: 'high', title: 'Upgradeable logic' },
  { admin: true, detail: 'A privileged role can move funds or tokens held by the contract.', id: 'withdraw', penalty: 6, re: /^(emergencyWithdraw|rescueTokens|rescueETH|sweep|sweepToken|recoverERC20|recoverTokens|withdrawStuck\w*|clearStuck\w*|withdrawETH|adminWithdraw)$/i, severity: 'medium', title: 'Privileged withdrawal' },
  { admin: true, detail: 'Specific accounts can be exempted from fees, limits or rewards.', id: 'exclusions', penalty: 4, re: /^(excludeFrom\w+|includeIn\w+|setExcluded\w*|setIsExcluded\w*|whitelist\w*)$/i, severity: 'low', title: 'Per-account exemptions' },
];

async function scan(env: Env, ctx: ExecutionContext, c: ChainDef, a: Address) {
  return cached(env, ctx, `scan:${c.id}:${a.toLowerCase()}`, 600, async () => {
    const info = await contract(env, ctx, c, a);
    const fns = functionsOf(info.abi);
    const writes = fns.filter((f) => !isRead(f.item));
    const findings: Finding[] = [];
    const positives: string[] = [];
    const pc = client(c);

    let owner: { address: Address | null; isContract: boolean; renounced: boolean } | null = null;
    const ownerFn = fns.find((f) => (f.name === 'owner' || f.name === 'getOwner') && !f.inputs.length && f.outputs[0]?.type === 'address');
    if (ownerFn) {
      const o = await readFn(c, info, ownerFn, []).catch(() => null);
      if (o && typeof o.result === 'string') {
        const oa = getAddress(o.result);
        const code = oa === ZERO ? '0x' : await pc.getCode({ address: oa }).catch(() => '0x');
        owner = { address: oa, isContract: Boolean(code && code !== '0x'), renounced: oa === ZERO };
      }
    }
    const renounced = owner?.renounced === true;

    for (const rule of ADMIN_RULES) {
      const hit = writes.filter((f) => rule.re.test(f.name)).map((f) => f.signature);
      if (rule.id === 'upgrade' && info.proxy.isProxy && !hit.length) hit.push(`${info.proxy.type ?? 'proxy'} → ${info.proxy.implementations.map((x) => x.name ?? x.address).join(', ') || 'implementation'}`);
      if (!hit.length) continue;
      const softened = renounced && rule.admin && rule.id !== 'upgrade';
      findings.push({
        detail: softened ? `${rule.detail} Ownership is renounced, so owner-only versions of these functions can no longer be called.` : rule.detail,
        functions: hit.slice(0, 12),
        id: rule.id,
        penalty: softened ? Math.ceil(rule.penalty / 3) : rule.penalty,
        severity: softened ? 'low' : rule.severity,
        title: rule.title,
      });
    }

    const s = info.signals;
    if (s.selfdestruct) findings.push({ detail: `selfdestruct appears ${s.selfdestruct} time(s) in the project source. The contract (or its logic) can be destroyed and its balance sent elsewhere.`, id: 'selfdestruct', penalty: 25, severity: 'critical', title: 'selfdestruct in source' });
    if (s.delegatecall && !info.proxy.isProxy) findings.push({ detail: `delegatecall appears ${s.delegatecall} time(s). Code from another address runs with this contract's storage and balance.`, id: 'delegatecall', penalty: 10, severity: 'high', title: 'delegatecall outside a proxy' });
    if (s.txOrigin) findings.push({ detail: `tx.origin is used ${s.txOrigin} time(s). Authorising with tx.origin lets phishing contracts act on behalf of users.`, id: 'tx-origin', penalty: 8, severity: 'medium', title: 'tx.origin used' });
    const major = /(\d+)\.(\d+)\.(\d+)/.exec(info.compiler ?? '');
    if (major && Number(major[1]) === 0 && Number(major[2]) < 8 && info.language !== 'Vyper') findings.push({ detail: `Compiled with Solidity ${major[0]}, which has no built-in overflow checks. Safe only if SafeMath is used everywhere.`, id: 'old-compiler', penalty: 6, severity: 'medium', title: 'Pre-0.8 compiler' });
    if (s.lowLevelCall && !s.nonReentrant && writes.some((f) => f.mutability === 'payable' || /withdraw|claim|redeem/i.test(f.name))) findings.push({ detail: `Low-level calls appear ${s.lowLevelCall} time(s) and no nonReentrant modifier is used. Check that state changes happen before external calls.`, id: 'reentrancy', penalty: 5, severity: 'low', title: 'No reentrancy guard on value paths' });
    if (s.blockTimestamp) findings.push({ detail: `block.timestamp is used ${s.blockTimestamp} time(s). Validators can shift it by a few seconds; fine for deadlines, risky for randomness.`, id: 'timestamp', penalty: 2, severity: 'low', title: 'Timestamp dependence' });
    if (s.unchecked) findings.push({ detail: `${s.unchecked} unchecked block(s) skip overflow checks. Usually a gas optimisation; each needs a reason.`, id: 'unchecked', penalty: 2, severity: 'low', title: 'unchecked arithmetic' });
    if (owner && !renounced && !owner.isContract && findings.some((f) => ADMIN_RULES.some((r) => r.id === f.id))) findings.push({ detail: `The owner ${owner.address} is a single externally owned account, so one private key controls the admin functions above.`, id: 'eoa-owner', penalty: 6, severity: 'medium', title: 'Single-key owner' });

    positives.push(`Source verified on ${info.verifiedVia === 'sourcify' ? 'Sourcify' : info.verifiedVia === 'blockscout' ? 'Blockscout' : 'Routescan'}`);
    if (s.openZeppelin) positives.push(`Uses OpenZeppelin libraries (${s.openZeppelin} file${s.openZeppelin === 1 ? '' : 's'})`);
    if (s.nonReentrant) positives.push('Reentrancy guard (nonReentrant) in use');
    if (major && (Number(major[1]) > 0 || Number(major[2]) >= 8)) positives.push(`Solidity ${major[0]} with checked arithmetic`);
    if (renounced) positives.push('Ownership renounced (owner is the zero address)');
    if (owner?.isContract && !renounced) positives.push(`Owner is a contract (${owner.address}), such as a multisig or timelock`);
    if (!info.proxy.isProxy) positives.push('Not upgradeable: the code cannot change');
    if (!s.selfdestruct && !s.txOrigin) positives.push('No selfdestruct or tx.origin in project source');

    const order: Severity[] = ['critical', 'high', 'medium', 'low'];
    findings.sort((x, y) => order.indexOf(x.severity) - order.indexOf(y.severity) || y.penalty - x.penalty);
    const score = Math.max(0, 100 - findings.reduce((t, f) => t + f.penalty, 0));
    return {
      address: a,
      chain: c.name,
      chainId: c.id,
      counts: Object.fromEntries(order.map((k) => [k, findings.filter((f) => f.severity === k).length])),
      findings,
      grade: score >= 85 ? 'Low risk' : score >= 65 ? 'Moderate risk' : score >= 40 ? 'High risk' : 'Critical risk',
      name: info.name,
      owner,
      positives,
      proxy: info.proxy,
      scannedAt: Date.now(),
      score,
      signals: info.signals,
    };
  });
}

/* ---------------------------------------------------------------- whisperer */

const KNOWN: Record<string, string> = {
  allowance: 'How many tokens a spender may still move for an owner',
  approve: 'Let a spender move up to an amount of your tokens',
  balanceOf: 'Balance held by an account',
  borrow: 'Borrow an asset against your supplied collateral',
  burn: 'Destroy tokens and reduce supply',
  decimals: 'Number of decimal places the token uses',
  deposit: 'Deposit assets into the contract',
  factory: 'Address of the factory that created the pools',
  flashLoan: 'Borrow and repay within one transaction',
  getApproved: 'Address approved to move one NFT',
  getReserves: 'Current pool reserves',
  isApprovedForAll: 'Whether an operator may move all of an owner’s tokens',
  liquidationCall: 'Liquidate an undercollateralised position',
  mint: 'Create new tokens',
  name: 'Human-readable name',
  owner: 'Current admin address',
  ownerOf: 'Owner of one NFT',
  pause: 'Halt the contract',
  paused: 'Whether the contract is paused',
  renounceOwnership: 'Give up admin rights for good',
  repay: 'Repay borrowed assets',
  safeTransferFrom: 'Transfer a token, checking the receiver can accept it',
  setApprovalForAll: 'Let an operator move all your tokens',
  supply: 'Supply an asset to earn interest and use as collateral',
  symbol: 'Ticker symbol',
  tokenURI: 'Metadata URL for one NFT',
  totalSupply: 'Total tokens in existence',
  transfer: 'Send tokens from your wallet',
  transferFrom: 'Move tokens on behalf of an owner who approved you',
  transferOwnership: 'Hand admin rights to a new address',
  unpause: 'Resume the contract',
  upgradeTo: 'Replace the contract logic',
  uri: 'Metadata URL template',
  withdraw: 'Withdraw assets from the contract',
  WETH: 'Wrapped native token address used for routing',
};

function plainEnglish(f: Fn): string {
  if (KNOWN[f.name]) return KNOWN[f.name];
  if (/^swapExact(\w+)For(\w+)/.test(f.name)) return 'Swap an exact input amount along a path, with a minimum output';
  if (/^swap(\w+)ForExact(\w+)/.test(f.name)) return 'Swap for an exact output amount, with a maximum input';
  if (/^addLiquidity/.test(f.name)) return 'Add liquidity to a pool and receive LP tokens';
  if (/^removeLiquidity/.test(f.name)) return 'Burn LP tokens and withdraw the underlying assets';
  if (/^get(Amounts?)(Out|In)$/.test(f.name)) return 'Quote swap amounts along a path';
  const words = f.name.replace(/^_+/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
  if (isRead(f.item)) return f.inputs.length ? `Look up ${words.replace(/^(get|is|has) /, '')} for the given input` : `Read ${words.replace(/^get /, '')}`;
  return f.mutability === 'payable' ? `${words.charAt(0).toUpperCase()}${words.slice(1)} (accepts ${'native currency'})` : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

function detectKind(fns: Fn[]): { kind: string; standards: string[] } {
  const has = (...n: string[]) => n.every((x) => fns.some((f) => f.name === x));
  const any = (re: RegExp) => fns.some((f) => re.test(f.name));
  const standards: string[] = [];
  if (has('totalSupply', 'balanceOf', 'transfer', 'transferFrom', 'approve', 'allowance')) standards.push('ERC-20');
  if (has('ownerOf', 'safeTransferFrom', 'setApprovalForAll', 'getApproved')) standards.push('ERC-721');
  if (has('balanceOfBatch', 'safeBatchTransferFrom', 'setApprovalForAll')) standards.push('ERC-1155');
  if (has('asset', 'convertToShares', 'convertToAssets', 'deposit', 'redeem')) standards.push('ERC-4626');
  if (has('permit', 'nonces', 'DOMAIN_SEPARATOR')) standards.push('ERC-2612 permit');
  if (has('supportsInterface')) standards.push('ERC-165');
  if (has('execTransaction', 'getThreshold', 'getOwners')) return { kind: 'Safe multisig wallet', standards };
  if (any(/^swapExact\w+For\w+/) && any(/^addLiquidity/)) return { kind: 'DEX router', standards };
  if (has('borrow', 'repay') && (has('supply') || has('deposit')) && any(/^liquidat/i)) return { kind: 'lending pool', standards };
  if (standards.includes('ERC-4626')) return { kind: 'tokenized vault', standards };
  if (has('propose', 'castVote')) return { kind: 'governor', standards };
  if (standards.includes('ERC-1155')) return { kind: 'multi-token (ERC-1155) collection', standards };
  if (standards.includes('ERC-721')) return { kind: 'NFT collection', standards };
  if (standards.includes('ERC-20')) return { kind: has('deposit', 'withdraw') && fns.some((f) => f.name === 'deposit' && f.mutability === 'payable') ? 'wrapped native token' : 'ERC-20 token', standards };
  if (has('stake') && (has('withdraw') || has('unstake'))) return { kind: 'staking contract', standards };
  if (has('getReserves', 'token0', 'token1')) return { kind: 'liquidity pool', standards };
  return { kind: 'smart contract', standards };
}

async function explain(env: Env, ctx: ExecutionContext, c: ChainDef, a: Address) {
  return cached(env, ctx, `explain:${c.id}:${a.toLowerCase()}`, 300, async () => {
    const info = await contract(env, ctx, c, a);
    const fns = functionsOf(info.abi);
    const { kind, standards } = detectKind(fns);
    const state = await zeroArgState(c, info);
    const val = (n: string) => state.find((s) => s.function === n && s.ok)?.value;
    const reads = fns.filter((f) => isRead(f.item));
    const writes = fns.filter((f) => !isRead(f.item));
    const admin = writes.filter((f) => ADMIN_RULES.some((r) => r.re.test(f.name)) || /^(set|grantRole|revokeRole|transferOwnership|renounceOwnership|initialize)/.test(f.name));
    const user = writes.filter((f) => !admin.includes(f));
    const parts: string[] = [];
    const article = /^[aeiou]/i.test(kind) || /^ERC/.test(kind) ? 'an' : 'a';
    parts.push(`${info.name} is ${article} ${kind} on ${c.name}${standards.length ? ` implementing ${standards.join(', ')}` : ''}.`);
    const sym = val('symbol');
    const dec = val('decimals');
    const supply = val('totalSupply');
    if (standards.includes('ERC-20') && typeof supply === 'string') {
      const d = typeof dec === 'number' ? dec : Number(dec ?? 18);
      parts.push(`Its total supply is ${Number(formatUnits(BigInt(supply), d)).toLocaleString('en-US', { maximumFractionDigits: 2 })} ${typeof sym === 'string' ? sym : 'tokens'} with ${d} decimals.`);
    } else if (standards.includes('ERC-721') && typeof supply === 'string') parts.push(`${Number(supply).toLocaleString('en-US')} tokens have been minted${typeof sym === 'string' ? ` under the symbol ${sym}` : ''}.`);
    if (kind === 'DEX router') parts.push('You use it to swap tokens along a path of pools and to add or remove liquidity. Every swap takes a minimum-output (slippage) bound and a deadline.');
    if (kind === 'lending pool') parts.push('Users supply assets to earn interest, borrow against that collateral, repay, and liquidate unhealthy positions.');
    if (kind === 'wrapped native token') parts.push(`Send ${c.currency} to deposit() to get the wrapped ERC-20 token 1:1, and withdraw() to unwrap.`);
    if (info.proxy.isProxy) parts.push(`It is an upgradeable proxy (${info.proxy.type ?? 'proxy'}); the logic currently lives at ${info.proxy.implementations.map((x) => `${x.address}${x.name ? ` (${x.name})` : ''}`).join(', ') || 'an unresolved implementation'}.`);
    const own = val('owner');
    if (typeof own === 'string') parts.push(own === ZERO ? 'Ownership has been renounced.' : `It has an owner, ${own}.`);
    if (val('paused') === true) parts.push('It is currently paused.');
    parts.push(`The ABI has ${reads.length} read function${reads.length === 1 ? '' : 's'}, ${writes.length} write function${writes.length === 1 ? '' : 's'}${admin.length ? ` (${admin.length} admin)` : ''} and ${eventsOf(info.abi).length} event${eventsOf(info.abi).length === 1 ? '' : 's'}.`);
    const brief = (f: Fn) => ({ description: plainEnglish(f), name: f.name, signature: f.signature });
    return {
      address: a,
      admin: admin.slice(0, 40).map(brief),
      chain: c.name,
      events: eventsOf(info.abi).slice(0, 40).map((e) => ({ name: e.name, signature: signature(e) })),
      kind,
      name: info.name,
      proxy: info.proxy,
      reads: reads.slice(0, 60).map(brief),
      standards,
      state,
      summary: parts.join(' '),
      writes: user.slice(0, 60).map(brief),
    };
  });
}

/* ---------------------------------------------------------------- code generation (FastMCP server) */

const PY_KEYWORDS = new Set('False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield'.split(' '));
const snake = (s: string) => {
  const out = s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1').toLowerCase();
  return PY_KEYWORDS.has(out) ? `${out}_` : out || 'arg';
};
function pyType(p: AbiParam): string {
  if (p.type.endsWith(']')) return 'list';
  if (p.type === 'tuple') return 'dict | list';
  if (p.type === 'bool') return 'bool';
  if (/^u?int/.test(p.type)) return 'int | str';
  return 'str';
}

function generateServer(c: ChainDef, info: ContractInfo) {
  const fns = functionsOf(info.abi);
  const used = new Set<string>(['mcp', 'contract', 'w3']);
  const tools = fns.map((f) => {
    let py = snake(f.name);
    if (used.has(py)) {
      let i = 2;
      while (used.has(`${py}_${i}`)) i++;
      py = `${py}_${i}`;
    }
    used.add(py);
    const names = f.inputs.map((p, i) => snake(paramName(p, i)));
    const params = f.inputs.map((p, i) => `${names[i]}: ${pyType(p)}`);
    const read = isRead(f.item);
    const desc = `${plainEnglish(f)}. ${f.signature} (${f.mutability})${f.outputs.length ? ` -> ${f.outputs.map(canon).join(', ')}` : ''}`.replace(/"/g, "'");
    if (read) return `@mcp.tool()\ndef ${py}(${params.join(', ')}) -> str:\n    """${desc}"""\n    return _read("${f.signature}", [${names.join(', ')}])\n`;
    const extra = [...params, 'sender: str = ""', ...(f.mutability === 'payable' ? ['value_wei: int = 0'] : []), 'send: bool = False'];
    return `@mcp.tool()\ndef ${py}(${extra.join(', ')}) -> str:\n    """${desc}. Builds the transaction; with PRIVATE_KEY set and send=True it signs and broadcasts."""\n    return _write("${f.signature}", [${names.join(', ')}], sender, ${f.mutability === 'payable' ? 'value_wei' : '0'}, send)\n`;
  });
  const title = info.name.replace(/[^\w .→-]/g, '').slice(0, 60) || 'Contract';
  const server = `"""MCP server for ${title} on ${c.name} (${info.address}).

Generated by UCAI Cloud (https://ucai.ninabrekkerese.workers.dev) from the verified ABI.
Read functions call the chain directly. Write functions return an unsigned
transaction, or sign and send it when PRIVATE_KEY is set and send=True.
"""
import json
import os

from fastmcp import FastMCP
from web3 import Web3

RPC_URL = os.environ.get("RPC_URL", "${c.rpc}")
CHAIN_ID = ${c.id}
CONTRACT_ADDRESS = Web3.to_checksum_address("${info.address}")
ABI = json.loads(${JSON.stringify(JSON.stringify(info.abi))})

w3 = Web3(Web3.HTTPProvider(RPC_URL))
contract = w3.eth.contract(address=CONTRACT_ADDRESS, abi=ABI)
mcp = FastMCP(${JSON.stringify(title)})


def _jsonable(value):
    if isinstance(value, (bytes, bytearray)):
        return "0x" + bytes(value).hex()
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    if isinstance(value, dict):
        return {k: _jsonable(v) for k, v in value.items()}
    if isinstance(value, int) and not isinstance(value, bool) and abs(value) > 2**53:
        return str(value)
    return value


def _coerce(value, param):
    kind = param["type"]
    if kind.endswith("]"):
        inner = dict(param, type=kind[: kind.rindex("[")])
        items = json.loads(value) if isinstance(value, str) else value
        return [_coerce(v, inner) for v in items]
    if kind == "tuple":
        comps = param.get("components", [])
        data = json.loads(value) if isinstance(value, str) else value
        if isinstance(data, dict):
            return tuple(_coerce(data[c["name"] or f"arg{i}"], c) for i, c in enumerate(comps))
        return tuple(_coerce(v, c) for v, c in zip(data, comps))
    if kind == "address":
        return Web3.to_checksum_address(value)
    if kind.startswith(("uint", "int")):
        return int(value)
    if kind == "bool":
        return value if isinstance(value, bool) else str(value).lower() in ("true", "1")
    if kind.startswith("bytes"):
        return bytes.fromhex(value[2:] if value.startswith("0x") else value)
    return value


def _fn(signature, args):
    fn = contract.get_function_by_signature(signature)
    return fn(*[_coerce(a, p) for a, p in zip(args, fn.abi["inputs"])])


def _read(signature, args):
    return json.dumps(_jsonable(_fn(signature, args).call()))


def _write(signature, args, sender, value_wei, send):
    key = os.environ.get("PRIVATE_KEY")
    account = w3.eth.account.from_key(key) if key else None
    sender = Web3.to_checksum_address(sender) if sender else (account.address if account else None)
    if sender is None:
        raise ValueError("Pass sender, or set PRIVATE_KEY")
    tx = _fn(signature, args).build_transaction({"chainId": CHAIN_ID, "from": sender, "value": int(value_wei), "nonce": w3.eth.get_transaction_count(sender)})
    if not send:
        return json.dumps(_jsonable(dict(tx)))
    if account is None or account.address != sender:
        raise ValueError("send=True needs PRIVATE_KEY for the sender address")
    signed = account.sign_transaction(tx)
    return json.dumps({"hash": "0x" + w3.eth.send_raw_transaction(signed.raw_transaction).hex()})


${tools.join('\n\n')}

if __name__ == "__main__":
    mcp.run()
`;
  const readme = `# ${title} MCP server

Generated by UCAI Cloud from the verified ABI of \`${info.address}\` on ${c.name} (chain ${c.id}).
It exposes ${fns.length} tools: ${fns.filter((f) => isRead(f.item)).length} reads and ${fns.filter((f) => !isRead(f.item)).length} writes.

## Run

\`\`\`bash
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
python server.py
\`\`\`

\`RPC_URL\` overrides the default RPC (${c.rpc}). Write tools return an unsigned transaction.
To sign and broadcast, set \`PRIVATE_KEY\` in the environment and call the tool with \`send=true\`.

## Claude Desktop

\`\`\`json
{
  "mcpServers": {
    "${snake(title).slice(0, 40)}": {
      "command": "python",
      "args": ["/absolute/path/to/server.py"],
      "env": { "RPC_URL": "${c.rpc}" }
    }
  }
}
\`\`\`
`;
  return { files: [{ content: server, name: 'server.py' }, { content: 'fastmcp>=2.3\nweb3>=7.0\n', name: 'requirements.txt' }, { content: readme, name: 'README.md' }], tools: fns.length };
}

/* ---------------------------------------------------------------- saved contracts */

interface SavedRow {
  abi: string;
  address: string;
  chain_id: number;
  created_at: number;
  id: string;
  name: string;
}

const savedView = (r: SavedRow) => {
  const c = CHAINS.find((x) => x.id === r.chain_id);
  const abi = JSON.parse(r.abi) as AbiItem[];
  const fns = functionsOf(abi);
  return { address: r.address, chain: c?.name ?? String(r.chain_id), chainId: r.chain_id, createdAt: r.created_at, events: eventsOf(abi).length, id: r.id, mcpPath: `/mcp/${r.id}`, name: r.name, reads: fns.filter((f) => isRead(f.item)).length, writes: fns.filter((f) => !isRead(f.item)).length };
};

async function savedRow(env: Env, user: User, id: string): Promise<SavedRow> {
  const row = await env.DB.prepare('SELECT * FROM contracts WHERE id = ? AND user_id = ?').bind(id, user.id).first<SavedRow>();
  if (!row) throw new HttpError(404, 'Saved contract not found');
  return row;
}

async function saveContract(env: Env, ctx: ExecutionContext, user: User, a: Record<string, unknown>) {
  const c = chainOf(a.chain);
  const address = addr(a.address);
  const info = await contract(env, ctx, c, address);
  const name = a.name === undefined || a.name === '' ? info.name.slice(0, 80) : str(a.name, 'name', 80);
  const existing = await env.DB.prepare('SELECT * FROM contracts WHERE user_id = ? AND chain_id = ? AND address = ?').bind(user.id, c.id, address).first<SavedRow>();
  if (existing) {
    await env.DB.prepare('UPDATE contracts SET name = ?, abi = ? WHERE id = ?').bind(name, JSON.stringify(info.abi), existing.id).run();
    return savedView({ ...existing, abi: JSON.stringify(info.abi), name });
  }
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM contracts WHERE user_id = ?').bind(user.id).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_SAVED) throw new HttpError(409, `You can save up to ${MAX_SAVED} contracts. Delete one first.`);
  const row: SavedRow = { abi: JSON.stringify(info.abi), address, chain_id: c.id, created_at: Date.now(), id: `c${crypto.randomUUID().replace(/-/g, '').slice(0, 15)}`, name };
  await env.DB.prepare('INSERT INTO contracts (id, user_id, chain_id, address, name, abi, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(row.id, user.id, row.chain_id, row.address, row.name, row.abi, row.created_at).run();
  return savedView(row);
}

const savedInfo = (r: SavedRow): ContractInfo => ({ abi: JSON.parse(r.abi) as AbiItem[], address: getAddress(r.address), chainId: r.chain_id, compiler: null, fetchedAt: r.created_at, files: [], language: null, name: r.name, proxy: { implementations: [], isProxy: false, type: null }, signals: {}, verifiedVia: 'sourcify' });

/* ---------------------------------------------------------------- tools */

interface ToolCtx {
  ctx: ExecutionContext;
  env: Env;
  user: User;
}

interface Tool {
  description: string;
  group: string;
  name: string;
  params: Record<string, Prop>;
  required: string[];
  run: (a: Record<string, unknown>, c: ToolCtx) => Promise<unknown>;
  title: string;
}

const P = {
  address: { description: 'Contract address (0x…)', pattern: '^0x[0-9a-fA-F]{40}$', type: 'string' },
  args: { description: 'Arguments: a JSON array in ABI order, or an object keyed by parameter name. Pass uint256 values as decimal strings.', type: 'array' },
  chain: { description: `Chain slug or id: ${CHAINS.map((x) => `${x.slug} (${x.id})`).join(', ')}`, enum: CHAINS.map((x) => x.slug), type: 'string' },
  function: { description: 'Function name, full signature such as transfer(address,uint256), or 4-byte selector', type: 'string' },
} satisfies Record<string, Prop>;

async function target(a: Record<string, unknown>, { ctx, env }: ToolCtx) {
  const c = chainOf(a.chain);
  const address = addr(a.address);
  return { c, info: await contract(env, ctx, c, address) };
}

const abiSummary = (c: ChainDef, info: ContractInfo) => ({
  address: info.address,
  chain: c.name,
  chainId: c.id,
  compiler: info.compiler,
  events: eventsOf(info.abi).map((e) => signature(e)),
  explorer: `${c.explorer}/address/${info.address}`,
  fetchedAt: info.fetchedAt,
  functions: functionsOf(info.abi).map(describeFn),
  language: info.language,
  name: info.name,
  proxy: info.proxy,
  sourceFiles: info.files.length,
  verifiedVia: info.verifiedVia,
});

const TOOLS: Tool[] = [
  {
    description: 'Fetches the verified ABI of a contract (Sourcify, then Blockscout, then Routescan), follows proxies to their implementation, and returns every function as an MCP-ready tool with a JSON Schema.',
    group: 'Contracts', name: 'fetch_abi', params: { address: P.address, chain: P.chain }, required: ['chain', 'address'], title: 'Fetch ABI',
    run: async (a, t) => {
      const { c, info } = await target(a, t);
      return abiSummary(c, info);
    },
  },
  {
    description: 'Security scan: checks the ABI for admin powers (mint, pause, blacklist, fee changes, trading switches, upgrades, privileged withdrawals), the verified source for selfdestruct, delegatecall, tx.origin and other patterns, and reads the live owner. Returns a 0–100 score with findings.',
    group: 'Contracts', name: 'scan_contract', params: { address: P.address, chain: P.chain }, required: ['chain', 'address'], title: 'Security scan',
    run: async (a, { ctx, env }) => scan(env, ctx, chainOf(a.chain), addr(a.address)),
  },
  {
    description: 'Explains a contract in plain English: what kind of contract it is, which standards it implements, its live state (every zero-argument view function), and what each read, write and admin function does.',
    group: 'Contracts', name: 'explain_contract', params: { address: P.address, chain: P.chain }, required: ['chain', 'address'], title: 'Explain contract',
    run: async (a, { ctx, env }) => explain(env, ctx, chainOf(a.chain), addr(a.address)),
  },
  {
    description: 'Calls a read-only (view or pure) function on a verified contract and decodes the result.',
    group: 'Calls', name: 'read_contract', params: { address: P.address, args: P.args, chain: P.chain, function: P.function }, required: ['chain', 'address', 'function'], title: 'Read contract',
    run: async (a, t) => {
      const { c, info } = await target(a, t);
      const raw = parseMaybeJson(a.args ?? [], 'args');
      const f = pickFunction(info, a.function, Array.isArray(raw) ? raw.length : undefined);
      return readFn(c, info, f, argsFor(f, raw));
    },
  },
  {
    description: 'Simulates a state-changing function with eth_call from your wallet (or from), estimates gas, and returns the unsigned transaction (to, data, value) ready to sign. Nothing is sent.',
    group: 'Calls', name: 'simulate_write', params: { address: P.address, args: P.args, chain: P.chain, from: { description: 'Sender address. Defaults to your signed-in EVM wallet.', type: 'string' }, function: P.function, value: { description: 'Native value in wei (payable functions only)', type: 'string' } }, required: ['chain', 'address', 'function'], title: 'Simulate write',
    run: async (a, t) => {
      const { c, info } = await target(a, t);
      const raw = parseMaybeJson(a.args ?? [], 'args');
      const f = pickFunction(info, a.function, Array.isArray(raw) ? raw.length : undefined);
      return simulateFn(c, info, f, argsFor(f, raw), a.value, a.from, t.user);
    },
  },
  {
    description: 'Fetches and decodes recent event logs emitted by a contract, newest first.',
    group: 'Calls', name: 'get_events', params: { address: P.address, blocks: { default: 200, description: 'How many recent blocks to scan (1–2000)', maximum: 2000, minimum: 1, type: 'integer' }, chain: P.chain, event: { description: 'Event name or signature. Omit for all events.', type: 'string' }, limit: { default: 50, description: 'Max events (1–200)', maximum: 200, minimum: 1, type: 'integer' } }, required: ['chain', 'address'], title: 'Get events',
    run: async (a, t) => {
      const { c, info } = await target(a, t);
      return eventsFor(c, info, a.event, a.blocks, a.limit);
    },
  },
  {
    description: 'Generates a standalone Python MCP server (FastMCP + web3.py) for the contract: server.py, requirements.txt and README.md.',
    group: 'Contracts', name: 'generate_mcp_server', params: { address: P.address, chain: P.chain }, required: ['chain', 'address'], title: 'Generate MCP server',
    run: async (a, t) => {
      const { c, info } = await target(a, t);
      return generateServer(c, info);
    },
  },
  {
    description: 'Saves a verified contract to your workspace. Each saved contract gets its own MCP endpoint at /mcp/{id} whose tools are the contract’s functions.',
    group: 'Workspace', name: 'save_contract', params: { address: P.address, chain: P.chain, name: { description: 'Display name (defaults to the verified contract name)', type: 'string' } }, required: ['chain', 'address'], title: 'Save contract',
    run: async (a, { ctx, env, user }) => saveContract(env, ctx, user, a),
  },
  {
    description: 'Lists the contracts saved in your workspace and their per-contract MCP endpoints.',
    group: 'Workspace', name: 'list_saved_contracts', params: {}, required: [], title: 'Saved contracts',
    run: async (_a, { env, user }) => {
      const rows = await env.DB.prepare('SELECT * FROM contracts WHERE user_id = ? ORDER BY created_at DESC').bind(user.id).all<SavedRow>();
      return { contracts: rows.results.map(savedView) };
    },
  },
  {
    description: 'Lists the supported chains and the preset contracts.',
    group: 'Workspace', name: 'list_chains', params: {}, required: [], title: 'Chains & presets',
    run: async () => chainsPayload(),
  },
];

function chainsPayload() {
  return { chains: CHAINS.map((c) => ({ currency: c.currency, explorer: c.explorer, id: c.id, name: c.name, rpc: c.rpc, slug: c.slug })), presets: PRESETS.map((p) => ({ ...p, chain: CHAINS.find((c) => c.id === p.chainId)?.slug })) };
}

/** Tools for one saved contract: one per ABI function plus get_events and contract_info. */
function contractTools(row: SavedRow): Tool[] {
  const c = chainOf(row.chain_id);
  const info = savedInfo(row);
  const fns = functionsOf(info.abi);
  const tools: Tool[] = fns.map((f) => {
    const params = Object.fromEntries(f.inputs.map((p, i) => [paramName(p, i), schemaOf(p)])) as Record<string, Prop>;
    const read = isRead(f.item);
    if (!read) {
      params.from = { description: 'Sender address (defaults to your signed-in EVM wallet)', type: 'string' };
      if (f.mutability === 'payable') params.value = { description: 'Native value in wei', type: 'string' };
    }
    return {
      description: `${plainEnglish(f)}. ${f.signature}${read ? ' — reads the chain.' : ' — simulates and returns an unsigned transaction.'}`,
      group: read ? 'Read' : 'Write',
      name: f.tool,
      params,
      required: f.inputs.map(paramName),
      run: async (a, t) => {
        const args = f.inputs.map((p, i) => coerce(p, a[paramName(p, i)], paramName(p, i)));
        return read ? readFn(c, info, f, args) : simulateFn(c, info, f, args, a.value, a.from, t.user);
      },
      title: f.signature.slice(0, 80),
    };
  });
  const used = new Set(tools.map((x) => x.name));
  const extra = (n: string) => (used.has(n) ? `ucai_${n}` : n);
  tools.push(
    {
      description: `Recent decoded event logs from ${row.name}.`,
      group: 'Events', name: extra('get_events'),
      params: { blocks: { default: 200, description: 'Recent blocks to scan (1–2000)', maximum: 2000, minimum: 1, type: 'integer' }, event: { description: 'Event name', enum: eventsOf(info.abi).map((e) => e.name as string), type: 'string' }, limit: { default: 50, description: 'Max events', maximum: 200, minimum: 1, type: 'integer' } },
      required: [], title: 'Get events',
      run: async (a) => eventsFor(c, info, a.event, a.blocks, a.limit),
    },
    {
      description: `Chain, address and function list of ${row.name}.`,
      group: 'Info', name: extra('contract_info'), params: {}, required: [], title: 'Contract info',
      run: async () => ({ ...savedView(row), functions: fns.map((f) => ({ mutability: f.mutability, signature: f.signature, tool: f.tool })) }),
    },
  );
  if (!eventsOf(info.abi).length) tools.splice(tools.length - 2, 1);
  return tools;
}

const toolInfo = (x: Tool) => ({ description: x.description, group: x.group, inputSchema: { additionalProperties: false, properties: x.params, required: x.required, type: 'object' }, name: x.name, title: x.title });

async function runTool(tools: Tool[], name: string, args: Record<string, unknown>, c: ToolCtx) {
  const tool = tools.find((x) => x.name === name);
  if (!tool) throw new HttpError(404, `Unknown tool ${name}`);
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new HttpError(400, 'Tool arguments must be a JSON object');
  for (const r of tool.required) if (args[r] === undefined || args[r] === '') throw new HttpError(400, `${r} is required`);
  return tool.run(args, c);
}

/* ---------------------------------------------------------------- MCP */

interface RpcMessage {
  id?: number | string | null;
  jsonrpc?: string;
  method?: string;
  params?: { arguments?: Record<string, unknown>; name?: string; protocolVersion?: string };
}

interface McpServer {
  instructions: string;
  name: string;
  prefix: string;
  title: string;
  tools: Tool[];
}

const rpcError = (id: RpcMessage['id'], code: number, message: string) => ({ error: { code, message }, id: id ?? null, jsonrpc: '2.0' });

async function mcpMessage(s: McpServer, m: RpcMessage, user: User, env: Env, ctx: ExecutionContext) {
  if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return rpcError(m?.id, -32600, 'Invalid JSON-RPC request');
  if (m.id === undefined) return null;
  switch (m.method) {
    case 'initialize':
      return { id: m.id, jsonrpc: '2.0', result: { capabilities: { tools: { listChanged: false } }, instructions: s.instructions, protocolVersion: m.params?.protocolVersion ?? '2025-06-18', serverInfo: { name: s.name, title: s.title, version: VERSION } } };
    case 'ping':
      return { id: m.id, jsonrpc: '2.0', result: {} };
    case 'tools/list':
      return { id: m.id, jsonrpc: '2.0', result: { tools: s.tools.map(toolInfo).map(({ group: _g, ...x }) => x) } };
    case 'tools/call': {
      const name = m.params?.name;
      if (typeof name !== 'string' || !s.tools.some((x) => x.name === name)) return rpcError(m.id, -32602, `Unknown tool ${String(name)}`);
      const args = m.params?.arguments ?? {};
      try {
        const out = await metered(env, ctx, user, `${s.prefix}:${name}`, args, () => runTool(s.tools, name, args, { ctx, env, user }));
        return { id: m.id, jsonrpc: '2.0', result: { content: [{ text: JSON.stringify(out, bigintSafe, 2).slice(0, 60_000), type: 'text' }], isError: false } };
      } catch (error) {
        return { id: m.id, jsonrpc: '2.0', result: { content: [{ text: (error as Error).message, type: 'text' }], isError: true } };
      }
    }
    default:
      return rpcError(m.id, -32601, `Method not found: ${m.method}`);
  }
}

async function mcpHandle(req: Request, env: Env, ctx: ExecutionContext, user: User, s: McpServer) {
  let msg: RpcMessage | RpcMessage[];
  try {
    msg = await req.json();
  } catch {
    return json(rpcError(null, -32700, 'Parse error'), { status: 400 });
  }
  if (Array.isArray(msg)) {
    const out = (await Promise.all(msg.slice(0, 20).map((m) => mcpMessage(s, m, user, env, ctx)))).filter(Boolean);
    return out.length ? json(out) : new Response(null, { status: 202 });
  }
  const out = await mcpMessage(s, msg, user, env, ctx);
  return out ? json(out) : new Response(null, { status: 202 });
}

const GLOBAL_MCP: McpServer = {
  instructions: `${APP}: turn any verified EVM contract into tools. Use fetch_abi to see a contract's functions, scan_contract for a security score, explain_contract for a plain-English summary with live state, read_contract and simulate_write to call it, get_events for logs, and save_contract to give it its own MCP endpoint. Chains: ${CHAINS.map((c) => c.slug).join(', ')}. Writes are never signed or sent; you get an unsigned transaction.`,
  name: 'ucai',
  prefix: 'mcp',
  title: APP,
  tools: TOOLS,
};

/* ---------------------------------------------------------------- routes */

async function live(env: Env, ctx: ExecutionContext) {
  return cached(env, ctx, 'live:presets', 1800, async () => {
    const rows = await Promise.all(
      PRESETS.map(async (p) => {
        const c = chainOf(p.chainId);
        try {
          const s = await scan(env, ctx, c, getAddress(p.address));
          return { address: p.address, chain: c.name, chainSlug: c.slug, counts: s.counts, grade: s.grade, label: p.label, name: s.name, ok: true, proxy: s.proxy.isProxy, score: s.score, top: s.findings.slice(0, 2).map((f) => ({ severity: f.severity, title: f.title })) };
        } catch (e) {
          return { address: p.address, chain: c.name, chainSlug: c.slug, error: (e as Error).message, label: p.label, ok: false };
        }
      }),
    );
    if (rows.every((r) => !r.ok)) throw new HttpError(502, 'Every verification source failed');
    return { contracts: rows, fetchedAt: Date.now() };
  });
}

const pathTarget = async (env: Env, ctx: ExecutionContext, p: Record<string, string>) => {
  const c = chainOf(p.chain);
  return { c, info: await contract(env, ctx, c, addr(p.address)) };
};

const router: Router<Env> = kitRoutes(new Router<Env>(), { appName: APP, keySlug: 'ucai' })
  .get('/api/live', async (_req, env, ctx) => json(await live(env, ctx)))
  .get('/api/chains', () => json(chainsPayload()))
  .get('/api/tools', () => json({ tools: TOOLS.map(toolInfo) }))
  .post('/api/run/:name', async (req, env, ctx, p) => {
    const user = await requireKeyOrUser(req, env, ctx);
    const args = await readJson<Record<string, unknown>>(req);
    if (!TOOLS.some((x) => x.name === p.name)) throw new HttpError(404, `Unknown tool ${p.name}`);
    const started = Date.now();
    const result = await metered(env, ctx, user, `tool:${p.name}`, args, () => runTool(TOOLS, p.name, args, { ctx, env, user }));
    return new Response(JSON.stringify({ ms: Date.now() - started, result, tool: p.name }, bigintSafe), { headers: { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' } });
  })

  .get('/api/contract/:chain/:address', async (req, env, ctx, p) => {
    await requireKeyOrUser(req, env, ctx);
    const { c, info } = await pathTarget(env, ctx, p);
    return json(abiSummary(c, info));
  })
  .get('/api/contract/:chain/:address/scan', async (req, env, ctx, p) => {
    const user = await requireKeyOrUser(req, env, ctx);
    return json(await metered(env, ctx, user, 'scan', p, () => scan(env, ctx, chainOf(p.chain), addr(p.address))));
  })
  .get('/api/contract/:chain/:address/explain', async (req, env, ctx, p) => {
    const user = await requireKeyOrUser(req, env, ctx);
    return json(await metered(env, ctx, user, 'explain', p, () => explain(env, ctx, chainOf(p.chain), addr(p.address))));
  })
  .post('/api/contract/:chain/:address/read', async (req, env, ctx, p) => {
    const user = await requireKeyOrUser(req, env, ctx);
    const b = await readJson<Record<string, unknown>>(req);
    return json(
      await metered(env, ctx, user, 'read', { ...p, function: b.function }, async () => {
        const { c, info } = await pathTarget(env, ctx, p);
        const raw = parseMaybeJson(b.args ?? [], 'args');
        const f = pickFunction(info, b.function, Array.isArray(raw) ? raw.length : undefined);
        return JSON.parse(JSON.stringify(await readFn(c, info, f, argsFor(f, raw)), bigintSafe));
      }),
    );
  })
  .post('/api/contract/:chain/:address/simulate', async (req, env, ctx, p) => {
    const user = await requireKeyOrUser(req, env, ctx);
    const b = await readJson<Record<string, unknown>>(req);
    return json(
      await metered(env, ctx, user, 'simulate', { ...p, function: b.function }, async () => {
        const { c, info } = await pathTarget(env, ctx, p);
        const raw = parseMaybeJson(b.args ?? [], 'args');
        const f = pickFunction(info, b.function, Array.isArray(raw) ? raw.length : undefined);
        return JSON.parse(JSON.stringify(await simulateFn(c, info, f, argsFor(f, raw), b.value, b.from, user), bigintSafe));
      }),
    );
  })
  .get('/api/contract/:chain/:address/events', async (req, env, ctx, p) => {
    const user = await requireKeyOrUser(req, env, ctx);
    const q = new URL(req.url).searchParams;
    return json(
      await metered(env, ctx, user, 'events', p, async () => {
        const { c, info } = await pathTarget(env, ctx, p);
        return JSON.parse(JSON.stringify(await eventsFor(c, info, q.get('event') ?? undefined, q.get('blocks') ?? undefined, q.get('limit') ?? undefined), bigintSafe));
      }),
    );
  })
  .get('/api/contract/:chain/:address/codegen', async (req, env, ctx, p) => {
    const user = await requireKeyOrUser(req, env, ctx);
    return json(
      await metered(env, ctx, user, 'codegen', p, async () => {
        const { c, info } = await pathTarget(env, ctx, p);
        return generateServer(c, info);
      }),
    );
  })

  .get('/api/contracts', async (req, env) => {
    const user = await requireUser(req, env);
    const rows = await env.DB.prepare('SELECT * FROM contracts WHERE user_id = ? ORDER BY created_at DESC').bind(user.id).all<SavedRow>();
    return json({ contracts: rows.results.map(savedView), max: MAX_SAVED });
  })
  .post('/api/contracts', async (req, env, ctx) => {
    const user = await requireUser(req, env);
    const b = await readJson<Record<string, unknown>>(req);
    return json(await metered(env, ctx, user, 'contracts:save', { address: b.address, chain: b.chain }, () => saveContract(env, ctx, user, b)), { status: 201 });
  })
  .delete('/api/contracts/:id', async (req, env, ctx, p) => {
    const user = await requireUser(req, env);
    await savedRow(env, user, p.id);
    await metered(env, ctx, user, 'contracts:delete', p, () => env.DB.prepare('DELETE FROM contracts WHERE id = ? AND user_id = ?').bind(p.id, user.id).run());
    return json({ ok: true });
  })
  .get('/api/contracts/:id/tools', async (req, env, ctx, p) => {
    const user = await requireKeyOrUser(req, env, ctx);
    const row = await savedRow(env, user, p.id);
    return json({ contract: savedView(row), tools: contractTools(row).map(toolInfo) });
  })

  .get('/mcp', () => json({ error: 'This MCP endpoint is stateless: POST JSON-RPC messages (no SSE stream).' }, { headers: { allow: 'POST' }, status: 405 }))
  .post('/mcp', async (req, env, ctx) => mcpHandle(req, env, ctx, await requireKeyOrUser(req, env, ctx), GLOBAL_MCP))
  .get('/mcp/:id', () => json({ error: 'This MCP endpoint is stateless: POST JSON-RPC messages (no SSE stream).' }, { headers: { allow: 'POST' }, status: 405 }))
  .post('/mcp/:id', async (req, env, ctx, p) => {
    const user = await requireKeyOrUser(req, env, ctx);
    const row = await savedRow(env, user, p.id);
    const c = chainOf(row.chain_id);
    return mcpHandle(req, env, ctx, user, {
      instructions: `${row.name} at ${row.address} on ${c.name}, generated by ${APP} from its verified ABI. Read tools call the chain; write tools simulate from your wallet and return an unsigned transaction. Nothing is ever signed or sent.`,
      name: `ucai-${row.id}`,
      prefix: `mcp/${row.id}`,
      title: `${row.name} (${c.name})`,
      tools: contractTools(row),
    });
  });

export default { fetch: serve(router, SCHEMA) } satisfies ExportedHandler<Env>;
export { ensureSchema };
