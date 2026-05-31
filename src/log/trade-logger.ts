import { BLUE, GREEN, RED, RESET, YELLOW } from "../ANSI";
export function logPositionSnapshot(p:any):void { console.log(` ${BLUE}Position •${RESET} ${p.symbol}: qty=${p.quantity ?? p.netQty ?? p.pa}`); }
export function logPositionChange(prev:any|undefined, next:any):void { const p=Number(prev?.netQty ?? prev?.quantity ?? prev?.pa ?? 0); const n=Number(next.netQty ?? next.quantity ?? next.pa ?? 0); if(p!==n) console.log(` ${BLUE}Position changed •${RESET} ${next.symbol}: ${p} → ${n}`); }
export function logOrderUpdate(u:any):void { const c = u.side === "BUY" ? GREEN : RED; console.log(`${YELLOW}ORDER UPDATE${RESET} ${c}${u.side}${RESET} ${u.symbol} status=${u.status} qty=${u.quantity ?? "?"} price=${u.fillPrice ?? u.price ?? "?"}`); }
