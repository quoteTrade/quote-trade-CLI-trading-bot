export type PositionSide = "FLAT" | "LONG" | "SHORT";

/**
 * Tracks the logical position side and the "cycle" counters used for the
 */
export class PositionManager {
    side: PositionSide = "FLAT";
    qtyAbs: number = 0; // local estimate for logging only (Step 3 will use WS)
    cycleSide: "upper" | "lower" | null = null;
    ordersInCycle = 0;        // 0..maxOrdersPerCycle (default 2)
    armed = true;             // trade allowed when true (re-armed after neutral exit)
    inflight = false;         // block new submits until WS terminal in Step 3

    constructor(public readonly maxOrdersPerCycle: number = 2) {}

    /** Called when RSI crosses into a band; resets if switching sides. */
    enterBand(side: "upper" | "lower") {
        if (this.cycleSide !== side) {
            this.cycleSide = side;
            this.ordersInCycle = 0;
            this.armed = true;
        }
    }

    /** Called when RSI returns to neutral (between low/high). */
    rearmFromNeutral() {
        this.armed = true;
    }

    /** Consume one order opportunity in current cycle and disarm. */
    consumeAndDisarm() {
        this.ordersInCycle = Math.min(this.ordersInCycle + 1, this.maxOrdersPerCycle);
        this.armed = false;
    }

    // ---- Local position bookkeeping (Step 2; WS will own this in Step 3) ----
    setFlat() { this.side = "FLAT"; this.qtyAbs = 0; }
    setLong(qtyAbs: number) { this.side = "LONG"; this.qtyAbs = qtyAbs; }
    setShort(qtyAbs: number) { this.side = "SHORT"; this.qtyAbs = qtyAbs; }
}
