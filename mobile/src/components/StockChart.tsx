// Pure React Native interactive Stock Price Chart (zero native SVG dependency — ships 100% over OTA!).
// Draws live price polyline, subtle area shading, interactive tap-to-inspect scrub,
// horizontal reference line & entry marker showing WHERE the user bought vs PRESENT state.
import React, { useMemo, useState } from "react";
import { LayoutChangeEvent, Pressable, StyleSheet, Text, View } from "react-native";
import type { StockChartPoint } from "../api/types";
import { COLORS, FONTS, RADIUS, createThemeStyles } from "../theme";

function formatShortDate(ms: number, range: string): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  if (range === "1D") {
    return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }
  if (range === "1W") {
    return d.toLocaleDateString("en-US", { weekday: "short", hour: "numeric" });
  }
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: range === "1Y" ? "2-digit" : undefined });
}

export function StockChart({
  points,
  range,
  avgBuyPrice,
  boughtAtIso,
  height = 200,
}: {
  points: StockChartPoint[];
  range: string;
  avgBuyPrice?: number | null;
  boughtAtIso?: string | null;
  height?: number;
}) {
  const [width, setWidth] = useState(0);
  const [activeIdx, setActiveIdx] = useState<number | null>(null);

  const onLayout = (e: LayoutChangeEvent) => {
    const w = Math.floor(e.nativeEvent.layout.width);
    if (w > 0 && Math.abs(w - width) > 2) setWidth(w);
  };

  const chartData = useMemo(() => {
    if (!points || points.length < 2 || width <= 40) return null;
    const padTop = 18;
    const padBottom = 18;
    const padLeft = 6;
    const padRight = 10;
    const plotW = Math.max(10, width - padLeft - padRight);
    const plotH = Math.max(40, height - padTop - padBottom);

    const prices = points.map((p) => p.price);
    if (avgBuyPrice && avgBuyPrice > 0) prices.push(avgBuyPrice);
    let minP = Math.min(...prices);
    let maxP = Math.max(...prices);
    if (Math.abs(maxP - minP) < 0.01) {
      minP -= 1;
      maxP += 1;
    }
    const span = maxP - minP;
    const yMin = minP - span * 0.08;
    const yMax = maxP + span * 0.08;
    const yRange = Math.max(0.0001, yMax - yMin);

    const toX = (i: number) => padLeft + (i / (points.length - 1)) * plotW;
    const toY = (price: number) => padTop + ((yMax - price) / yRange) * plotH;

    const coords = points.map((p, i) => ({
      x: toX(i),
      y: toY(p.price),
      t: p.t,
      price: p.price,
    }));

    const firstPrice = points[0].price;
    const lastPrice = points[points.length - 1].price;
    const isUp = lastPrice >= firstPrice;
    const lineColor = isUp ? COLORS.success : COLORS.danger;
    const fillColor = isUp ? "rgba(16, 185, 129, 0.14)" : "rgba(239, 68, 68, 0.14)";

    const segments = [];
    for (let i = 0; i < coords.length - 1; i++) {
      const a = coords[i];
      const b = coords[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      const angleRad = Math.atan2(dy, dx);
      segments.push({
        key: i,
        cx: (a.x + b.x) / 2,
        cy: (a.y + b.y) / 2,
        len: len + 0.8,
        angleDeg: (angleRad * 180) / Math.PI,
      });
    }

    // Determine buy entry marker coordinates (if user owns/bought this stock)
    let buyMarker: { x: number; y: number; inWindow: boolean } | null = null;
    let buyLineY: number | null = null;
    if (avgBuyPrice && avgBuyPrice > 0) {
      buyLineY = toY(avgBuyPrice);
      const boughtMs = boughtAtIso ? Date.parse(boughtAtIso) : NaN;
      const startMs = points[0].t;
      const endMs = points[points.length - 1].t;
      if (Number.isFinite(boughtMs) && boughtMs >= startMs && boughtMs <= endMs && endMs > startMs) {
        const frac = (boughtMs - startMs) / (endMs - startMs);
        buyMarker = { x: padLeft + frac * plotW, y: buyLineY, inWindow: true };
      } else {
        buyMarker = { x: padLeft + 8, y: buyLineY, inWindow: false };
      }
    }

    return {
      coords,
      segments,
      lineColor,
      fillColor,
      isUp,
      minP,
      maxP,
      plotW,
      plotH,
      padLeft,
      padTop,
      padBottom,
      buyLineY,
      buyMarker,
    };
  }, [points, width, height, avgBuyPrice, boughtAtIso]);

  const handleTouchX = (locX: number) => {
    if (!chartData || !chartData.coords.length) return;
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < chartData.coords.length; i++) {
      const d = Math.abs(chartData.coords[i].x - locX);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    setActiveIdx(best);
  };

  if (!points || points.length < 2) {
    return (
      <View style={[styles.emptyBox, { height }]}>
        <Text style={styles.emptyText}>Live chart data is loading or unavailable for this range.</Text>
      </View>
    );
  }

  const activePoint = activeIdx != null && chartData ? chartData.coords[activeIdx] : null;
  const lastCoord = chartData ? chartData.coords[chartData.coords.length - 1] : null;

  return (
    <View>
      {activePoint ? (
        <View style={styles.inspectBar}>
          <Text style={styles.inspectPrice}>${activePoint.price.toFixed(2)}</Text>
          <Text style={styles.inspectTime}>{formatShortDate(activePoint.t, range)}</Text>
          <Pressable onPress={() => setActiveIdx(null)} hitSlop={8}>
            <Text style={styles.inspectReset}>Now</Text>
          </Pressable>
        </View>
      ) : null}

      <Pressable
        onLayout={onLayout}
        onPress={(e) => handleTouchX(e.nativeEvent.locationX)}
        style={[styles.canvas, { height }]}
      >
        {chartData ? (
          <>
            {/* Horizontal subtle grid lines */}
            {[0.15, 0.5, 0.85].map((f, idx) => (
              <View
                key={idx}
                pointerEvents="none"
                style={[styles.gridLine, { top: chartData.padTop + f * chartData.plotH }]}
              />
            ))}

            {/* Soft gradient-style area columns beneath curve */}
            {chartData.coords.map((c, idx) => {
              const colW = Math.max(2, chartData.plotW / chartData.coords.length + 0.6);
              const colH = Math.max(0, height - chartData.padBottom - c.y);
              return (
                <View
                  key={`a-${idx}`}
                  pointerEvents="none"
                  style={{
                    position: "absolute",
                    left: c.x - colW / 2,
                    top: c.y,
                    width: colW,
                    height: colH,
                    backgroundColor: chartData.fillColor,
                  }}
                />
              );
            })}

            {/* User's Buy Entry Horizontal Reference Line */}
            {chartData.buyLineY !== null && avgBuyPrice ? (
              <>
                <View
                  pointerEvents="none"
                  style={[
                    styles.buyLine,
                    { top: chartData.buyLineY, left: chartData.padLeft, right: 8 },
                  ]}
                />
                <View
                  pointerEvents="none"
                  style={[
                    styles.buyTag,
                    {
                      top: Math.max(4, Math.min(height - 24, chartData.buyLineY - 22)),
                      left: chartData.padLeft + 4,
                    },
                  ]}
                >
                  <Text style={styles.buyTagText}>Bought ${avgBuyPrice.toFixed(2)}</Text>
                </View>
              </>
            ) : null}

            {/* Smooth polyline segments */}
            {chartData.segments.map((s) => (
              <View
                key={s.key}
                pointerEvents="none"
                style={{
                  position: "absolute",
                  left: s.cx - s.len / 2,
                  top: s.cy - 1.25,
                  width: s.len,
                  height: 2.5,
                  borderRadius: 1.5,
                  backgroundColor: chartData.lineColor,
                  transform: [{ rotate: `${s.angleDeg}deg` }],
                }}
              />
            ))}

            {/* Entry Buy Marker Dot */}
            {chartData.buyMarker ? (
              <View
                pointerEvents="none"
                style={[
                  styles.entryDotOuter,
                  { left: chartData.buyMarker.x - 7, top: chartData.buyMarker.y - 7 },
                ]}
              >
                <View style={styles.entryDotInner} />
              </View>
            ) : null}

            {/* Present State Live Dot */}
            {lastCoord ? (
              <View
                pointerEvents="none"
                style={[
                  styles.liveDotOuter,
                  {
                    left: lastCoord.x - 7,
                    top: lastCoord.y - 7,
                    backgroundColor: chartData.isUp ? "rgba(5,150,105,0.22)" : "rgba(220,38,38,0.22)",
                  },
                ]}
              >
                <View style={[styles.liveDotInner, { backgroundColor: chartData.lineColor }]} />
              </View>
            ) : null}

            {/* Selected Tap Crosshair */}
            {activePoint ? (
              <>
                <View
                  pointerEvents="none"
                  style={[styles.crosshair, { left: activePoint.x, top: 8, bottom: 8 }]}
                />
                <View
                  pointerEvents="none"
                  style={[
                    styles.activeDot,
                    {
                      left: activePoint.x - 6,
                      top: activePoint.y - 6,
                      borderColor: chartData.lineColor,
                    },
                  ]}
                />
              </>
            ) : null}

            {/* High / Low price labels */}
            <Text pointerEvents="none" style={[styles.axisLabel, { top: 2, right: 6 }]}>
              H ${chartData.maxP.toFixed(2)}
            </Text>
            <Text pointerEvents="none" style={[styles.axisLabel, { bottom: 2, right: 6 }]}>
              L ${chartData.minP.toFixed(2)}
            </Text>
          </>
        ) : null}
      </Pressable>

      {/* Time axis labels + legend */}
      <View style={styles.footerRow}>
        <Text style={styles.timeTick}>{formatShortDate(points[0].t, range)}</Text>
        <Text style={styles.hintTick}>Tap chart to inspect</Text>
        <Text style={styles.timeTick}>Present</Text>
      </View>
    </View>
  );
}

const styles = createThemeStyles(() => ({
  canvas: {
    width: "100%",
    backgroundColor: COLORS.page,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    overflow: "hidden",
    position: "relative",
  },
  emptyBox: {
    width: "100%",
    borderRadius: RADIUS.md,
    backgroundColor: COLORS.page,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
  },
  emptyText: {
    fontFamily: FONTS.medium,
    fontSize: 13,
    color: COLORS.textSecondary,
    textAlign: "center",
  },
  gridLine: {
    position: "absolute",
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: COLORS.border,
    opacity: 0.45,
  },
  buyLine: {
    position: "absolute",
    height: 0,
    borderTopWidth: 1.5,
    borderStyle: "dashed",
    borderColor: COLORS.textSecondary,
  },
  buyTag: {
    position: "absolute",
    backgroundColor: COLORS.surfaceElevated,
    borderWidth: 1,
    borderColor: COLORS.borderStrong,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  buyTagText: {
    fontFamily: FONTS.bold,
    fontSize: 10,
    color: COLORS.text,
  },
  entryDotOuter: {
    position: "absolute",
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: COLORS.borderStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  entryDotInner: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: COLORS.text,
    borderWidth: 1.5,
    borderColor: COLORS.surface,
  },
  liveDotOuter: {
    position: "absolute",
    width: 14,
    height: 14,
    borderRadius: 7,
    alignItems: "center",
    justifyContent: "center",
  },
  liveDotInner: {
    width: 8,
    height: 8,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: COLORS.surface,
  },
  crosshair: {
    position: "absolute",
    width: 1,
    backgroundColor: COLORS.borderStrong,
  },
  activeDot: {
    position: "absolute",
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: COLORS.surface,
    borderWidth: 3,
  },
  axisLabel: {
    position: "absolute",
    fontFamily: FONTS.semibold,
    fontSize: 10,
    color: COLORS.textMuted,
    backgroundColor: COLORS.surface,
    paddingHorizontal: 4,
    borderRadius: 4,
  },
  inspectBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: COLORS.surfaceElevated,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginBottom: 8,
  },
  inspectPrice: { fontFamily: FONTS.extrabold, fontSize: 14, color: COLORS.text },
  inspectTime: { fontFamily: FONTS.medium, fontSize: 12, color: COLORS.textSecondary },
  inspectReset: { fontFamily: FONTS.bold, fontSize: 12, color: COLORS.primary },
  footerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 6,
    paddingHorizontal: 2,
  },
  timeTick: { fontFamily: FONTS.medium, fontSize: 11, color: COLORS.textMuted },
  hintTick: { fontFamily: FONTS.medium, fontSize: 11, color: COLORS.textMuted },
}));
