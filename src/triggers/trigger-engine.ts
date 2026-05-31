import { PositionStore } from "./position-store";
import { TriggerStore } from "./trigger-store";
import {
  distanceFromMode,
  MarketTick,
  normalizeSymbol,
  oppositeSide,
  orderPriceForTrigger,
  orderTypeForTrigger,
  PositionSnapshot,
  selectL2SideQuote,
  shouldTrigger,
  SubmitOrderRequest,
  TriggerOrder,
  TriggerOrderExecutor,
  unrealizedPnlUsd,
} from "./types";
import type { OrderSide } from "./types";

export interface TriggerEngineOptions {
  onTrigger?: (trigger: TriggerOrder, order: SubmitOrderRequest) => void;
  onReject?: (trigger: TriggerOrder, reason: string) => void;
  onError?: (trigger: TriggerOrder, error: unknown) => void;
  onAction?: (trigger: TriggerOrder, message: string) => void;
}

interface OrderIntent {
  side: OrderSide;
  quantity: number;
  reduceOnly: boolean;
}

interface TriggerMarket {
  side: OrderSide;
  quantity: number;
  price: number;
}

function debugTrigger(event: string, payload: Record<string, unknown>): void {
  const v = String(process.env.CLI_DEBUG ?? "").toLowerCase();
  if (!(v === "1" || v === "true")) return;

  console.log(`[TRIGGER_DEBUG] ${event}`, JSON.stringify(payload, null, 2));
}

function bookSideForDebug(side: OrderSide): "asks" | "bids" {
  return side === "BUY" ? "asks" : "bids";
}

function isTimer(trigger: TriggerOrder): boolean {
  return trigger.kind === "TIME_CLOSE" || trigger.kind === "TIME_CANCEL";
}

