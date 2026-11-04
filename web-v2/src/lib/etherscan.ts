// Server-only Etherscan V2 client. The V1 per-chain endpoints (api.polygonscan.com/api, ...)
// are retired; V2 serves every supported chain from one host, selected by `chainid`.
const ETHERSCAN_V2 = "https://api.etherscan.io/v2/api";

export type ExplorerAction = "getabi" | "getsourcecode";

export interface SourceCodeRecord {
  SourceCode?: string;
  ContractName?: string;
  CompilerVersion?: string;
  Implementation?: string;
  [field: string]: string | undefined;
}

export interface ExplorerResponse<T> {
  status: string;
  message: string;
  result: T | null;
}

export function queryEtherscan(chainId: number, action: "getabi", address: string): Promise<ExplorerResponse<string>>;
export function queryEtherscan(chainId: number, action: "getsourcecode", address: string): Promise<ExplorerResponse<SourceCodeRecord[]>>;
export function queryEtherscan(chainId: number, action: ExplorerAction, address: string): Promise<ExplorerResponse<string | SourceCodeRecord[]>>;
export async function queryEtherscan(
  chainId: number,
  action: ExplorerAction,
  address: string
): Promise<ExplorerResponse<string | SourceCodeRecord[]>> {
  const params = new URLSearchParams({
    chainid: String(chainId),
    module: "contract",
    action,
    address,
  });
  const apiKey = process.env.ETHERSCAN_API_KEY;
  if (apiKey) params.set("apikey", apiKey);

  const response = await fetch(`${ETHERSCAN_V2}?${params}`);
  if (!response.ok) {
    return { status: "0", message: `Explorer returned HTTP ${response.status}`, result: null };
  }
  return (await response.json()) as ExplorerResponse<string | SourceCodeRecord[]>;
}
