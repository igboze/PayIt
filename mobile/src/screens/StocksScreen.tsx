// US Stocks & ETFs (powered by Pods Finance / Ondo Global Markets).
// Shows live US market open/closed status, official company logos, interactive price charts
// comparing when the user bought vs present state, and Passkey + PIN Buy/Sell flows.
import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { api } from "../api/client";
import type {
  StockCatalogItem,
  StockDetailResponse,
  StockHolding,
  StockMarketStatus,
  StocksOverviewResponse,
} from "../api/types";
import { useApp } from "../state/AppContext";
import { COLORS, DEPTH, FONTS, RADIUS, SPACING, TYPE } from "../theme";
import {
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  formatNgn,
  formatUsdc,
  Input,
  KeyValueRow,
  Pill,
  ScreenHeader,
  SectionHeader,
  SuccessBanner,
} from "../components/UI";
import { PressableScale } from "../components/Touch";
import { StockLogo } from "../components/StockLogo";
import { StockChart } from "../components/StockChart";

type RangeKey = "1D" | "1W" | "1M" | "3M" | "1Y";
const RANGES: RangeKey[] = ["1D", "1W", "1M", "3M", "1Y"];

function formatDateTime(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function MarketBanner({ market }: { market: StockMarketStatus }) {
  const open = market.isOpen;
  return (
    <View style={[styles.marketBanner, open ? styles.marketBannerOpen : styles.marketBannerClosed]}>
      <View style={styles.marketRowTop}>
        <View style={[styles.marketDot, { backgroundColor: open ? "#059669" : "#D97706" }]} />
        <Text style={[styles.marketTitle, { color: open ? "#065F46" : "#92400E" }]}>
          {market.label}
        </Text>
        <Text style={styles.marketEt}>{market.etTimeLabel}</Text>
      </View>
      <Text style={styles.marketSub}>{market.nextChangeLabel}</Text>
      <Text style={styles.marketHours}>{market.hoursLabel}</Text>
    </View>
  );
}

export function StocksScreen({ onBack }: { onBack: () => void }) {
  const { activeAccount, dataVersion, requestApproval } = useApp();
  const isBiz = activeAccount === "business";

  // Catalog / portfolio state
  const [overview, setOverview] = useState<StocksOverviewResponse | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Selected stock detail state
  const [selectedTicker, setSelectedTicker] = useState<string | null>(null);
  const [range, setRange] = useState<RangeKey>("1M");
  const [detail, setDetail] = useState<StockDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Trade inputs
  const [buyCurrency, setBuyCurrency] = useState<"NGN" | "USD">("NGN");
  const [buyAmount, setBuyAmount] = useState("");
  const [sellPct, setSellPct] = useState<25 | 50 | 100>(100);
  const [submitting, setSubmitting] = useState(false);

  const loadOverview = useCallback(
    async (query = "", isRefresh = false) => {
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const res = await api.getStocks(query.trim() || undefined, activeAccount);
        setOverview(res);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load stocks right now.");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [activeAccount]
  );

  useEffect(() => {
    const t = setTimeout(() => {
      loadOverview(search, false);
    }, search ? 280 : 0);
    return () => clearTimeout(t);
  }, [search, loadOverview, dataVersion]);

  const loadDetail = useCallback(
    async (ticker: string, rangeKey: RangeKey) => {
      setDetailLoading(true);
      setError(null);
      try {
        const res = await api.getStockChart(ticker, rangeKey, activeAccount);
        setDetail(res);
      } catch (err) {
        setError(err instanceof Error ? err.message : `Could not load ${ticker} chart.`);
      } finally {
        setDetailLoading(false);
      }
    },
    [activeAccount]
  );

  useEffect(() => {
    if (selectedTicker) {
      loadDetail(selectedTicker, range);
    }
  }, [selectedTicker, range, loadDetail, dataVersion]);

  const openStock = (ticker: string) => {
    setSelectedTicker(ticker);
    setRange("1M");
    setDetail(null);
    setBuyAmount("");
    setError(null);
    setNotice(null);
  };

  const handleBuy = async () => {
    if (!detail) return;
    setError(null);
    setNotice(null);
    const num = Number(buyAmount);
    const rate = detail.usdToNgnRate || overview?.usdToNgnRate || null;
    const minUsd = detail.minBuyUsd || 10;
    if (!Number.isFinite(num) || num <= 0) {
      setError("Enter a valid amount to invest.");
      return;
    }
    if (buyCurrency === "USD" && num < minUsd) {
      setError(`Minimum stock purchase is $${minUsd.toFixed(2)} USD.`);
      return;
    }
    if (buyCurrency === "NGN" && rate && num / rate < minUsd) {
      const minNgn = Math.ceil(minUsd * rate);
      setError(`Minimum stock purchase is ₦${minNgn.toLocaleString("en-NG")} (≈ $${minUsd}).`);
      return;
    }
    setSubmitting(true);
    try {
      const payload =
        buyCurrency === "NGN"
          ? { accountType: activeAccount, ticker: detail.stock.ticker, amountNgn: num }
          : { accountType: activeAccount, ticker: detail.stock.ticker, amountUsdc: num };
      const res = await requestApproval("stock.buy", payload);
      setNotice(res.notice || `Submitted ${detail.stock.ticker} buy order!`);
      setBuyAmount("");
      loadDetail(detail.stock.ticker, range);
      loadOverview(search, true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Stock purchase failed.";
      if (!/cancel/i.test(msg)) setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSell = async () => {
    if (!detail) return;
    setError(null);
    setNotice(null);
    setSubmitting(true);
    try {
      const res = await requestApproval("stock.sell", {
        accountType: activeAccount,
        ticker: detail.stock.ticker,
        percent: sellPct,
      });
      setNotice(res.notice || `Submitted ${detail.stock.ticker} sell order!`);
      loadDetail(detail.stock.ticker, range);
      loadOverview(search, true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Stock sale failed.";
      if (!/cancel/i.test(msg)) setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  // ── DETAIL VIEW FOR A SELECTED STOCK ────────────────────────────────────────
  if (selectedTicker) {
    const st = detail?.stock;
    const pos = detail?.position || null;
    const chart = detail?.chart;
    const mkt = detail?.market || overview?.market;
    const rate = detail?.usdToNgnRate || overview?.usdToNgnRate || null;
    const isUp = (chart?.changePct ?? st?.changePct24h ?? 0) >= 0;
    const buyNum = Number(buyAmount);
    const estUsdFromNgn = buyCurrency === "NGN" && rate && buyNum > 0 ? buyNum / rate : buyNum;
    const estShares = st?.price && st.price > 0 && estUsdFromNgn > 0 ? estUsdFromNgn / st.price : null;

    return (
      <View style={styles.root}>
        <ScreenHeader
          title={st ? `${st.ticker} · ${st.name}` : selectedTicker}
          subtitle={st ? `${st.exchange} · ${st.sector}` : "Loading live price & chart…"}
          onBack={() => {
            setSelectedTicker(null);
            setDetail(null);
            setError(null);
          }}
        />
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl
              refreshing={detailLoading}
              onRefresh={() => loadDetail(selectedTicker, range)}
              tintColor={COLORS.primary}
            />
          }
          keyboardShouldPersistTaps="handled"
        >
          <ErrorBanner message={error} onDismiss={() => setError(null)} />
          <SuccessBanner message={notice} onDismiss={() => setNotice(null)} />

          {mkt ? <MarketBanner market={mkt} /> : null}

          {detailLoading && !detail ? (
            <View style={{ paddingVertical: 40, alignItems: "center", gap: 10 }}>
              <ActivityIndicator color={COLORS.primary} />
              <Text style={styles.muted}>Loading live price chart…</Text>
            </View>
          ) : detail && st ? (
            <>
              {/* Stock Hero Price & Chart Card */}
              <Card>
                <View style={styles.detailHero}>
                  <StockLogo
                    ticker={st.ticker}
                    logoUrl={st.logoUrl}
                    fallbackLogoUrl={st.fallbackLogoUrl}
                    size={50}
                  />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.detailName} numberOfLines={1}>
                      {st.name}
                    </Text>
                    <Text style={styles.detailMeta}>
                      {st.ticker} · {st.exchange}
                    </Text>
                  </View>
                  <View style={[styles.changePill, { backgroundColor: isUp ? COLORS.primaryMuted : COLORS.dangerMuted }]}>
                    <Text style={[styles.changePillText, { color: isUp ? COLORS.successText : COLORS.dangerText }]}>
                      {chart?.changePct != null
                        ? `${chart.changePct >= 0 ? "+" : ""}${chart.changePct.toFixed(2)}%`
                        : st.changePct24h != null
                          ? `${st.changePct24h >= 0 ? "+" : ""}${st.changePct24h.toFixed(2)}%`
                          : "Live"}
                    </Text>
                  </View>
                </View>

                <Text style={styles.heroPrice}>
                  {st.price != null ? `$${st.price.toFixed(2)}` : "—"}
                </Text>
                {st.priceNgn != null ? (
                  <Text style={styles.heroPriceNgn}>≈ {formatNgn(st.priceNgn)} per share</Text>
                ) : null}

                {/* Interactive Chart with Bought vs Present Markers */}
                <View style={{ marginTop: 12 }}>
                  <StockChart
                    points={chart?.points || []}
                    range={range}
                    avgBuyPrice={pos?.avgBuyPrice ?? null}
                    boughtAtIso={pos?.firstBoughtAt ?? pos?.lastBoughtAt ?? null}
                    height={210}
                  />
                </View>

                {/* Range selector pills */}
                <View style={styles.rangeRow}>
                  {RANGES.map((r) => {
                    const active = range === r;
                    return (
                      <PressableScale
                        key={r}
                        onPress={() => setRange(r)}
                        haptic="selection"
                        style={[styles.rangeChip, active && styles.rangeChipOn]}
                      >
                        <Text style={[styles.rangeChipText, active && styles.rangeChipTextOn]}>{r}</Text>
                      </PressableScale>
                    );
                  })}
                </View>
              </Card>

              {/* Bought vs Present State Card (if user holds or has bought this stock) */}
              {pos ? (
                <Card style={{ borderColor: COLORS.primaryBorder }}>
                  <SectionHeader
                    title="Your Position · Entry vs Present"
                    right={
                      <Text
                        style={[
                          styles.pnlBadge,
                          { color: pos.pnlUsd >= 0 ? COLORS.successText : COLORS.dangerText },
                        ]}
                      >
                        {pos.pnlUsd >= 0 ? "+" : ""}
                        {formatUsdc(pos.pnlUsd)} ({pos.pnlPct >= 0 ? "+" : ""}
                        {pos.pnlPct.toFixed(2)}%)
                      </Text>
                    }
                  />
                  <View style={styles.compareGrid}>
                    <View style={styles.compareCol}>
                      <Text style={styles.compareLabel}>WHEN YOU BOUGHT</Text>
                      <Text style={styles.compareBig}>
                        {pos.avgBuyPrice ? `$${pos.avgBuyPrice.toFixed(2)}` : "Pending"}
                      </Text>
                      <Text style={styles.compareSub}>{formatDateTime(pos.firstBoughtAt || pos.lastBoughtAt)}</Text>
                    </View>
                    <View style={styles.compareDivider} />
                    <View style={styles.compareCol}>
                      <Text style={styles.compareLabel}>PRESENT STATE</Text>
                      <Text style={[styles.compareBig, { color: pos.pnlUsd >= 0 ? COLORS.successText : COLORS.dangerText }]}>
                        {pos.currentPrice ? `$${pos.currentPrice.toFixed(2)}` : "—"}
                      </Text>
                      <Text style={styles.compareSub}>
                        Value: {pos.currentValueNgn ? formatNgn(pos.currentValueNgn) : formatUsdc(pos.currentValueUsd)}
                      </Text>
                    </View>
                  </View>

                  <KeyValueRow label="Shares owned" value={`${pos.shares.toFixed(4)} ${st.ticker}`} />
                  <KeyValueRow
                    label="Current value"
                    value={
                      pos.currentValueNgn
                        ? `${formatNgn(pos.currentValueNgn)} (${formatUsdc(pos.currentValueUsd)})`
                        : formatUsdc(pos.currentValueUsd)
                    }
                  />
                  {pos.pendingBuyUsd > 0 ? (
                    <KeyValueRow label="Pending settlement" value={`${formatUsdc(pos.pendingBuyUsd)} (~2–5 min)`} />
                  ) : null}

                  {pos.purchases.length > 0 ? (
                    <View style={{ marginTop: 10 }}>
                      <Text style={styles.subSectionTitle}>Purchase History</Text>
                      {pos.purchases.slice(0, 5).map((p) => (
                        <KeyValueRow
                          key={p.id}
                          currency={false}
                          label={`${formatDateTime(p.timestamp)} · ${p.status}`}
                          value={`${formatUsdc(p.amountUsd)}${p.priceAtBuy ? ` @ $${p.priceAtBuy.toFixed(2)}` : ""}`}
                        />
                      ))}
                    </View>
                  ) : null}

                  {pos.shares > 0 ? (
                    <View style={{ marginTop: 14 }}>
                      <Text style={styles.subSectionTitle}>Sell {st.ticker}</Text>
                      <View style={styles.pillRow}>
                        {([25, 50, 100] as const).map((pct) => (
                          <Pill
                            key={pct}
                            label={pct === 100 ? "Sell 100%" : `${pct}%`}
                            active={sellPct === pct}
                            onPress={() => setSellPct(pct)}
                          />
                        ))}
                      </View>
                      <Button
                        title={`Sell ${sellPct}% of ${st.ticker}`}
                        variant="secondary"
                        onPress={handleSell}
                        loading={submitting}
                      />
                    </View>
                  ) : null}
                </Card>
              ) : null}

              {/* Buy Stock Card */}
              <Card>
                <SectionHeader
                  title={`Buy ${st.ticker}`}
                  right={
                    <View style={{ flexDirection: "row", gap: 6 }}>
                      <Pill label="₦ NGN" active={buyCurrency === "NGN"} onPress={() => { setBuyCurrency("NGN"); setBuyAmount(""); }} />
                      <Pill label="$ USD" active={buyCurrency === "USD"} onPress={() => { setBuyCurrency("USD"); setBuyAmount(""); }} />
                    </View>
                  }
                />

                {!detail.configured ? (
                  <View style={styles.warnBox}>
                    <Ionicons name="information-circle-outline" size={18} color="#92400E" />
                    <Text style={styles.warnText}>
                      Live price charts are active. Stock order execution is finishing backend activation.
                    </Text>
                  </View>
                ) : null}

                {mkt && !mkt.tradable ? (
                  <View style={styles.warnBox}>
                    <Ionicons name="time-outline" size={18} color="#92400E" />
                    <Text style={styles.warnText}>
                      {st.ticker} trading is currently paused ({mkt.blockingReason || mkt.label}). {mkt.nextChangeLabel}.
                    </Text>
                  </View>
                ) : null}

                <View style={styles.presetRow}>
                  {(buyCurrency === "NGN" ? [20000, 50000, 100000, 250000] : [15, 25, 50, 100]).map((amt) => (
                    <PressableScale
                      key={amt}
                      onPress={() => setBuyAmount(String(amt))}
                      style={[styles.presetChip, Number(buyAmount) === amt && styles.presetChipOn]}
                    >
                      <Text style={[styles.presetText, Number(buyAmount) === amt && { color: COLORS.primaryDark }]}>
                        {buyCurrency === "NGN" ? `₦${amt.toLocaleString("en-NG")}` : `$${amt}`}
                      </Text>
                    </PressableScale>
                  ))}
                </View>

                <Input
                  label={buyCurrency === "NGN" ? "Amount to invest (₦ Naira)" : "Amount to invest ($ USD)"}
                  placeholder={buyCurrency === "NGN" ? "e.g. 25000" : "e.g. 25"}
                  value={buyAmount}
                  onChangeText={(t) => setBuyAmount(t.replace(/[^\d.]/g, ""))}
                  keyboardType="decimal-pad"
                  currency={buyCurrency}
                  hint={
                    estShares && estUsdFromNgn > 0
                      ? `≈ ${estShares.toFixed(4)} shares ($${estUsdFromNgn.toFixed(2)}) · Min $${detail.minBuyUsd}`
                      : `Minimum purchase $${detail.minBuyUsd} USD. Approved with passkey & PIN.`
                  }
                />

                <Button
                  title={
                    buyNum > 0
                      ? `Buy ${st.ticker} (${buyCurrency === "NGN" ? formatNgn(buyNum) : formatUsdc(buyNum)})`
                      : `Buy ${st.ticker}`
                  }
                  onPress={handleBuy}
                  loading={submitting}
                  disabled={!detail.configured}
                />
              </Card>
            </>
          ) : null}
        </ScrollView>
      </View>
    );
  }

  // ── MAIN STOCKS DISCOVERY & PORTFOLIO LIST ──────────────────────────────────
  const portfolio = overview?.portfolio;
  const holdings: StockHolding[] = portfolio?.holdings || [];
  const stocks: StockCatalogItem[] = overview?.stocks || [];

  return (
    <View style={styles.root}>
      <ScreenHeader
        title="US Stocks & ETFs"
        subtitle={`${isBiz ? "Business" : "Personal"} · Powered by Ondo Global Markets`}
        onBack={onBack}
      />

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => loadOverview(search, true)}
            tintColor={COLORS.primary}
          />
        }
        keyboardShouldPersistTaps="handled"
      >
        <ErrorBanner message={error} onDismiss={() => setError(null)} />
        <SuccessBanner message={notice} onDismiss={() => setNotice(null)} />

        {overview?.market ? <MarketBanner market={overview.market} /> : null}

        {/* Portfolio Summary Card */}
        {portfolio && holdings.length > 0 ? (
          <Card style={{ borderColor: COLORS.primaryBorder }}>
            <SectionHeader title="Your Stock Portfolio" />
            <Text style={styles.portBigNgn}>
              {portfolio.totalValueNgn != null
                ? formatNgn(portfolio.totalValueNgn)
                : formatUsdc(portfolio.totalValueUsd)}
            </Text>
            <View style={styles.portSubRow}>
              <Text style={styles.portSubUsd}>{formatUsdc(portfolio.totalValueUsd)}</Text>
              <Text
                style={[
                  styles.portPnl,
                  { color: portfolio.totalPnlUsd >= 0 ? COLORS.successText : COLORS.dangerText },
                ]}
              >
                {portfolio.totalPnlUsd >= 0 ? "+" : ""}
                {formatUsdc(portfolio.totalPnlUsd)} ({portfolio.totalPnlPct >= 0 ? "+" : ""}
                {portfolio.totalPnlPct.toFixed(2)}%)
              </Text>
            </View>

            <View style={{ marginTop: 12, gap: 8 }}>
              {holdings.map((h) => {
                const up = h.pnlUsd >= 0;
                return (
                  <PressableScale key={h.ticker} onPress={() => openStock(h.ticker)} style={styles.stockRow}>
                    <StockLogo
                      ticker={h.ticker}
                      logoUrl={h.logoUrl}
                      fallbackLogoUrl={h.fallbackLogoUrl}
                      size={40}
                    />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={styles.stockTicker} numberOfLines={1}>
                        {h.ticker} · {h.shares > 0 ? `${h.shares.toFixed(4)} sh` : "Pending"}
                      </Text>
                      <Text style={styles.stockName} numberOfLines={1}>
                        Bought {h.avgBuyPrice ? `@ $${h.avgBuyPrice.toFixed(2)}` : "recently"}
                      </Text>
                    </View>
                    <View style={{ alignItems: "flex-end" }}>
                      <Text style={styles.stockPrice}>
                        {h.currentValueNgn ? formatNgn(h.currentValueNgn) : formatUsdc(h.currentValueUsd)}
                      </Text>
                      <Text style={[styles.stockChange, { color: up ? COLORS.successText : COLORS.dangerText }]}>
                        {up ? "+" : ""}
                        {h.pnlPct.toFixed(2)}%
                      </Text>
                    </View>
                  </PressableScale>
                );
              })}
            </View>
          </Card>
        ) : null}

        {/* Search & Stock List */}
        <Card>
          <SectionHeader title={search.trim() ? "Search results" : "Popular US Stocks & ETFs"} />
          <Input
            label="Search by ticker or company"
            placeholder="AAPL, NVDA, TSLA, SPY, Amazon…"
            value={search}
            onChangeText={setSearch}
            autoCapitalize="characters"
            currency={false}
          />

          {loading && !overview ? (
            <View style={{ paddingVertical: 28, alignItems: "center", gap: 8 }}>
              <ActivityIndicator color={COLORS.primary} />
              <Text style={styles.muted}>Loading live US stock prices…</Text>
            </View>
          ) : stocks.length === 0 ? (
            <EmptyState
              icon="trending-up-outline"
              title="No matching stocks"
              subtitle="Try searching a US stock ticker like AAPL, NVDA, TSLA, MSFT, or SPY."
            />
          ) : (
            <View style={{ gap: 8 }}>
              {stocks.map((s) => {
                const up = (s.changePct24h ?? 0) >= 0;
                return (
                  <PressableScale key={s.ticker} onPress={() => openStock(s.ticker)} style={styles.stockRow}>
                    <StockLogo
                      ticker={s.ticker}
                      logoUrl={s.logoUrl}
                      fallbackLogoUrl={s.fallbackLogoUrl}
                      size={42}
                    />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                        <Text style={styles.stockTicker}>{s.ticker}</Text>
                        {s.ownedShares > 0 ? (
                          <View style={styles.ownedBadge}>
                            <Text style={styles.ownedBadgeText}>Owned</Text>
                          </View>
                        ) : null}
                      </View>
                      <Text style={styles.stockName} numberOfLines={1}>
                        {s.name}
                      </Text>
                    </View>
                    <View style={{ alignItems: "flex-end" }}>
                      <Text style={styles.stockPrice}>{s.price != null ? `$${s.price.toFixed(2)}` : "View"}</Text>
                      {s.changePct24h != null ? (
                        <Text style={[styles.stockChange, { color: up ? COLORS.successText : COLORS.dangerText }]}>
                          {up ? "+" : ""}
                          {s.changePct24h.toFixed(2)}%
                        </Text>
                      ) : (
                        <Text style={styles.muted}>{s.sector}</Text>
                      )}
                    </View>
                    <Ionicons name="chevron-forward" size={16} color={COLORS.textMuted} />
                  </PressableScale>
                );
              })}
            </View>
          )}
        </Card>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.bg },
  content: { padding: SPACING.md, paddingBottom: 48, gap: 12 },
  muted: { fontFamily: FONTS.regular, fontSize: 12, color: COLORS.textSecondary },
  marketBanner: {
    borderRadius: RADIUS.md,
    padding: 12,
    borderWidth: 1,
    gap: 3,
  },
  marketBannerOpen: {
    backgroundColor: "#ECFDF5",
    borderColor: "#A7F3D0",
  },
  marketBannerClosed: {
    backgroundColor: "#FFFBEB",
    borderColor: "#FDE68A",
  },
  marketRowTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  marketDot: { width: 9, height: 9, borderRadius: 5 },
  marketTitle: { fontFamily: FONTS.extrabold, fontSize: 14, flex: 1 },
  marketEt: { fontFamily: FONTS.semibold, fontSize: 11, color: COLORS.textSecondary },
  marketSub: { fontFamily: FONTS.semibold, fontSize: 13, color: COLORS.text },
  marketHours: { fontFamily: FONTS.regular, fontSize: 11, color: COLORS.textSecondary },
  portBigNgn: { ...TYPE.title, fontSize: 28, color: COLORS.text },
  portSubRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 2 },
  portSubUsd: { fontFamily: FONTS.bold, fontSize: 14, color: COLORS.textSecondary },
  portPnl: { fontFamily: FONTS.bold, fontSize: 13 },
  stockRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 11,
    borderRadius: RADIUS.md,
    backgroundColor: COLORS.page,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  stockTicker: { fontFamily: FONTS.extrabold, fontSize: 15, color: COLORS.text },
  stockName: { fontFamily: FONTS.regular, fontSize: 12, color: COLORS.textSecondary, marginTop: 1 },
  stockPrice: { fontFamily: FONTS.bold, fontSize: 14, color: COLORS.text },
  stockChange: { fontFamily: FONTS.semibold, fontSize: 12, marginTop: 1 },
  ownedBadge: {
    backgroundColor: COLORS.primaryMuted,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 6,
  },
  ownedBadgeText: { fontFamily: FONTS.bold, fontSize: 10, color: COLORS.primaryDark },
  detailHero: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 10 },
  detailName: { fontFamily: FONTS.extrabold, fontSize: 17, color: COLORS.text },
  detailMeta: { fontFamily: FONTS.medium, fontSize: 12, color: COLORS.textSecondary },
  changePill: { borderRadius: RADIUS.pill, paddingHorizontal: 10, paddingVertical: 4 },
  changePillText: { fontFamily: FONTS.bold, fontSize: 12 },
  heroPrice: { fontFamily: FONTS.extrabold, fontSize: 34, color: COLORS.text, letterSpacing: -0.8 },
  heroPriceNgn: { fontFamily: FONTS.semibold, fontSize: 14, color: COLORS.textSecondary, marginTop: 2 },
  rangeRow: { flexDirection: "row", gap: 8, marginTop: 12 },
  rangeChip: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: RADIUS.sm,
    alignItems: "center",
    backgroundColor: COLORS.page,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  rangeChipOn: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  rangeChipText: { fontFamily: FONTS.bold, fontSize: 12, color: COLORS.textSecondary },
  rangeChipTextOn: { color: COLORS.onPrimary },
  pnlBadge: { fontFamily: FONTS.bold, fontSize: 12 },
  compareGrid: {
    flexDirection: "row",
    backgroundColor: COLORS.page,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 12,
    marginBottom: 10,
  },
  compareCol: { flex: 1, gap: 2 },
  compareDivider: { width: 1, backgroundColor: COLORS.border, marginHorizontal: 10 },
  compareLabel: { fontFamily: FONTS.bold, fontSize: 10, color: COLORS.textMuted, letterSpacing: 0.6 },
  compareBig: { fontFamily: FONTS.extrabold, fontSize: 18, color: COLORS.text },
  compareSub: { fontFamily: FONTS.medium, fontSize: 11, color: COLORS.textSecondary },
  subSectionTitle: { fontFamily: FONTS.bold, fontSize: 13, color: COLORS.text, marginBottom: 6 },
  pillRow: { flexDirection: "row", gap: 8, marginBottom: 10 },
  presetRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 12 },
  presetChip: {
    ...DEPTH.raised,
    flexBasis: "22%",
    flexGrow: 1,
    paddingVertical: 9,
    borderRadius: RADIUS.sm,
    backgroundColor: COLORS.page,
    alignItems: "center",
  },
  presetChipOn: { borderColor: COLORS.primary, borderWidth: 2, backgroundColor: COLORS.deep },
  presetText: { fontFamily: FONTS.bold, fontSize: 12, color: COLORS.text },
  warnBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    padding: 10,
    borderRadius: RADIUS.sm,
    backgroundColor: "#FFFBEB",
    borderWidth: 1,
    borderColor: "#FDE68A",
    marginBottom: 12,
  },
  warnText: { flex: 1, fontFamily: FONTS.medium, fontSize: 12, color: "#92400E" },
});
