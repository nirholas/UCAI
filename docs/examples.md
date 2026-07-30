# UCAI examples

``` ██╗ ██╗ ██████╗ █████╗ ██╗ ██║ ██║██╔════╝██╔══██╗██║ ██║ ██║██║ ███████║██║ ██║ ██║██║ ██╔══██║██║ ╚██████╔╝╚██████╗██║ ██║██║ ╚═════╝ ╚═════╝╚═╝ ╚═╝╚═╝

## Example 1

```text
██╗   ██╗ ██████╗ █████╗ ██╗
    ██║   ██║██╔════╝██╔══██╗██║
    ██║   ██║██║     ███████║██║
    ██║   ██║██║     ██╔══██║██║
    ╚██████╔╝╚██████╗██║  ██║██║
     ╚═════╝  ╚═════╝╚═╝  ╚═╝╚═╝
                                
    Any contract. One command. Claude speaks it.
```

## Example 2

```text
+--------------------------------------------------------------------------+
|                                                                          |
|   MCP BUILDER                                         [Connect Wallet]   |
|                                                                          |
|   +---------------------------+--------------------------------------+   |
|   |  Pro Templates            |    Custom Contract                   |   |
|   +---------------------------+--------------------------------------+   |
|                                                                          |
|   Security Scanner: Score 87/100 - Low Risk                              |
|   |-- Contract verified on Etherscan                                     |
|   |-- Uses OpenZeppelin (audited)                                        |
|   |-- Owner can pause transfers (warning)                                |
|   +-- Mint function detected (warning)                                   |
|                                                                          |
|   What This Contract Does:                                               |
|   "ERC-20 token with standard transfer, approve, and allowance           |
|    functions."                                                           |
|                                                                          |
|   [Download Server]  [Share Link]  [Copy Config]                         |
|                                                                          |
+--------------------------------------------------------------------------+
```

## Example 3

```text
┌────────────────────────────────────────────────────────────────────────────┐
│                                                                            │
│   1. FIND                      2. GENERATE                   3. DONE       │
│                                                                            │
│   ┌─────────────────┐         ┌─────────────────┐       ┌───────────────┐  │
│   │   Etherscan     │         │                 │       │               │  │
│   │   ┌─────────┐   │         │  $ abi-to-mcp   │       │    Claude     │  │
│   │   │ Contract│   │  ────▶  │    generate     │  ──▶  │   Tools       │  │
│   │   │   ABI   │   │         │    0x7a25...    │       │               │  │
│   │   └─────────┘   │         │                 │       │  "Swap 1 ETH" │  │
│   └─────────────────┘         └─────────────────┘       └───────────────┘  │
│                                                                            │
│        Any contract              One command               AI speaks it    │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

## Example 4

```bash
pip install abi-to-mcp

# Uniswap — Claude can swap tokens
abi-to-mcp generate 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D -o ~/uniswap-server

# ETH 2.0 Beacon Deposit — Claude can explore staking
abi-to-mcp generate 0x00000000219ab540356cBB839Cbe05303d7705Fa -o ~/eth-staking-server

# Any verified contract works
abi-to-mcp generate <ANY_CONTRACT_ADDRESS>
```

## Example 5

```bash
abi-to-mcp generate 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D -o ~/uniswap-server
cd ~/uniswap-server && pip install -r requirements.txt
```

## Example 6

```text
┌────────────────────────────────────────────────────────────────────────────┐
│  YOU                                                                       │
├────────────────────────────────────────────────────────────────────────────┤
│  "What's the best route to swap 1 ETH for USDC on Uniswap?"                │
└────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  CLAUDE                                                                    │
├────────────────────────────────────────────────────────────────────────────┤
│  I'll check the Uniswap router for the best path...                        │
│                                                                            │
│  Called: getAmountsOut(1 ETH, [WETH, USDC])                                │
│                                                                            │
│  Best route: ETH -> WETH -> USDC                                           │
│  You would receive: 3,847.23 USDC                                          │
│  Price impact: 0.02%                                                       │
└────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  YOU                                                                       │
├────────────────────────────────────────────────────────────────────────────┤
│  "Do it. Swap 1 ETH for USDC."                                             │
└────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  CLAUDE                                                                    │
├────────────────────────────────────────────────────────────────────────────┤
│  Simulating transaction first...                                           │
│                                                                            │
│  Simulation successful                                                     │
│  Gas estimate: 152,847 (~$3.42)                                            │
│  Expected output: 3,847.23 USDC                                            │
│                                                                            │
│  Ready to execute. Confirm? [Yes/No]                                       │
└────────────────────────────────────────────────────────────────────────────┘
```

## Example 7

```text
╔═══════════════════════════════════════════════════════════════════════════════╗
║                                                                               ║
║   ┌─────────┐      ┌──────────────┐      ┌──────────────┐      ┌──────────┐   ║
║   │         │      │              │      │              │      │          │   ║
║   │  Claude │─────>│  abi-to-mcp  │─────>│  MCP Server  │─────>│  Chain   │   ║
║   │         │      │   generate   │      │ (your tools) │      │          │   ║
║   └─────────┘      └──────────────┘      └──────────────┘      └──────────┘   ║
║        │                                        │                     │       ║
║        │              "swap 1 ETH"              │    call swap()      │       ║
║        └────────────────────────────────────────┴─────────────────────┘       ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
```

## Example 8

```bash
abi-to-mcp generate 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D -o ~/uniswap-server
```


Every snippet above is taken from the [repository documentation](https://github.com/nirholas/UCAI#readme).
