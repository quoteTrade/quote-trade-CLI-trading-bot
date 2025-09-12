import {BLUE, GREEN, RED, RESET, YELLOW} from "../ANSI";

function fmtSideFromQty(qty: number) {
    if (qty > 0)  return `${GREEN}LONG${RESET}`;
    if (qty < 0)  return `${RED}SHORT${RESET}`;
    return `${BLUE}FLAT${RESET}`;
}

function orderSideStyle(side: string) {
    if (side === 'BUY')  return `${GREEN}${side}${RESET}`;
    if (side === 'SELL')  return `${RED}${side}${RESET}`;
    return `${side}`;
}

export function logPositionSnapshot(p: any | {symbol:string; netQty:string; avgEntryPrice?:string}) {
    const q = Number(p.netQty ?? 0);
    const side = fmtSideFromQty(q);
    const avg = p.avgEntryPrice ? ` @ ${Number(p.avgEntryPrice).toFixed(2)}` : "";
    console.log(`📦  ${BLUE}Position •${RESET} ${p.symbol}: ${side} qty=${q}${avg}`);
}

export function logPositionChange(prev: any | undefined, next: any) {
    const p = Number(prev?.netQty ?? 0);
    const n = Number(next.netQty ?? 0);
    if (p === n) return;
    const from = fmtSideFromQty(p);
    const to = fmtSideFromQty(n);
    const avg = next.avgEntryPrice ? ` @ ${Number(next.avgEntryPrice).toFixed(2)}` : "";
    console.log(`🔄  ${BLUE}Position changed •${RESET} ${next.symbol}: ${from} → ${to} (qty ${p} → ${n}${avg})`);
}

export function logOrderUpdate(u: any) {
    if (u.status === "NEW") {
        console.log(`📝  ORDER - ACCEPTED • ${orderSideStyle(u.side)} ${u.symbol} (clientId=${u.clientOrderId})`);
    } else if (u.status === "PARTIALLY_FILLED") {
        console.log(`${YELLOW}🟡  ORDER - PARTIAL FILL •${RESET} ${orderSideStyle(u.side)} ${u.symbol} cum=${u.cumQty ?? u.filledQty ?? "?"} @ ${u.fillPrice ?? "?"} (clientId=${u.clientOrderId})`);
    } else if (u.status === "FILLED") {
        console.log(`${GREEN}✅  ORDER - FILLED • ${RESET}${orderSideStyle(u.side)} ${u.symbol} qty=${u.quantity ?? "?"} @ ${u.fillPrice ?? "?"} (Size=${ u.quantity} | Price=${ u.price} | OrderId=${u.orderId ?? "?"} | ExecId=${u.execId ?? "?"} | ClientId=${u.clientOrderId})`);
    } else if (u.status === "REJECTED") {
        console.log(`${RED}❌  ORDER - REJECTED • ${u.side} ${u.symbol} - ${u.reason} ${RESET}`);
    } else if (u.status === "CANCELED" || u.status === "EXPIRED") {
        console.log(`${YELLOW}🛑  ORDER - ${u.status} • ${u.side} ${u.symbol} (clientId=${u.clientOrderId})${RESET}`);
    }
}