function positiveNumber(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function patchChanges(trigger: TriggerOrder, patch: Partial<TriggerOrder>, ignore = new Set<string>()): boolean {
  return Object.entries(patch).some(([key, value]) => !ignore.has(key) && (trigger as any)[key] !== value);
}

function roughlyEqual(a: number | undefined, b: number | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return Math.abs(a - b) <= 1e-12;
}

export class TriggerEngine {
  private firing = new Set<string>();
  private lastTicks = new Map<string, MarketTick>();

  constructor(
    private store: TriggerStore,
    private positions: PositionStore,
    private executor: TriggerOrderExecutor,
    private options: TriggerEngineOptions = {},
  ) {}

  async processTick(tick: MarketTick): Promise<void> {
    const symbol = normalizeSymbol(tick.symbol);
    const normalizedTick = { ...tick, symbol };
    this.lastTicks.set(symbol, normalizedTick);
    this.updatePositionMarkFromBook(symbol, normalizedTick);

    await this.processDueTimers(Date.now());

    for (const baseTrigger of this.store.active(symbol)) {
      const trigger = this.store.get(baseTrigger.id) ?? baseTrigger;
      if (trigger.status !== "ACTIVE" || isTimer(trigger)) continue;

      if (trigger.kind === "RISK_GUARD") {
        if (!this.isRiskGuardBreached(trigger)) continue;
        if (trigger.riskAction === "CLOSE_POSITION") {
          const market = this.marketForTrigger(trigger, normalizedTick);
          if (!market) continue;
          await this.fire({ ...trigger, side: market.side }, market.price);
        } else {
          await this.fireRiskGuardIfNoOrder(trigger);
        }
        continue;
      }

      const market = this.marketForTrigger(trigger, normalizedTick);
      if (!market) continue;

      const resolvedTrigger = { ...trigger, side: market.side };
      const current = this.applyTickState(resolvedTrigger, market.price);
      const currentForDecision = { ...current, side: market.side };
      const fireNow = shouldTrigger(currentForDecision, market.price);

      debugTrigger("TRIGGER_CHECK", {
        id: currentForDecision.id,
        kind: currentForDecision.kind,
        symbol: currentForDecision.symbol,
        side: currentForDecision.side,
        bookSide: bookSideForDebug(currentForDecision.side),
        executablePrice: market.price,
        triggerPrice: currentForDecision.triggerPrice,
        currentStopPrice: currentForDecision.currentStopPrice,
        lowerPrice: currentForDecision.lowerPrice,
        upperPrice: currentForDecision.upperPrice,
        priceBandMode: currentForDecision.priceBandMode,
        quantity: market.quantity,
        shouldFire: fireNow,
      });

      if (fireNow) await this.fire(currentForDecision, market.price);
    }
  }

  async processDueTimers(now = Date.now()): Promise<void> {
    for (const trigger of this.store.active()) {
      if (!isTimer(trigger) || !trigger.triggerAt || trigger.triggerAt > now) continue;

      if (trigger.kind === "TIME_CANCEL") {
        await this.fire(trigger, 0);
        continue;
      }

      const tick = this.lastTicks.get(trigger.symbol);
      if (!tick) continue;
      const market = this.marketForTrigger(trigger, tick);
      if (!market) continue;
      await this.fire({ ...trigger, side: market.side }, market.price);
    }
  }

  async processPositionUpdate(positionOrSymbol: PositionSnapshot | string): Promise<TriggerOrder[]> {
    const symbol = typeof positionOrSymbol === "string" ? normalizeSymbol(positionOrSymbol) : normalizeSymbol(positionOrSymbol.symbol);
    const changed: TriggerOrder[] = [];

    for (const parent of this.store.list({ symbol })) {
      if (parent.status !== "TRIGGERED" || !parent.meta?.bracket) continue;

      const filledQuantity = this.bracketEntryFillQuantity(parent);
      if (filledQuantity <= 0) continue;

      if (parent.meta.bracketChildrenCreated) {
        changed.push(...this.syncBracketExitQuantities(parent, filledQuantity));
      } else {
        changed.push(...this.createBracketExits(parent, filledQuantity));
      }
    }

    const marketPrice = this.positions.get(symbol)?.markPrice ?? 0;
    for (const guard of this.store.active(symbol).filter((trigger) => trigger.kind === "RISK_GUARD")) {
      if (!this.isRiskGuardBreached(guard)) continue;
      if (guard.riskAction === "CLOSE_POSITION") continue; // close orders wait for a depth-checked L2 tick
      await this.fire(guard, marketPrice);
      const updated = this.store.get(guard.id);
      if (updated) changed.push(updated);
    }

    return changed;
  }

  resolveOrder(trigger: TriggerOrder, marketPrice: number): SubmitOrderRequest | string {
    const intent = this.resolveOrderIntent(trigger);
    if (typeof intent === "string") return intent;

    const resolvedTrigger = { ...trigger, side: intent.side };
    const orderType = orderTypeForTrigger(resolvedTrigger, marketPrice);
    const price = orderPriceForTrigger(resolvedTrigger, marketPrice);
    if (orderType === "LIMIT" && (!price || price <= 0)) return "Triggered order has no valid limit price";

    return {
      symbol: trigger.symbol,
      side: intent.side,
      type: orderType,
      quantity: intent.quantity,
      price: orderType === "LIMIT" ? price : undefined,
      paymentCurrency: trigger.paymentCurrency,
      account: trigger.account,
      reduceOnly: intent.reduceOnly,
      clientOrderId: `qt_${trigger.id}`,
    };
  }

  private resolveOrderIntent(trigger: TriggerOrder): OrderIntent | string {
    let side = trigger.side;
    let quantity = trigger.quantity;

    const shouldResolveFromPosition =
      trigger.closePosition ||
      trigger.closePercentage !== undefined ||
      (trigger.kind === "RISK_GUARD" && trigger.riskAction === "CLOSE_POSITION");

    if (shouldResolveFromPosition) {
      const closeSide = this.positions.getCloseSide(trigger.symbol);
      const closeQty = this.positions.getCloseQuantity(trigger.symbol);
      if (!closeSide || closeQty <= 0) return `No open ${trigger.symbol} position to close`;
      side = closeSide;
      quantity = trigger.closePercentage !== undefined ? closeQty * (trigger.closePercentage / 100) : closeQty;
    }

    if (!quantity || quantity <= 0) return "Trigger quantity resolved to zero";
    return { side, quantity, reduceOnly: trigger.reduceOnly || shouldResolveFromPosition };
  }

  private marketForTrigger(trigger: TriggerOrder, tick: MarketTick): TriggerMarket | undefined {
    const intent = this.resolveOrderIntent(trigger);
    if (typeof intent === "string") return undefined;

    debugTrigger("L2_CHECK", {
      id: trigger.id,
      kind: trigger.kind,
      symbol: trigger.symbol,
      orderSide: intent.side,
      bookSide: bookSideForDebug(intent.side),
      requestedQty: intent.quantity,
      triggerPrice: trigger.triggerPrice,
      limitPrice: trigger.limitPrice,
      currentStopPrice: trigger.currentStopPrice,
      bid: tick.bid,
      ask: tick.ask,
      bidQty: tick.bidQty ?? tick.bidQuantity,
      askQty: tick.askQty ?? tick.askQuantity,
      mark: tick.mark,
      ts: tick.ts,
    });

    const quote = selectL2SideQuote(tick, intent.side, intent.quantity);

    if (!quote) {
      debugTrigger("L2_NOT_ENOUGH_DEPTH", {
        id: trigger.id,
        kind: trigger.kind,
        symbol: trigger.symbol,
        orderSide: intent.side,
        bookSide: bookSideForDebug(intent.side),
        requestedQty: intent.quantity,
        reason: "No executable L2 quote for full requested quantity",
      });

      return undefined;
    }
    // if (!quote) return undefined;

    debugTrigger("L2_DEPTH_OK", {
      id: trigger.id,
      kind: trigger.kind,
      symbol: trigger.symbol,
      orderSide: intent.side,
      bookSide: quote.bookSide,
      requestedQty: quote.requestedQuantity,
      availableQty: quote.availableQuantity,
      executablePrice: quote.price,
      levelsConsumed: quote.levelsConsumed,
    });

    return { side: intent.side, quantity: intent.quantity, price: quote.price };
  }

  private updatePositionMarkFromBook(symbol: string, tick: MarketTick): void {
    const position = this.positions.get(symbol);
    if (!position) return;

    const closeSide = this.positions.getCloseSide(symbol);
    const closeQty = this.positions.getCloseQuantity(symbol);
    if (!closeSide || closeQty <= 0) return;

    const quote = selectL2SideQuote(tick, closeSide, closeQty);
    if (quote) this.positions.setMark(symbol, quote.price, false);
  }

  private async fireRiskGuardIfNoOrder(trigger: TriggerOrder): Promise<void> {
    const marketPrice = this.positions.get(trigger.symbol)?.markPrice ?? trigger.lastCheckedPrice ?? 0;
    await this.fire(trigger, marketPrice);
  }

  private applyTickState(trigger: TriggerOrder, price: number): TriggerOrder {
    if (trigger.kind === "TRAILING_STOP" || trigger.kind === "TRAILING_STOP_LIMIT") {
      let dynamicPatch: Partial<TriggerOrder>;
      if (trigger.side === "SELL") {
        const highWaterMark = Math.max(trigger.highWaterMark ?? price, price);
        const distance = distanceFromMode(highWaterMark, trigger.trailMode, trigger.trailValue);
        dynamicPatch = { highWaterMark, currentStopPrice: highWaterMark - distance };
      } else {
        const lowWaterMark = Math.min(trigger.lowWaterMark ?? price, price);
        const distance = distanceFromMode(lowWaterMark, trigger.trailMode, trigger.trailValue);
        dynamicPatch = { lowWaterMark, currentStopPrice: lowWaterMark + distance };
      }
      const moved = patchChanges(trigger, dynamicPatch);
      return this.store.update(trigger.id, { ...dynamicPatch, lastCheckedPrice: price }, { persist: moved }) ?? trigger;
    }

    if (trigger.kind === "BREAK_EVEN_STOP") {
      const patch = this.breakEvenPatch(trigger, price);
      const changed = patchChanges(trigger, patch, new Set(["meta"]));
      return this.store.update(trigger.id, { ...patch, lastCheckedPrice: price }, { persist: changed }) ?? trigger;
    }

    return this.store.update(trigger.id, { lastCheckedPrice: price }, { persist: false }) ?? trigger;
  }

  private breakEvenPatch(trigger: TriggerOrder, price: number): Partial<TriggerOrder> {
    const position = this.positions.get(trigger.symbol);
    const entry = position?.avgEntryPrice;
    if (!entry || entry <= 0) return {};

    const closeSide = trigger.closePosition ? this.positions.getCloseSide(trigger.symbol) ?? trigger.side : trigger.side;
    const activationDistance = distanceFromMode(entry, trigger.activationMode, trigger.activationValue);
    const lockDistance = distanceFromMode(entry, trigger.lockMode, trigger.lockValue ?? 0);
    const activationPrice = closeSide === "SELL" ? entry + activationDistance : entry - activationDistance;
    const stopPrice = closeSide === "SELL" ? entry + lockDistance : entry - lockDistance;
    const armed = trigger.breakEvenArmed || (closeSide === "SELL" ? price >= activationPrice : price <= activationPrice);

    if (!armed) {
      return { side: closeSide, breakEvenArmed: false, meta: { ...(trigger.meta ?? {}), activationPrice } };
    }

    return {
      side: closeSide,
      breakEvenArmed: true,
      currentStopPrice: stopPrice,
      triggerPrice: stopPrice,
      meta: { ...(trigger.meta ?? {}), activationPrice },
    };
  }

  private isRiskGuardBreached(trigger: TriggerOrder): boolean {
    const position = this.positions.get(trigger.symbol);
    const threshold = trigger.riskThreshold ?? 0;
    if (!position || threshold <= 0) return false;

    if (trigger.riskMetric === "MAX_POSITION_QTY") return Math.abs(position.netQty) >= threshold;
    if (trigger.riskMetric === "MAX_RISK_USD") return position.riskUsd >= threshold;
    if (trigger.riskMetric === "MAX_LOSS_USD") return Math.max(0, -unrealizedPnlUsd(position)) >= threshold;
    return false;
  }

  private async fire(trigger: TriggerOrder, marketPrice: number): Promise<void> {
    if (this.firing.has(trigger.id)) return;
    let latest = this.store.get(trigger.id) ?? trigger;
    if (latest.status !== "ACTIVE") return;
    this.firing.add(trigger.id);

    try {
      if (latest.kind === "TIME_CANCEL") {
        this.fireTimeCancel(latest, marketPrice);
        return;
      }

      if (latest.kind === "RISK_GUARD" && latest.riskAction !== "CLOSE_POSITION") {
        this.fireRiskGuardAction(latest, marketPrice);
        return;
      }

      latest = this.recordBracketEntrySubmission(latest);
      const order: any = this.resolveOrder(latest, marketPrice);

      debugTrigger("ORDER_SUBMIT", {
        id: latest.id,
        kind: latest.kind,
        symbol: order.symbol,
        side: order.side,
        type: order.type,
        quantity: order.quantity,
        price: order.price,
        reduceOnly: order.reduceOnly,
        paymentCurrency: order.paymentCurrency,
        marketPrice,
      });

      if (typeof order === "string") {
        this.store.setStatus(latest.id, "REJECTED", { error: order, firedAt: Date.now(), lastCheckedPrice: marketPrice });
        this.options.onReject?.(latest, order);
        return;
      }

      this.store.update(latest.id, { firedAt: Date.now(), lastCheckedPrice: marketPrice });
      const result = await this.executor.submitOrder(order);
      const fired = this.store.setStatus(latest.id, "TRIGGERED", {
        orderId: result.orderId,
        clientOrderId: result.clientOrderId,
        firedAt: Date.now(),
        lastCheckedPrice: marketPrice,
      }) ?? latest;

      const cancelled = this.store.cancelOcoSiblings(fired.ocoGroupId, fired.id);
      if (cancelled.length) this.options.onAction?.(fired, `Cancelled ${cancelled.length} OCO sibling trigger(s).`);
      this.options.onTrigger?.(fired, order);
    } catch (error: any) {
      const message = error?.message ?? String(error);
      this.store.setStatus(latest.id, "REJECTED", { error: message, firedAt: Date.now(), lastCheckedPrice: marketPrice });
      this.options.onError?.(latest, error);
    } finally {
      this.firing.delete(trigger.id);
    }
  }

  private recordBracketEntrySubmission(trigger: TriggerOrder): TriggerOrder {
    if (!trigger.meta?.bracket || trigger.meta.bracketEntrySubmittedAt) return trigger;
    const netQtyBefore = this.positions.get(trigger.symbol)?.netQty ?? 0;
    return this.store.update(trigger.id, {
      meta: {
        ...(trigger.meta ?? {}),
        bracketEntrySubmittedAt: Date.now(),
        bracketEntryNetQtyBefore: netQtyBefore,
      },
    }) ?? trigger;
  }

  private fireTimeCancel(trigger: TriggerOrder, marketPrice: number): void {
    const cancelled: TriggerOrder[] = [];
    if (trigger.cancelTriggerId) {
      const canceled = this.store.cancel(trigger.cancelTriggerId);
      if (canceled) cancelled.push(canceled);
    }
    if (trigger.cancelGroupId) cancelled.push(...this.store.cancelGroup(trigger.cancelGroupId, trigger.id));
    this.store.setStatus(trigger.id, "TRIGGERED", { firedAt: Date.now(), lastCheckedPrice: marketPrice });
    this.options.onAction?.(trigger, `Timed cancellation fired; cancelled ${cancelled.length} trigger(s).`);
  }

  private fireRiskGuardAction(trigger: TriggerOrder, marketPrice: number): void {
    if (trigger.riskAction === "CANCEL_TRIGGERS") {
      const cancelled: TriggerOrder[] = [];
      for (const open of this.store.active(trigger.symbol)) {
        if (open.id === trigger.id) continue;
        const canceled = this.store.cancel(open.id);
        if (canceled) cancelled.push(canceled);
      }
      this.store.setStatus(trigger.id, "TRIGGERED", { firedAt: Date.now(), lastCheckedPrice: marketPrice });
      this.options.onAction?.(trigger, `Risk guard fired; cancelled ${cancelled.length} trigger(s).`);
      return;
    }

    this.store.setStatus(trigger.id, "TRIGGERED", { firedAt: Date.now(), lastCheckedPrice: marketPrice });
    this.options.onAction?.(trigger, `Risk guard fired for ${trigger.symbol}.`);
  }

  private bracketEntryFillQuantity(parent: TriggerOrder): number {
    const position = this.positions.get(parent.symbol);
    if (!position) return 0;

    const before = Number(parent.meta?.bracketEntryNetQtyBefore ?? 0);
    const after = position.netQty;
    const opened = parent.side === "BUY"
      ? Math.max(0, after) - Math.max(0, before)
      : Math.max(0, -after) - Math.max(0, -before);
    if (opened <= 0) return 0;

    const target = positiveNumber(parent.quantity);
    const available = Math.abs(position.availableQty || position.netQty || 0);
    return Math.max(0, Math.min(opened, target ?? opened, available || opened));
  }

  private createBracketExits(parent: TriggerOrder, filledQuantity: number): TriggerOrder[] {
    const bracket = parent.meta?.bracket as any;
    if (!bracket || parent.meta?.bracketChildrenCreated) return [];

    const takeProfitPrice = positiveNumber(bracket.takeProfitPrice);
    const stopLossPrice = positiveNumber(bracket.stopLossPrice);
    if (!takeProfitPrice || !stopLossPrice) {
      this.options.onReject?.(parent, "Bracket requires positive takeProfitPrice and stopLossPrice");
      return [];
    }

    const exitSide = oppositeSide(parent.side);
    const useClosePosition = bracket.useClosePosition === true || parent.closePosition || parent.quantity === undefined;
    const groupId = `oco_${parent.id}`;
    const common = {
      ownerId: parent.ownerId,
      symbol: parent.symbol,
      side: exitSide,
      quantity: useClosePosition ? undefined : filledQuantity,
      closePosition: useClosePosition,
      reduceOnly: true,
      account: parent.account,
      paymentCurrency: parent.paymentCurrency,
      ocoGroupId: groupId,
      triggerSource: parent.triggerSource,
      meta: { parentTriggerId: parent.id, bracketExit: true, bracketExitQuantity: filledQuantity },
    };

    const stopLimitPrice = positiveNumber(bracket.stopLimitPrice);
    const children = this.store.addOco([
      { ...common, kind: "TAKE_PROFIT", triggerPrice: takeProfitPrice },
      stopLimitPrice
        ? { ...common, kind: "STOP_LIMIT", triggerPrice: stopLossPrice, limitPrice: stopLimitPrice }
        : { ...common, kind: "STOP_LOSS", triggerPrice: stopLossPrice },
    ] as any[], groupId);

    this.store.update(parent.id, { meta: { ...(parent.meta ?? {}), bracketChildrenCreated: true } });
    this.options.onAction?.(parent, `Bracket exits armed for ${parent.symbol} after position update.`);
    return children;
  }

  private syncBracketExitQuantities(parent: TriggerOrder, filledQuantity: number): TriggerOrder[] {
    const changed: TriggerOrder[] = [];
    for (const trigger of this.store.active(parent.symbol)) {
      if (!trigger.meta?.bracketExit || trigger.meta.parentTriggerId !== parent.id || trigger.closePosition) continue;
      if (roughlyEqual(trigger.quantity, filledQuantity)) continue;
      const next = this.store.update(trigger.id, {
        quantity: filledQuantity,
        meta: { ...(trigger.meta ?? {}), bracketExitQuantity: filledQuantity },
      });
      if (next) changed.push(next);
    }
    return changed;
  }
}
