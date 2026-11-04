# UCAI Cloud demo

UCAI Cloud is a hosted demo of [UCAI](https://github.com/nirholas/UCAI) (`abi-to-mcp`). Give it any verified EVM contract and it turns the ABI into MCP tools. It also scans the contract for admin risk, explains it in plain English, reads live state, simulates writes, decodes recent events and generates a standalone Python FastMCP server. It runs on one Cloudflare Worker with a D1 database.

- Live: https://ucai.ninabrekkerese.workers.dev
- Console: `/app/` (sign in with an EVM or Solana wallet)
- MCP endpoints: `POST /mcp` for every tool, and `POST /mcp/:id` for one saved contract. Both use Streamable HTTP, stateless JSON-RPC and `Authorization: Bearer sk_ucai_…`.

## What it does

Supported chains: Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain, Avalanche and Sepolia.

**Where data comes from**
- The verified ABI and source come from Sourcify, then Blockscout, then Routescan, tried in that order.
- Proxies that the verification source reports are followed to their implementation.
- Reads, simulations and logs go to publicnode RPCs through viem.

**Writes**
- A write is simulated with `eth_call` from the sender address. The worker never signs anything.
- The console can then send the transaction from the user's own wallet, after a confirmation step.

**Security scan**
- The score starts at 100.
- Penalties apply for mint, pause, blacklist, fee or limit setters, upgradeability, `selfdestruct`, `delegatecall` and `tx.origin`.
- `owner()` is read on-chain, so renounced ownership and contract owners are credited.

There are 10 tools:

| Group | Tools |
|---|---|
| Contracts | `fetch_abi`, `scan_contract`, `explain_contract`, `generate_mcp_server` |
| Calls | `read_contract`, `simulate_write`, `get_events` |
| Workspace | `save_contract`, `list_saved_contracts`, `list_chains` |

Each saved contract (up to 25 per user) has its own endpoint at `/mcp/:id`. Its tools are:
- one tool per function, named after it (overloads get a `_2` suffix). View functions return a live read, and write functions return a simulation plus an unsigned transaction;
- `get_events`;
- `contract_info`.

## Routes

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/live` | public | Risk scans of the preset contracts (cached 30 min) |
| `GET /api/chains` | public | Chains and preset contracts |
| `GET /api/contract/:chain/:address` | session or key | ABI summary with each function's tool schema |
| `GET …/scan`, `…/explain`, `…/codegen` | session or key | Security scan, explanation, FastMCP server files |
| `GET …/events?event=&blocks=&limit=` | session or key | Decoded recent logs |
| `POST …/read`, `POST …/simulate` | session or key | `{function, args, from?, value?}` |
| `GET/POST /api/contracts`, `DELETE /api/contracts/:id` | session | Saved contracts |
| `GET /api/contracts/:id/tools` | session | Tools of one saved contract |
| `GET /api/tools` | public | Tool list with JSON Schemas |
| `POST /api/run/:tool` | session or key | Tool runner |
| `POST /mcp`, `POST /mcp/:id` | session or key | MCP `initialize`, `tools/list`, `tools/call` |

## Develop and deploy

```bash
npm install
./build.sh                                   # copies site/ and the vendored kit into public/
bash ../../_kit/scripts/deploy.sh "$PWD"     # creates D1, deploys, sets SESSION_SECRET
```

`deploy.sh` reads Cloudflare credentials from `~/.config/cloudflare/credentials.env`. The worker creates the D1 schema on the first request.
