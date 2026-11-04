import { NextRequest, NextResponse } from "next/server";
import { queryEtherscan, ExplorerAction } from "@/lib/etherscan";

const ACTIONS: ExplorerAction[] = ["getabi", "getsourcecode"];
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

// Proxies contract lookups to Etherscan V2 so the API key stays on the server.
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const chainId = Number(searchParams.get("chainid"));
  const action = searchParams.get("action") as ExplorerAction;
  const address = searchParams.get("address") || "";

  if (!Number.isInteger(chainId) || chainId <= 0) {
    return NextResponse.json({ status: "0", message: "Invalid chainid", result: null }, { status: 400 });
  }
  if (!ACTIONS.includes(action)) {
    return NextResponse.json({ status: "0", message: "Unsupported action", result: null }, { status: 400 });
  }
  if (!ADDRESS.test(address)) {
    return NextResponse.json({ status: "0", message: "Invalid address", result: null }, { status: 400 });
  }

  try {
    return NextResponse.json(await queryEtherscan(chainId, action, address));
  } catch {
    return NextResponse.json({ status: "0", message: "Explorer request failed", result: null }, { status: 502 });
  }
}
