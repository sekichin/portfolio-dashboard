const simulatorQuery = new URLSearchParams(location.search);
const simulatorCookieMode = document.cookie.split(';').map(item => item.trim()).find(item => item.startsWith('portfolio_mode='))?.split('=')[1] || '';
const simulatorStoredMode = localStorage.getItem('portfolioSessionMode') || '';
const simulatorRequestedMode = simulatorQuery.get('mode') || '';
const simulatorRequestedUserId = simulatorQuery.get('user') || '';
const simulatorSessionMode = ['owner', 'friend'].includes(simulatorRequestedMode)
  ? simulatorRequestedMode
  : simulatorRequestedMode === 'user'
    ? 'user'
  : ['owner', 'friend', 'user'].includes(simulatorCookieMode)
    ? simulatorCookieMode
    : ['owner', 'friend', 'user'].includes(simulatorStoredMode) ? simulatorStoredMode : '';
if (simulatorSessionMode) localStorage.setItem('portfolioSessionMode', simulatorSessionMode);
const simulatorRequestedProfile = simulatorQuery.get('profile');
const simulatorLocalMode = simulatorQuery.get('local') === '1' || Boolean(simulatorRequestedProfile) || ['friend', 'user'].includes(simulatorSessionMode);
const simulatorProfileToken = simulatorLocalMode ? (simulatorRequestedProfile || (simulatorSessionMode === 'friend' ? 'session' : null)) : null;
const simulatorQueryToken = simulatorQuery.get('token');
if (simulatorQueryToken && !simulatorLocalMode) localStorage.setItem('portfolioAccessToken', simulatorQueryToken);
const simulatorAccessToken = simulatorLocalMode ? null : simulatorQueryToken || localStorage.getItem('portfolioAccessToken');
const simulatorHasRemoteSession = Boolean((simulatorSessionMode && simulatorSessionMode !== 'user') || simulatorProfileToken || simulatorAccessToken);
const simulatorCloudDeployment = location.hostname.endsWith('.vercel.app');
const LEGACY_STORAGE_KEY = 'portfolio-goal-simulator-v1';
const simulatorStorageScope = simulatorRequestedProfile
  ? `profile-${simulatorRequestedProfile.slice(0, 12)}`
  : simulatorSessionMode === 'user' && simulatorRequestedUserId
    ? `user-${simulatorRequestedUserId}`
    : simulatorSessionMode || 'owner';
const STORAGE_KEY = `${LEGACY_STORAGE_KEY}:${simulatorStorageScope}`;
const DIRTY_KEY = `${STORAGE_KEY}:dirty`;
const LEGACY_OWNER_STATE = simulatorStorageScope === 'owner' ? localStorage.getItem(LEGACY_STORAGE_KEY) : null;
const hadLocalSimulatorState = Boolean(
  localStorage.getItem(STORAGE_KEY)
  || LEGACY_OWNER_STATE
);
const yen = new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY', maximumFractionDigits: 0 });
const monthLabel = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short' });
let chart;
let syncedPortfolio = null;
let syncedPerformance = null;
let quoteStream = null;
let liveSyncTimer = null;
let remoteSettingsReady = false;
let remoteSaveTimer = null;
let accountAiUsage = null;
const ASSET_COLORS = {
  us: '#426af4',
  fund: '#12ad7d',
  jp: '#e55269',
  gold: '#f2b11f',
  cash: '#89958f'
};
const FALLBACK_ASSET_COLORS = ['#8a71d6', '#4a98b8', '#b17d52'];

function assetColor(asset, alpha = 1) {
  const hex = ASSET_COLORS[asset.id] || FALLBACK_ASSET_COLORS[state.assetTypes.indexOf(asset) % FALLBACK_ASSET_COLORS.length];
  if (alpha >= 1) return hex;
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${value >> 16},${value >> 8 & 255},${value & 255},${alpha})`;
}

function authenticatedSimulatorUrl(url) {
  return simulatorAccessToken ? `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(simulatorAccessToken)}` : url;
}

function profileSimulatorUrl(url) {
  return simulatorProfileToken === 'session'
    ? url
    : `${url}?profile=${encodeURIComponent(simulatorProfileToken || '')}`;
}

function monthValue(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function defaultAssetTypes() {
  return [
    { id: 'us', name: '美股', amount: 2714773, bearRate: 0, annualRate: 18, bullRate: 30, usdExposurePct: 100 },
    { id: 'fund', name: '基金', amount: 1536594, bearRate: 1, annualRate: 16, bullRate: 26, usdExposurePct: 100 },
    { id: 'jp', name: '日股', amount: 329039, bearRate: 1, annualRate: 9, bullRate: 16, usdExposurePct: 0 },
    { id: 'gold', name: '黄金', amount: 641873, bearRate: 0, annualRate: 8, bullRate: 14, usdExposurePct: 100 }
  ];
}

function defaultState() {
  const currentMonth = monthValue();
  return {
    targetAssets: 25000000,
    targetDate: '2030-12',
    scenarioSpread: 5,
    chartView: 'bar',
    projectionScenario: 'base',
    interfaceVersion: 2,
    fxStressPct: 0,
    currentUsdJpy: 159.31,
    assetEditorOpen: true,
    aiAnalysis: null,
    updatedAt: new Date().toISOString(),
    assetTypes: defaultAssetTypes(),
    plans: [
      { id: crypto.randomUUID(), name: 'FANG+', assetTypeId: 'fund', amount: 40000, frequency: 'monthly', startMonth: currentMonth, endMonth: '', bonusPct: 0 },
      { id: crypto.randomUUID(), name: 'S&P500', assetTypeId: 'fund', amount: 10000, frequency: 'monthly', startMonth: currentMonth, endMonth: '', bonusPct: 0 },
      { id: crypto.randomUUID(), name: '黄金', assetTypeId: 'gold', amount: 5000, frequency: 'monthly', startMonth: currentMonth, endMonth: '', bonusPct: 0 },
      { id: crypto.randomUUID(), name: '住友持股会', assetTypeId: 'jp', amount: 50000, frequency: 'monthly', startMonth: currentMonth, endMonth: '', bonusPct: 10 }
    ]
  };
}

function inferredAssetType(planName) {
  const name = String(planName || '').toLowerCase();
  if (name.includes('黄金') || name.includes('gold')) return 'gold';
  if (name.includes('住友') || name.includes('日股')) return 'jp';
  if (name.includes('fang') || name.includes('s&p') || name.includes('sp500') || name.includes('基金')) return 'fund';
  return 'us';
}

function normalizeState(value) {
  const defaults = defaultState();
  if (!value || typeof value !== 'object') return defaults;
  const legacySpread = Math.max(0, Number(value.scenarioSpread ?? defaults.scenarioSpread));
  const assetTypes = Array.isArray(value.assetTypes) && value.assetTypes.length
    ? value.assetTypes.map((asset, index) => {
      const annualRate = Math.max(-99, Math.min(500, Number(asset.annualRate || 0)));
      const hasBearRate = asset.bearRate !== null && asset.bearRate !== undefined && Number.isFinite(Number(asset.bearRate));
      const hasBullRate = asset.bullRate !== null && asset.bullRate !== undefined && Number.isFinite(Number(asset.bullRate));
      return {
        id: String(asset.id || `asset-${index}-${crypto.randomUUID()}`),
        name: String(asset.name || '资产类型'),
        amount: Math.max(0, Number(asset.amount || 0)),
        annualRate,
        bearRate: Math.max(-99, Math.min(500, hasBearRate ? Number(asset.bearRate) : annualRate - legacySpread)),
        bullRate: Math.max(-99, Math.min(500, hasBullRate ? Number(asset.bullRate) : annualRate + legacySpread)),
        usdExposurePct: Math.min(100, Math.max(0, Number(asset.usdExposurePct ?? (['us', 'fund', 'gold'].includes(asset.id) ? 100 : 0))))
      };
    })
    : defaultAssetTypes();
  const validIds = new Set(assetTypes.map(asset => asset.id));
  return {
    targetAssets: Math.max(0, Number(value.targetAssets ?? defaults.targetAssets)),
    targetDate: value.targetDate || defaults.targetDate,
    scenarioSpread: legacySpread,
    chartView: Number(value.interfaceVersion || 0) < 2 ? 'bar' : value.chartView === 'line' ? 'line' : 'bar',
    projectionScenario: ['bear', 'base', 'bull'].includes(value.projectionScenario) ? value.projectionScenario : 'base',
    interfaceVersion: 2,
    fxStressPct: Math.min(30, Math.max(-30, Number(value.fxStressPct || 0))),
    currentUsdJpy: Math.max(1, Number(value.currentUsdJpy || 159.31)),
    assetEditorOpen: value.assetEditorOpen !== false,
    aiAnalysis: value.aiAnalysis && typeof value.aiAnalysis === 'object'
      ? {
        forecast: value.aiAnalysis.forecast && typeof value.aiAnalysis.forecast === 'object' ? value.aiAnalysis.forecast : null,
        report: value.aiAnalysis.report && typeof value.aiAnalysis.report === 'object' ? value.aiAnalysis.report : null
      }
      : null,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
    assetTypes,
    plans: Array.isArray(value.plans) ? value.plans.map(plan => {
      const proposedType = plan.assetTypeId || inferredAssetType(plan.name);
      return {
        id: plan.id || crypto.randomUUID(),
        name: String(plan.name || '定投'),
        assetTypeId: validIds.has(proposedType) ? proposedType : assetTypes[0].id,
        amount: Math.max(0, Number(plan.amount || 0)),
        frequency: plan.frequency === 'yearly' ? 'yearly' : 'monthly',
        startMonth: plan.startMonth || monthValue(),
        endMonth: plan.endMonth || '',
        bonusPct: Math.max(0, Number(plan.bonusPct || 0))
      };
    }) : defaults.plans
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
      || LEGACY_OWNER_STATE;
    const loaded = normalizeState(JSON.parse(raw));
    if (raw && !localStorage.getItem(STORAGE_KEY)) localStorage.setItem(STORAGE_KEY, JSON.stringify(loaded));
    return loaded;
  }
  catch { return defaultState(); }
}

let state = loadState();

function currentAssets() {
  return state.assetTypes.reduce((sum, asset) => sum + Math.max(0, Number(asset.amount || 0)), 0);
}

function holdingValueJPY(holding, fxRate) {
  const quotePrice = Number(holding.quote?.price);
  const units = Number(holding.units);
  if (Number.isFinite(quotePrice) && Number.isFinite(units) && units > 0) {
    if (holding.quote?.currency === 'USD') return quotePrice * units * fxRate;
    const scale = holding.fundId || (!holding.symbol && holding.market === 'JP' && holding.name !== '黄金') ? 10000 : 1;
    return quotePrice * units / scale;
  }
  return Math.max(0, Number(holding.valueJPY || 0));
}

function holdingCostJPY(holding) {
  const units = Number(holding.units);
  const buyPrice = Number(holding.buyPrice ?? holding.avgCost);
  if (Number.isFinite(units) && Number.isFinite(buyPrice) && units > 0) {
    const scale = holding.fundId || (!holding.symbol && holding.market === 'JP' && holding.name !== '黄金') ? 10000 : 1;
    return buyPrice * units / scale;
  }
  return Math.max(0, Number(holding.valueJPY || 0) - Number(holding.profitJPY || 0));
}

const performanceDayMilliseconds = 86400000;
function groupedCashFlows(cashFlows) {
  const grouped = new Map();
  cashFlows.forEach(cashFlow => {
    const amount = Number(cashFlow.amount || 0);
    if (!cashFlow.date || !Number.isFinite(amount) || Math.abs(amount) < 0.005) return;
    grouped.set(cashFlow.date, (grouped.get(cashFlow.date) || 0) + amount);
  });
  return [...grouped.entries()].map(([date, amount]) => ({ date, amount })).filter(item => Math.abs(item.amount) >= 0.005).sort((left, right) => left.date.localeCompare(right.date));
}
function xnpv(rate, cashFlows) {
  if (rate <= -1 || !cashFlows.length) return Number.NaN;
  const firstDate = new Date(`${cashFlows[0].date}T12:00:00Z`);
  return cashFlows.reduce((total, cashFlow) => {
    const date = new Date(`${cashFlow.date}T12:00:00Z`);
    const years = (date - firstDate) / performanceDayMilliseconds / 365.2425;
    return total + cashFlow.amount / ((1 + rate) ** years);
  }, 0);
}
function xirr(cashFlows) {
  const flows = groupedCashFlows(cashFlows);
  if (!flows.some(item => item.amount < 0) || !flows.some(item => item.amount > 0)) return null;
  let lower = -0.9999;
  let upper = 1;
  let lowerValue = xnpv(lower, flows);
  let upperValue = xnpv(upper, flows);
  while (Number.isFinite(upperValue) && lowerValue * upperValue > 0 && upper < 1000000) {
    upper = upper * 2 + 1;
    upperValue = xnpv(upper, flows);
  }
  if (!Number.isFinite(lowerValue) || !Number.isFinite(upperValue) || lowerValue * upperValue > 0) return null;
  for (let iteration = 0; iteration < 180; iteration += 1) {
    const middle = (lower + upper) / 2;
    const middleValue = xnpv(middle, flows);
    if (!Number.isFinite(middleValue)) return null;
    if (Math.abs(middleValue) < 0.001) return middle;
    if (lowerValue * middleValue <= 0) upper = middle;
    else {
      lower = middle;
      lowerValue = middleValue;
    }
  }
  return (lower + upper) / 2;
}
function historyPointReturnBase(point) {
  const profit = Number(point?.dailyProfitJPY || 0);
  const storedReturn = Number(point?.dailyReturnRate);
  if (Number.isFinite(storedReturn) && Math.abs(storedReturn) > 1e-12) {
    const inferredBase = profit / storedReturn;
    if (Number.isFinite(inferredBase) && inferredBase > 0) return inferredBase;
  }
  const closingValue = Number(point?.totalNetAsset ?? point?.totalAssetsJPY ?? 0);
  const cashFlow = Number(point?.netExternalCashFlowJPY || 0);
  const weightedFlow = Number(point?.weightedExternalCashFlowJPY || 0);
  const fallbackBase = closingValue - profit - cashFlow + weightedFlow;
  return Number.isFinite(fallbackBase) && fallbackBase > 0 ? fallbackBase : 0;
}

function historyPointDailyReturn(point) {
  const storedReturn = Number(point?.dailyReturnRate);
  if (Number.isFinite(storedReturn) && 1 + storedReturn > 0) return storedReturn;
  const returnBase = historyPointReturnBase(point);
  const derivedReturn = returnBase > 0 ? Number(point?.dailyProfitJPY || 0) / returnBase : null;
  return Number.isFinite(derivedReturn) && 1 + derivedReturn > 0 ? derivedReturn : null;
}

function timeWeightedPerformance(data, totalAssets) {
  const history = data.history || [];
  if (!history.length) return { annualizedRate: null, startDate: null };
  let growth = 1;
  let startDate = null;
  let endDate = null;
  for (const record of history) {
    const dailyReturn = historyPointDailyReturn(record);
    if (dailyReturn === null) continue;
    growth *= 1 + dailyReturn;
    startDate ||= record.date;
    endDate = record.date;
  }
  if (!startDate || !endDate || growth <= 0) return { annualizedRate: null, startDate: null };
  const elapsedDays = Math.max(0, (new Date(`${endDate}T12:00:00Z`) - new Date(`${startDate}T12:00:00Z`)) / performanceDayMilliseconds);
  return {
    annualizedRate: elapsedDays >= 180 && elapsedDays > 0 ? (growth ** (365.2425 / elapsedDays) - 1) * 100 : null,
    startDate
  };
}

function portfolioPerformance(data, totalAssets) {
  const holdings = data.holdings.filter(holding => !holding.archived);
  const principal = holdings.reduce((sum, holding) => sum + holdingCostJPY(holding), 0);
  const existingProfit = totalAssets - principal;
  const performance = timeWeightedPerformance(data, totalAssets);
  return {
    principal,
    existingProfit,
    profitPct: principal ? existingProfit / principal * 100 : 0,
    annualizedRate: performance.annualizedRate,
    startDate: performance.startDate || data.accountStartDate || null
  };
}

function currentPerformance() {
  const assets = currentAssets();
  return syncedPerformance || { principal: assets, existingProfit: 0, profitPct: 0, annualizedRate: null, startDate: null };
}

function syncedAssetType(holding) {
  if (holding.name === '预存款与现金') return 'cash';
  if (holding.name === '黄金' || holding.account === '黄金') return 'gold';
  if (holding.fundId || (!holding.symbol && holding.market === 'JP')) return 'fund';
  if (holding.market === 'US' || holding.quote?.currency === 'USD') return 'us';
  return 'jp';
}

function ensureSyncedAsset(id) {
  let asset = state.assetTypes.find(item => item.id === id);
  if (asset) return asset;
  const presets = {
    us: { name: '美股', annualRate: 18, usdExposurePct: 100 },
    fund: { name: '基金', annualRate: 16, usdExposurePct: 100 },
    jp: { name: '日股', annualRate: 9, usdExposurePct: 0 },
    gold: { name: '黄金', annualRate: 8, usdExposurePct: 100 },
    cash: { name: '现金', annualRate: 0, usdExposurePct: 0 }
  };
  asset = { id, amount: 0, ...(presets[id] || { name: id, annualRate: 8, usdExposurePct: 0 }) };
  state.assetTypes.push(asset);
  return asset;
}

function amountFromPlanLine(text, aliases) {
  const line = String(text || '').split(/\r?\n/).find(item => aliases.some(alias => item.toLowerCase().includes(alias.toLowerCase())));
  const match = line?.match(/[：:]\s*([\d,]+)\s*(?:日元|円)/);
  return match ? Number(match[1].replaceAll(',', '')) : null;
}

function syncInvestmentPlans(text) {
  const mappings = [
    { plan: 'FANG+', aliases: ['FANG+'] },
    { plan: 'S&P500', aliases: ['S&P500', 'SP500'] },
    { plan: '黄金', aliases: ['黄金'] },
    { plan: '住友持股会', aliases: ['住友商事持股会', '住友持股会'] }
  ];
  mappings.forEach(mapping => {
    const amount = amountFromPlanLine(text, mapping.aliases);
    const plan = state.plans.find(item => item.name.includes(mapping.plan));
    if (plan && amount !== null) plan.amount = amount;
  });
  const sumitomoLine = String(text || '').split(/\r?\n/).find(line => line.includes('住友'));
  const bonus = sumitomoLine?.match(/([\d.]+)\s*%/);
  const sumitomoPlan = state.plans.find(item => item.name.includes('住友'));
  if (sumitomoPlan && bonus) sumitomoPlan.bonusPct = Number(bonus[1]);
}

function syncStateFromPortfolio(data, fullRender = true, syncPlans = false) {
  if (!data || !Array.isArray(data.holdings)) return;
  syncedPortfolio = data;
  const fxRate = Number(data.fx?.USDJPY?.price || state.currentUsdJpy || 1);
  const totals = { us: 0, fund: 0, jp: 0, gold: 0, cash: 0 };
  data.holdings.filter(holding => !holding.archived).forEach(holding => {
    totals[syncedAssetType(holding)] += holdingValueJPY(holding, fxRate);
  });
  ['us', 'fund', 'jp', 'gold'].forEach(id => { ensureSyncedAsset(id).amount = totals[id]; });
  if (totals.cash > 0 || state.assetTypes.some(asset => asset.id === 'cash')) ensureSyncedAsset('cash').amount = totals.cash;
  syncedPerformance = portfolioPerformance(data, Object.values(totals).reduce((sum, amount) => sum + amount, 0));
  state.currentUsdJpy = fxRate;
  if (syncPlans) syncInvestmentPlans(data.investmentPlan);
  saveState(false, false);
  if (fullRender) render();
  else renderResults();
}

function mergeLivePortfolioPatch(patch) {
  if (!syncedPortfolio || !patch) return;
  const byId = new Map((patch.holdings || []).filter(item => item.id).map(item => [item.id, item]));
  const byName = new Map((patch.holdings || []).map(item => [item.name, item]));
  syncedPortfolio.holdings.forEach(holding => {
    const update = byId.get(holding.id) || byName.get(holding.name);
    if (!update) return;
    if (update.quote) {
      const previousQuote = holding.quote || {};
      const nextQuote = update.quote;
      holding.quote = { ...previousQuote, ...nextQuote };
      const nextSession = nextQuote.marketSession;
      const nextExtendedSession = nextQuote.extendedSession;
      if (
        nextExtendedSession !== 'pre'
        && nextExtendedSession !== 'post'
        && (nextSession === 'regular' || ((nextSession === 'pre' || nextSession === 'post') && previousQuote.extendedSession !== nextSession))
      ) {
        ['extendedPrice', 'extendedSession', 'extendedMarketTime', 'extendedChangePct', 'extendedReceivedAt'].forEach(key => delete holding.quote[key]);
      }
    }
    if (update.quoteUpdatedAt) holding.quoteUpdatedAt = update.quoteUpdatedAt;
  });
  if (patch.fx) syncedPortfolio.fx = patch.fx;
  clearTimeout(liveSyncTimer);
  liveSyncTimer = setTimeout(() => syncStateFromPortfolio(syncedPortfolio, false, false), 400);
}

function connectPortfolioQuoteStream() {
  if (simulatorCloudDeployment || simulatorLocalMode || !globalThis.EventSource || quoteStream) return;
  quoteStream = new EventSource(authenticatedSimulatorUrl('/api/stream'));
  quoteStream.addEventListener('quotes', event => {
    try { mergeLivePortfolioPatch(JSON.parse(event.data)); } catch {}
  });
}

async function syncMainPortfolio(syncPlans = false) {
  if (simulatorLocalMode) {
    try {
      let localData = null;
      if (simulatorProfileToken) {
        const response = await fetch(profileSimulatorUrl('/api/profile-portfolio'), { cache: 'no-store' });
        const payload = await response.json();
        if (response.ok && !payload.error) localData = payload.portfolio;
      } else {
        const localKey = simulatorSessionMode === 'user' && simulatorRequestedUserId
          ? `portfolioDashboardLocalPortfolioV1:user:${simulatorRequestedUserId}`
          : 'portfolioDashboardLocalPortfolioV1';
        localData = JSON.parse(localStorage.getItem(localKey) || 'null');
      }
      if (localData) syncStateFromPortfolio(localData, true, syncPlans);
    } catch {}
    return;
  }
  try {
    const response = await fetch(authenticatedSimulatorUrl('/api/portfolio-summary'), { cache: 'no-store', headers: simulatorAccessToken ? { 'X-Portfolio-Token': simulatorAccessToken } : {} });
    if (!response.ok) return;
    syncStateFromPortfolio(await response.json(), true, syncPlans);
  } catch {}
}

function fxFactor(asset, stressPct = state.fxStressPct) {
  return 1 + Number(stressPct || 0) / 100 * Number(asset.usdExposurePct || 0) / 100;
}

function valuedBalances(balances, stressPct = state.fxStressPct) {
  return Object.fromEntries(state.assetTypes.map(asset => [asset.id, (balances[asset.id] || 0) * fxFactor(asset, stressPct)]));
}

function valuedTotal(balances, stressPct = state.fxStressPct) {
  return Object.values(valuedBalances(balances, stressPct)).reduce((sum, amount) => sum + amount, 0);
}

function parseMonth(value) {
  const [year, month] = String(value).split('-').map(Number);
  return new Date(year, month - 1, 1);
}

function addMonths(date, amount) {
  return new Date(date.getFullYear(), date.getMonth() + amount, 1);
}

function monthDifference(start, end) {
  return (end.getFullYear() - start.getFullYear()) * 12 + end.getMonth() - start.getMonth();
}

function contributionForMonth(date, options = {}) {
  const currentIndex = date.getFullYear() * 12 + date.getMonth();
  const total = state.plans.reduce((result, plan) => {
    const start = parseMonth(plan.startMonth);
    const startIndex = start.getFullYear() * 12 + start.getMonth();
    const endIndex = plan.endMonth ? (() => { const end = parseMonth(plan.endMonth); return end.getFullYear() * 12 + end.getMonth(); })() : Infinity;
    if (currentIndex < startIndex || currentIndex > endIndex) return result;
    if (plan.frequency === 'yearly' && (currentIndex - startIndex) % 12 !== 0) return result;
    const contributionScale = plan.frequency === 'monthly' ? Math.max(0, Number(options.monthlyContributionScale ?? 1)) : 1;
    const personal = Number(plan.amount || 0) * contributionScale;
    const subsidy = personal * Number(plan.bonusPct || 0) / 100;
    const invested = personal + subsidy;
    result.personal += personal;
    result.subsidy += subsidy;
    result.invested += invested;
    result.byAsset[plan.assetTypeId] = (result.byAsset[plan.assetTypeId] || 0) + invested;
    return result;
  }, { personal: 0, subsidy: 0, invested: 0, byAsset: {} });
  const monthlyExtraJPY = Math.max(0, Number(options.monthlyExtraJPY || 0));
  if (monthlyExtraJPY > 0) {
    const targetAssetId = options.monthlyExtraAssetId && state.assetTypes.some(asset => asset.id === options.monthlyExtraAssetId)
      ? options.monthlyExtraAssetId
      : null;
    if (targetAssetId) {
      total.byAsset[targetAssetId] = (total.byAsset[targetAssetId] || 0) + monthlyExtraJPY;
    } else {
      const activeMonthlyPlans = state.plans.filter(plan => {
        if (plan.frequency !== 'monthly') return false;
        const start = parseMonth(plan.startMonth);
        const startIndex = start.getFullYear() * 12 + start.getMonth();
        const endIndex = plan.endMonth ? (() => { const end = parseMonth(plan.endMonth); return end.getFullYear() * 12 + end.getMonth(); })() : Infinity;
        return currentIndex >= startIndex && currentIndex <= endIndex && Number(plan.amount || 0) > 0;
      });
      const activeTotal = activeMonthlyPlans.reduce((sum, plan) => sum + Number(plan.amount || 0), 0);
      if (activeTotal > 0) {
        activeMonthlyPlans.forEach(plan => {
          const amount = monthlyExtraJPY * Number(plan.amount || 0) / activeTotal;
          total.byAsset[plan.assetTypeId] = (total.byAsset[plan.assetTypeId] || 0) + amount;
        });
      } else if (state.assetTypes.length) {
        const fallbackAsset = [...state.assetTypes].sort((left, right) => assetScenarioRate(right, 'base') - assetScenarioRate(left, 'base'))[0];
        total.byAsset[fallbackAsset.id] = (total.byAsset[fallbackAsset.id] || 0) + monthlyExtraJPY;
      }
    }
    total.personal += monthlyExtraJPY;
    total.invested += monthlyExtraJPY;
  }
  return total;
}

function assetScenarioRate(asset, scenario = 'base') {
  const baseRate = Math.max(-99, Number(asset.annualRate || 0));
  const spread = Math.max(0, Number(state.scenarioSpread || 0));
  if (typeof scenario === 'number') return Math.max(-99, baseRate + scenario);
  if (scenario === 'bear') return asset.bearRate !== null && asset.bearRate !== undefined && Number.isFinite(Number(asset.bearRate)) ? Math.max(-99, Number(asset.bearRate)) : Math.max(-99, baseRate - spread);
  if (scenario === 'bull') return asset.bullRate !== null && asset.bullRate !== undefined && Number.isFinite(Number(asset.bullRate)) ? Math.max(-99, Number(asset.bullRate)) : Math.max(-99, baseRate + spread);
  return baseRate;
}

function simulate(scenario = 'base', endMonth = state.targetDate, maximumMonths = null, options = {}) {
  const start = parseMonth(monthValue());
  const targetEnd = parseMonth(endMonth);
  const months = maximumMonths ?? Math.max(0, monthDifference(start, targetEnd));
  const balances = Object.fromEntries(state.assetTypes.map(asset => [asset.id, Math.max(0, Number(asset.amount || 0))]));
  const stressPct = Number(options.fxStressPct ?? state.fxStressPct ?? 0);
  const rateShiftPct = Number(options.rateShiftPct || 0);
  let personal = 0;
  let subsidy = 0;
  let balance = valuedTotal(balances, stressPct);
  let achievedAt = balance >= state.targetAssets ? start : null;
  const points = [{ date: start, balance, personal, subsidy, valuedBalances: valuedBalances(balances, stressPct) }];
  for (let index = 1; index <= months; index += 1) {
    const date = addMonths(start, index);
    state.assetTypes.forEach(asset => {
      const annualRate = Math.max(-99, assetScenarioRate(asset, scenario) + rateShiftPct);
      const monthlyRate = (1 + annualRate / 100) ** (1 / 12) - 1;
      balances[asset.id] = (balances[asset.id] || 0) * (1 + monthlyRate);
    });
    const contribution = contributionForMonth(date, options);
    Object.entries(contribution.byAsset).forEach(([assetId, amount]) => {
      balances[assetId] = (balances[assetId] || 0) + amount;
    });
    personal += contribution.personal;
    subsidy += contribution.subsidy;
    balance = valuedTotal(balances, stressPct);
    if (!achievedAt && balance >= state.targetAssets) achievedAt = date;
    points.push({ date, balance, personal, subsidy, valuedBalances: valuedBalances(balances, stressPct) });
  }
  return { balance, personal, subsidy, achievedAt, points, balances, valuedBalances: valuedBalances(balances, stressPct) };
}

function simulateUniform(annualRate) {
  const start = parseMonth(monthValue());
  const targetEnd = parseMonth(state.targetDate);
  const months = Math.max(0, monthDifference(start, targetEnd));
  const monthlyRate = (1 + Math.max(-99, annualRate) / 100) ** (1 / 12) - 1;
  const balances = Object.fromEntries(state.assetTypes.map(asset => [asset.id, Math.max(0, Number(asset.amount || 0))]));
  for (let index = 1; index <= months; index += 1) {
    state.assetTypes.forEach(asset => { balances[asset.id] = (balances[asset.id] || 0) * (1 + monthlyRate); });
    const contribution = contributionForMonth(addMonths(start, index));
    Object.entries(contribution.byAsset).forEach(([assetId, amount]) => { balances[assetId] = (balances[assetId] || 0) + amount; });
  }
  return valuedTotal(balances);
}

function achievementDate(scenario) {
  return simulate(scenario, state.targetDate, 40 * 12).achievedAt;
}

function requiredAnnualRate() {
  const startingBalances = Object.fromEntries(state.assetTypes.map(asset => [asset.id, Math.max(0, Number(asset.amount || 0))]));
  if (valuedTotal(startingBalances) >= state.targetAssets) return 0;
  const reaches = rate => simulateUniform(rate) >= state.targetAssets;
  if (!reaches(500)) return null;
  let low = -99;
  let high = 500;
  for (let index = 0; index < 100; index += 1) {
    const middle = (low + high) / 2;
    if (reaches(middle)) high = middle;
    else low = middle;
  }
  return high;
}

function weightedExpectedRate() {
  const total = currentAssets();
  if (!total) return 0;
  return state.assetTypes.reduce((sum, asset) => sum + Number(asset.amount || 0) * Number(asset.annualRate || 0), 0) / total;
}

function weightedScenarioRate(scenario = 'base') {
  const total = currentAssets();
  if (!total) return 0;
  return state.assetTypes.reduce((sum, asset) => sum + Number(asset.amount || 0) * assetScenarioRate(asset, scenario), 0) / total;
}

function targetHorizonYears(endMonth = state.targetDate) {
  return Math.max(1 / 12, monthDifference(parseMonth(monthValue()), parseMonth(endMonth)) / 12);
}

function sensitivityAnalysis(forecast, report = null) {
  const aiFactors = (Array.isArray(report?.sensitivityFactors) ? report.sensitivityFactors : [])
    .map((item, index) => ({
      id: `ai-${index}`,
      label: String(item?.label || '关键因素'),
      score: Math.max(0, Number(item?.importanceScore || 0)),
      detail: String(item?.rationale || '')
    }))
    .filter(item => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 5);
  if (aiFactors.length) {
    const totalScore = aiFactors.reduce((sum, item) => sum + item.score, 0);
    return aiFactors.map(item => ({ ...item, sharePct: item.score / totalScore * 100 }));
  }
  const horizonYears = targetHorizonYears();
  const factors = [];
  const holdings = Array.isArray(forecast?.holdingForecasts) ? forecast.holdingForecasts : [];
  holdings.forEach(item => {
    const currentValue = Math.max(0, Number(item.valueJPY || 0));
    if (!currentValue) return;
    const bearTarget = Number(item.bearTargetValueJPY);
    const bullTarget = Number(item.bullTargetValueJPY);
    let score = Number.isFinite(bearTarget) && Number.isFinite(bullTarget)
      ? Math.abs(bullTarget - bearTarget) / 2
      : 0;
    if (!score) {
      const bearRate = Math.max(-99, Number(item.bearRate || 0));
      const bullRate = Math.max(-99, Number(item.bullRate || 0));
      const bearValue = currentValue * (1 + bearRate / 100) ** horizonYears;
      const bullValue = currentValue * (1 + bullRate / 100) ** horizonYears;
      score = Math.abs(bullValue - bearValue) / 2;
    }
    if (score > 0) factors.push({
      id: `holding-${item.holdingId || item.symbol || item.name}`,
      label: String(item.symbol || item.name || '持仓'),
      score,
      detail: '长期回报'
    });
  });
  if (!holdings.length) {
    (forecast?.assetForecasts || []).forEach(item => {
      const score = Math.abs(Number(item.bullTargetValueJPY || 0) - Number(item.bearTargetValueJPY || 0)) / 2;
      if (score > 0) factors.push({ id: `asset-${item.assetTypeId}`, label: item.assetName || item.assetTypeId, score, detail: '长期回报' });
    });
  }
  const monthlyLower = simulate('base', state.targetDate, null, { monthlyContributionScale: 0.8 }).balance;
  const monthlyUpper = simulate('base', state.targetDate, null, { monthlyContributionScale: 1.2 }).balance;
  const monthlyScore = Math.abs(monthlyUpper - monthlyLower) / 2;
  if (monthlyScore > 0) factors.push({ id: 'monthly-investment', label: '每月投入金额', score: monthlyScore, detail: '上下浮动20%' });
  const currentStress = Number(state.fxStressPct || 0);
  const fxLower = simulate('base', state.targetDate, null, { fxStressPct: currentStress - 10 }).balance;
  const fxUpper = simulate('base', state.targetDate, null, { fxStressPct: currentStress + 10 }).balance;
  const fxScore = Math.abs(fxUpper - fxLower) / 2;
  if (fxScore > 0) factors.push({ id: 'usd-jpy', label: 'USD/JPY', score: fxScore, detail: '上下浮动10%' });
  factors.sort((left, right) => right.score - left.score);
  const visible = factors.slice(0, 4);
  const remainder = factors.slice(4).reduce((sum, item) => sum + item.score, 0);
  if (remainder > 0) visible.push({ id: 'other', label: '其他', score: remainder, detail: '' });
  const totalScore = visible.reduce((sum, item) => sum + item.score, 0);
  return visible.map(item => ({ ...item, sharePct: totalScore > 0 ? item.score / totalScore * 100 : 0 }));
}

function rawGoalProbability(results, targetAssets = state.targetAssets) {
  const [bear, base, bull] = [results.bear.balance, results.base.balance, results.bull.balance].sort((left, right) => left - right);
  const target = Number(targetAssets || 0);
  if (target <= 0) return 99;
  let percentile;
  if (target <= bear) {
    const span = Math.max(1, base - bear);
    percentile = 15 - (bear - target) / span * 35;
  } else if (target <= base) {
    percentile = 15 + (target - bear) / Math.max(1, base - bear) * 35;
  } else if (target <= bull) {
    percentile = 50 + (target - base) / Math.max(1, bull - base) * 35;
  } else {
    percentile = 85 + (target - bull) / Math.max(1, bull - base) * 14;
  }
  return Math.max(1, Math.min(99, 100 - percentile));
}

function actionScenarioSet(options = {}, endMonth = state.targetDate) {
  return {
    bear: simulate('bear', endMonth, null, options),
    base: simulate('base', endMonth, null, options),
    bull: simulate('bull', endMonth, null, options)
  };
}

function normalizedMatchText(value) {
  return String(value || '').toLowerCase().replace(/[\s・·_()（）/\\-]+/g, '');
}

function resolveLeverAsset(item, forecast = null) {
  const requestedId = String(item?.assetTypeId || '');
  const requestedText = normalizedMatchText(`${requestedId} ${item?.label || ''}`);
  const directAsset = state.assetTypes.find(asset =>
    asset.id === requestedId
    || normalizedMatchText(asset.id) === normalizedMatchText(requestedId)
    || normalizedMatchText(asset.name) === normalizedMatchText(requestedId)
  );
  if (directAsset) return directAsset;
  const holding = (Array.isArray(forecast?.holdingForecasts) ? forecast.holdingForecasts : []).find(candidate => {
    const values = [candidate?.holdingId, candidate?.symbol, candidate?.name].map(normalizedMatchText).filter(Boolean);
    return values.some(value => requestedText.includes(value) || (requestedText.length > 2 && value.includes(requestedText)));
  });
  if (holding?.assetTypeId) {
    const holdingAsset = state.assetTypes.find(asset => asset.id === String(holding.assetTypeId));
    if (holdingAsset) return holdingAsset;
  }
  return state.assetTypes.find(asset => {
    const values = [asset.id, asset.name].map(normalizedMatchText).filter(Boolean);
    return values.some(value => requestedText.includes(value) || (requestedText.length > 2 && value.includes(requestedText)));
  }) || null;
}

function preferredLeverAsset(report, forecast) {
  const factors = Array.isArray(report?.sensitivityFactors) ? report.sensitivityFactors : [];
  for (const factor of factors) {
    const asset = resolveLeverAsset({ assetTypeId: '', label: factor?.label }, forecast);
    if (asset) return asset;
  }
  return [...state.assetTypes].sort((left, right) => {
    const returnDifference = assetScenarioRate(right, 'base') - assetScenarioRate(left, 'base');
    return returnDifference || Number(right.amount || 0) - Number(left.amount || 0);
  })[0] || null;
}

function goalLevers(report, forecast = null) {
  const aiProbability = Math.max(1, Math.min(99, Number(report?.targetProbability || 1)));
  const currentResults = actionScenarioSet();
  const currentRawProbability = rawGoalProbability(currentResults);
  const calibratedProbability = (results) => Math.round(Math.max(1, Math.min(99,
    aiProbability + rawGoalProbability(results) - currentRawProbability
  )));
  const aiLevers = (Array.isArray(report?.goalLevers) ? report.goalLevers : []).map((item, index) => {
    const type = String(item?.type || '');
    const amountJPY = Math.max(0, Number(item?.amountJPY || 0));
    const rateShiftPct = Math.max(0, Number(item?.rateShiftPct || 0));
    const delayMonths = Math.max(0, Number(item?.delayMonths || 0));
    const asset = resolveLeverAsset(item, forecast);
    const action = {
      id: `ai-${index}`,
      label: String(item?.label || '改善方案'),
      reason: String(item?.reason || ''),
      results: null
    };
    if (type === 'monthly_extra' && amountJPY > 0) {
      action.results = actionScenarioSet({ monthlyExtraJPY: amountJPY });
    } else if (type === 'asset_monthly_extra' && amountJPY > 0 && asset) {
      action.results = actionScenarioSet({ monthlyExtraJPY: amountJPY, monthlyExtraAssetId: asset.id });
    } else if (type === 'rate_shift' && rateShiftPct > 0) {
      action.results = actionScenarioSet({ rateShiftPct });
    } else if (type === 'delay_target' && delayMonths > 0) {
      action.results = actionScenarioSet({}, monthValue(addMonths(parseMonth(state.targetDate), delayMonths)));
    }
    return action;
  }).filter(action => action.results).slice(0, 5);
  const suggestedActions = [...aiLevers];
  const usedTypes = new Set((Array.isArray(report?.goalLevers) ? report.goalLevers : []).map(item => String(item?.type || '')));
  const remainingMonths = Math.max(1, monthDifference(parseMonth(monthValue()), parseMonth(state.targetDate)));
  const baseGap = Math.max(0, Number(state.targetAssets || 0) - Number(currentResults.base.balance || 0));
  const extraMonthly = Math.max(10000, Math.min(100000, Math.round((baseGap / remainingMonths * 0.35 || 30000) / 5000) * 5000));
  const preferredAsset = preferredLeverAsset(report, forecast);
  const rateGap = requiredAnnualRate();
  const rateShift = Math.max(1, Math.min(5, Math.round(Math.max(0, Number(rateGap || 0) - weightedExpectedRate()) || 2)));
  const delayMonths = baseGap > Number(state.targetAssets || 0) * 0.2 ? 24 : 12;
  const supplements = [
    {
      type: 'asset_monthly_extra',
      id: 'dynamic-targeted',
      label: preferredAsset ? `${preferredAsset.name} 每月增加 ${compactMoney(extraMonthly)}` : `重点资产每月增加 ${compactMoney(extraMonthly)}`,
      reason: preferredAsset ? `优先投入本次分析中影响目标最大的${preferredAsset.name}` : '优先提高对目标结果影响最大的资产投入',
      results: actionScenarioSet({ monthlyExtraJPY: extraMonthly, monthlyExtraAssetId: preferredAsset?.id })
    },
    {
      type: 'monthly_extra',
      id: 'dynamic-monthly',
      label: `每月总投入增加 ${compactMoney(extraMonthly)}`,
      reason: '按当前目标缺口和剩余月份动态测算，并按现有定投比例分配',
      results: actionScenarioSet({ monthlyExtraJPY: extraMonthly })
    },
    {
      type: 'rate_shift',
      id: 'dynamic-return',
      label: `组合年化提高 ${rateShift} 个百分点`,
      reason: '展示通过提高持仓质量或把握估值机会缩小目标缺口的效果',
      results: actionScenarioSet({ rateShiftPct: rateShift })
    },
    {
      type: 'delay_target',
      id: 'dynamic-delay',
      label: `目标延后 ${delayMonths / 12} 年`,
      reason: '不增加当期投入，比较延长复利时间带来的改善',
      results: actionScenarioSet({}, monthValue(addMonths(parseMonth(state.targetDate), delayMonths)))
    }
  ];
  for (const supplement of supplements) {
    if (suggestedActions.length >= 3) break;
    if (usedTypes.has(supplement.type)) continue;
    suggestedActions.push(supplement);
    usedTypes.add(supplement.type);
  }
  for (const supplement of supplements) {
    if (suggestedActions.length >= 3) break;
    if (!suggestedActions.some(action => action.id === supplement.id)) suggestedActions.push(supplement);
  }
  const actions = [
    { id: 'current', label: '当前方案', reason: '当前持仓、定投与AI基准预测', results: currentResults, probability: Math.round(aiProbability), current: true },
    ...suggestedActions
  ];
  return actions.map(action => ({
    ...action,
    probability: action.probability ?? calibratedProbability(action.results),
    endingAssetsJPY: Math.round(action.results.base.balance),
    probabilityChange: (action.probability ?? calibratedProbability(action.results)) - Math.round(aiProbability)
  }));
}

async function saveRemoteState(keepalive = false) {
  if (!simulatorHasRemoteSession || !remoteSettingsReady) return;
  const snapshot = JSON.stringify(state);
  const snapshotUpdatedAt = state.updatedAt;
  try {
    const endpoint = simulatorProfileToken
      ? profileSimulatorUrl('/api/profile-goal-simulator')
      : authenticatedSimulatorUrl('/api/goal-simulator');
    const response = await fetch(endpoint, {
      method: 'POST',
      cache: 'no-store',
      keepalive,
      headers: {
        'Content-Type': 'application/json',
        ...(simulatorAccessToken ? { 'X-Portfolio-Token': simulatorAccessToken } : {})
      },
      body: snapshot
    });
    if (response.ok && state.updatedAt === snapshotUpdatedAt) localStorage.removeItem(DIRTY_KEY);
  } catch {}
}

function saveState(remote = true, touch = true) {
  if (touch) state.updatedAt = new Date().toISOString();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  if (!remote || (simulatorLocalMode && !simulatorProfileToken)) return;
  localStorage.setItem(DIRTY_KEY, '1');
  if (!remoteSettingsReady) return;
  clearTimeout(remoteSaveTimer);
  remoteSaveTimer = setTimeout(saveRemoteState, 350);
}

async function loadRemoteState() {
  if (!simulatorHasRemoteSession) return false;
  try {
    const endpoint = simulatorProfileToken
      ? profileSimulatorUrl('/api/profile-goal-simulator')
      : authenticatedSimulatorUrl('/api/goal-simulator');
    const response = await fetch(endpoint, {
      cache: 'no-store',
      headers: simulatorAccessToken ? { 'X-Portfolio-Token': simulatorAccessToken } : {}
    });
    if (!response.ok) return false;
    const payload = await response.json();
    if (!payload.settings || typeof payload.settings !== 'object') return false;
    const remoteState = normalizeState(payload.settings);
    const localUpdatedAt = Date.parse(state.updatedAt || '') || 0;
    const remoteUpdatedAt = Date.parse(remoteState.updatedAt || '') || 0;
    const localIsDirty = localStorage.getItem(DIRTY_KEY) === '1';
    if (hadLocalSimulatorState && (localIsDirty || localUpdatedAt > remoteUpdatedAt)) {
      localStorage.setItem(DIRTY_KEY, '1');
      return true;
    }
    state = remoteState;
    localStorage.removeItem(DIRTY_KEY);
    saveState(false, false);
    hydrateControls();
    render();
    return true;
  } catch {
    return false;
  }
}

function saveAndRender() {
  saveState();
  render();
}

function numberInput(id, value, callback) {
  const input = document.querySelector(id);
  input.value = value;
  input.oninput = () => { callback(Number(input.value || 0)); saveState(); renderResults(); };
}

function hydrateControls() {
  document.querySelector('#current-assets').value = currentAssets();
  numberInput('#target-assets', state.targetAssets, value => { state.targetAssets = Math.max(0, value); });
  numberInput('#fx-stress', state.fxStressPct, value => { state.fxStressPct = Math.min(30, Math.max(-30, value)); });
  numberInput('#current-usd-jpy', state.currentUsdJpy, value => { state.currentUsdJpy = Math.max(1, value); });
  const targetDate = document.querySelector('#target-date');
  targetDate.value = state.targetDate;
  targetDate.min = monthValue();
  targetDate.onchange = () => { state.targetDate = targetDate.value || monthValue(); saveState(); renderResults(); };
}

function planField(label, control, className = '') {
  return `<label class="plan-field ${className}"><span>${label}</span>${control}</label>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function aiApiUrl(kind) {
  if (simulatorSessionMode === 'user') return `/api/goal-ai-${kind}`;
  const route = `/api/${simulatorProfileToken ? 'profile-' : ''}goal-ai-${kind}`;
  return simulatorProfileToken ? profileSimulatorUrl(route) : authenticatedSimulatorUrl(route);
}

const forecastQuotaText = label => {
  if (simulatorSessionMode !== 'user' || !accountAiUsage) return label;
  if (!accountAiUsage.enabled) return 'AI未开通';
  return `${label}（${accountAiUsage.forecastRemaining}/${accountAiUsage.limit}）`;
};

function renderForecastQuota() {
  if (simulatorSessionMode !== 'user' || !accountAiUsage) return;
  const disabled = !accountAiUsage.enabled || accountAiUsage.forecastRemaining <= 0;
  const emptyButton = document.querySelector('#ai-empty-run');
  const reportButton = document.querySelector('#ai-report-refresh');
  emptyButton.textContent = forecastQuotaText('开始分析');
  reportButton.textContent = forecastQuotaText('重新分析');
  emptyButton.disabled = disabled;
  reportButton.disabled = disabled;
}

async function loadAccountAiUsage() {
  if (simulatorSessionMode !== 'user') return;
  try {
    const response = await fetch('/api/ai-usage', { cache: 'no-store' });
    const payload = await response.json();
    if (response.ok && !payload.error) accountAiUsage = payload;
  } catch {}
  renderForecastQuota();
}

const AI_COOLDOWN_KEY = 'portfolioGoalAiCooldownUntilV2';
let aiCooldownTimer = null;
let aiProgressTimer = null;
let aiRequestInFlight = false;

function aiCooldownRemaining() {
  const cooldownUntil = Number(localStorage.getItem(AI_COOLDOWN_KEY) || 0);
  return Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
}

function setAiCooldown(seconds) {
  const currentUntil = Number(localStorage.getItem(AI_COOLDOWN_KEY) || 0);
  const nextUntil = Date.now() + Math.max(1, Number(seconds) || 1) * 1000;
  localStorage.setItem(AI_COOLDOWN_KEY, String(Math.max(currentUntil, nextUntil)));
}

function refreshAiCooldownUi() {
  if (aiCooldownTimer) clearTimeout(aiCooldownTimer);
  const remaining = aiCooldownRemaining();
  const reportButton = document.querySelector('#ai-report-refresh');
  const emptyButton = document.querySelector('#ai-empty-run');
  if (!remaining) {
    reportButton.disabled = false;
    emptyButton.disabled = false;
    emptyButton.textContent = forecastQuotaText('开始分析');
    aiCooldownTimer = null;
    renderForecastQuota();
    return;
  }
  reportButton.disabled = true;
  emptyButton.disabled = true;
  emptyButton.textContent = `${remaining}秒后`;
  aiCooldownTimer = setTimeout(refreshAiCooldownUi, 1000);
}

async function postAiRequest(kind, payload) {
  const requestBody = JSON.stringify(payload);
  const requestBytes = new Blob([requestBody]).size;
  const response = await fetch(aiApiUrl(kind), {
    method: 'POST',
    cache: 'no-store',
    ...(requestBytes <= 60_000 ? { keepalive: true } : {}),
    headers: {
      'Content-Type': 'application/json',
      ...(simulatorAccessToken ? { 'X-Portfolio-Token': simulatorAccessToken } : {})
    },
    body: requestBody
  });
  let result = null;
  try { result = await response.json(); } catch {}
  if (!response.ok || result?.error) {
    const error = new Error(result?.error || `AI 分析请求失败（${response.status}）`);
    error.retryAfter = Number(result?.retryAfter || 0);
    throw error;
  }
  return result;
}

function compactPreviousForecast(forecast) {
  if (!forecast || !Array.isArray(forecast.holdingForecasts)) return null;
  return {
    holdingForecasts: forecast.holdingForecasts.map(item => ({
      holdingId: item?.holdingId,
      baseRate: item?.baseRate
    })).filter(item => item.holdingId)
  };
}

function compactSettingsSnapshot() {
  const { aiAnalysis, ...settings } = state;
  return JSON.parse(JSON.stringify(settings));
}

function chineseFinanceText(value) {
  let text = String(value || '');
  const replacements = [
    [/trailingForwardPeRatio/gi, '预期市盈率'],
    [/trailingPeRatio/gi, '当前市盈率'],
    [/trailingPsRatio/gi, '当前市销率'],
    [/quarterlyDilutedEPS/gi, '季度摊薄每股收益'],
    [/quarterlyTotalRevenue/gi, '季度总营收'],
    [/quarterlyOperatingIncome/gi, '季度营业利润'],
    [/\btrailing\s+forward\s+p\/?e\b/gi, '预期市盈率'],
    [/\bforward\s+p\/?e\b/gi, '预期市盈率'],
    [/\btrailing\s+p\/?e\b/gi, '当前市盈率'],
    [/\bfree\s+cash\s+flow\b/gi, '自由现金流'],
    [/\boperating\s+margin\b/gi, '营业利润率'],
    [/\bgross\s+margin\b/gi, '毛利率'],
    [/\bnet\s+margin\b/gi, '净利润率'],
    [/\bmarket\s+cap(?:italization)?\b/gi, '市值'],
    [/\bearnings\s+guidance\b/gi, '盈利指引'],
    [/\bforward\s+guidance\b/gi, '前瞻指引'],
    [/\brevenue\s+growth\b/gi, '营收增长'],
    [/\bearnings\s+growth\b/gi, '利润增长'],
    [/\bEBITDA\b/g, '息税折旧摊销前利润'],
    [/\bEBIT\b/g, '息税前利润'],
    [/\bFCF\b/g, '自由现金流'],
    [/\bDCF\b/g, '现金流折现估值'],
    [/\bROIC\b/g, '投入资本回报率'],
    [/\bROE\b/g, '净资产收益率'],
    [/\bCAGR\b/g, '复合年化收益率'],
    [/\bCAPEX\b/gi, '资本支出'],
    [/\bEPS\b/gi, '每股收益'],
    [/\bRevenue\b/gi, '营收'],
    [/\bMargin\b/gi, '利润率'],
    [/\bP\/?E\b/gi, '市盈率'],
    [/\bP\/?S\b/gi, '市销率'],
    [/\bP\/?B\b/gi, '市净率'],
    [/\bYoY\b/gi, '同比'],
    [/\bQoQ\b/gi, '环比'],
    [/\bDCA\b/g, '定期定额投资'],
    [/\bNAV\b/g, '基金净值'],
    [/\bBear\b/gi, '悲观情景'],
    [/\bBase\b/gi, '基准情景'],
    [/\bBull\b/gi, '乐观情景'],
    [/\bbenchmark\b/gi, '对比基准'],
    [/\bconsensus\b/gi, '市场一致预期'],
    [/\bguidance\b/gi, '公司指引'],
    [/\bupside\b/gi, '上涨空间'],
    [/\bdownside\b/gi, '下跌风险'],
    [/\bvolatility\b/gi, '波动率'],
    [/\bdrawdown\b/gi, '回撤'],
    [/\bmultiple\b/gi, '估值倍数']
  ];
  replacements.forEach(([pattern, replacement]) => { text = text.replace(pattern, replacement); });
  return text;
}

function aiListMarkup(values) {
  const items = Array.isArray(values) ? values.filter(Boolean) : [];
  return items.length ? items.map(value => `<li>${escapeHtml(chineseFinanceText(value))}</li>`).join('') : '<li>暂无</li>';
}

function compactAiRationale(value) {
  const parts = chineseFinanceText(value)
    .split(/[；;]+/)
    .map(part => part.trim())
    .filter(part => part && !/(模型原基准|低于当前组合表现|已校准至|已矫正至|已修正至)/.test(part));
  return [...new Set(parts)].join('；');
}

function aiDetailLine(label, value, className = '') {
  const text = chineseFinanceText(value).trim();
  if (!text) return '';
  return `<p class="${className}"><b>${escapeHtml(label)}</b><span>${escapeHtml(text)}</span></p>`;
}

function compactMoney(value) {
  return `¥${Math.round(Number(value || 0)).toLocaleString('ja-JP')}`;
}

function safeSourceUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
}

function renderAiAnalysis() {
  const panel = document.querySelector('#ai-report-panel');
  const emptyPanel = document.querySelector('#ai-report-empty');
  const forecast = state.aiAnalysis?.forecast;
  const report = state.aiAnalysis?.report;
  if (!forecast || !report) {
    panel.hidden = true;
    emptyPanel.hidden = false;
    return;
  }
  panel.hidden = false;
  emptyPanel.hidden = true;
  const probability = Math.min(99, Math.max(1, Number(report.targetProbability || 1)));
  document.querySelector('#ai-probability strong').textContent = `${Math.round(probability)}%`;
  document.querySelector('#ai-report-status').textContent = report.status || '—';
  document.querySelector('#ai-report-summary').textContent = chineseFinanceText(report.summary) || '—';
  document.querySelector('#ai-report-conclusion').textContent = chineseFinanceText(report.conclusion) || '';
  const sensitivity = sensitivityAnalysis(forecast, report);
  document.querySelector('#ai-sensitivity-list').innerHTML = sensitivity.length
    ? sensitivity.map(item => `<div class="ai-sensitivity-row">
        <div><span>${escapeHtml(chineseFinanceText(item.label))}</span>${item.detail ? `<small>${escapeHtml(chineseFinanceText(item.detail))}</small>` : ''}<strong>${Math.round(item.sharePct)}%</strong></div>
        <i><b style="width:${Math.max(2, item.sharePct).toFixed(1)}%"></b></i>
      </div>`).join('')
    : '<div class="ai-tool-empty">暂无足够数据</div>';
  const levers = goalLevers(report, forecast);
  document.querySelector('#ai-lever-list').innerHTML = levers.map(item => {
    const change = Number(item.probabilityChange || 0);
    const changeText = item.current ? '当前基准' : `${change >= 0 ? '+' : ''}${change}个百分点`;
    return `<div class="ai-lever-row${item.current ? ' current' : ''}">
      <div class="ai-lever-copy">
        <span>${escapeHtml(chineseFinanceText(item.label))}</span>
        ${item.reason ? `<em>${escapeHtml(chineseFinanceText(item.reason))}</em>` : ''}
        <small>${compactMoney(item.endingAssetsJPY)} · ${escapeHtml(changeText)}</small>
      </div>
      <strong>${item.probability}%</strong>
    </div>`;
  }).join('');
  const generatedAt = report.generatedAt || forecast.generatedAt;
  const generatedLabel = generatedAt
    ? new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(generatedAt))
    : '';
  document.querySelector('#ai-report-time').textContent = generatedLabel || '—';
  document.querySelector('#ai-rate-list').innerHTML = (forecast.assetForecasts || []).map(item => {
    const catalysts = Array.isArray(item.catalysts) ? item.catalysts.filter(Boolean).join('；') : '';
    const downsideTriggers = Array.isArray(item.downsideTriggers) ? item.downsideTriggers.filter(Boolean).join('；') : '';
    return `<div class="ai-rate-row">
      <span>${escapeHtml(item.assetName || item.assetTypeId || '资产')}</span>
      <strong class="ai-rate-scenarios"><small>悲 ${Number(item.bearRate ?? item.annualRate ?? 0).toFixed(1)}%</small><b>基 ${Number(item.baseRate ?? item.annualRate ?? 0).toFixed(1)}%</b><small>乐 ${Number(item.bullRate ?? item.annualRate ?? 0).toFixed(1)}%</small></strong>
      <div class="ai-rate-detail">
        ${aiDetailLine('判断', compactAiRationale(item.rationale))}
        ${aiDetailLine('估值', item.valuationOutlook)}
        ${aiDetailLine('回报来源', item.returnEngine)}
        ${aiDetailLine('兑现条件', catalysts)}
        ${aiDetailLine('下修条件', downsideTriggers)}
        ${aiDetailLine('当前动作', item.decisionSignal, 'decision')}
      </div>
    </div>`;
  }).join('');
  document.querySelector('#ai-reason-list').innerHTML = (report.reasons || []).map(item => `<div class="ai-reason-item"><b>${escapeHtml(chineseFinanceText(item.title))}</b><p>${escapeHtml(chineseFinanceText(item.detail))}</p></div>`).join('');
  document.querySelector('#ai-driver-list').innerHTML = aiListMarkup(report.growthDrivers);
  document.querySelector('#ai-risk-list').innerHTML = aiListMarkup(report.risks);
  document.querySelector('#ai-action-list').innerHTML = aiListMarkup(report.actions);
}

function aiBlueprint() {
  const pessimistic = simulate('bear');
  const baseline = simulate('base');
  const optimistic = simulate('bull');
  const performance = currentPerformance();
  const required = requiredAnnualRate();
  const points = baseline.points.filter((point, index, all) => index === all.length - 1 || all[index + 1].date.getFullYear() !== point.date.getFullYear());
  const scenario = result => ({
    endingAssetsJPY: Math.round(result.balance),
    targetGapJPY: Math.round(result.balance - state.targetAssets),
    achievedAt: result.achievedAt ? monthValue(result.achievedAt) : null,
    personalContributionJPY: Math.round(result.personal),
    subsidyJPY: Math.round(result.subsidy)
  });
  return {
    calculatedAt: new Date().toISOString(),
    target: { assetsJPY: Math.round(state.targetAssets), date: state.targetDate },
    current: {
      assetsJPY: Math.round(currentAssets()),
      principalJPY: Math.round(performance.principal),
      existingProfitJPY: Math.round(performance.existingProfit),
      existingProfitPct: Number(performance.profitPct.toFixed(2)),
      historicalAnnualizedPct: performance.annualizedRate === null ? null : Number(performance.annualizedRate.toFixed(2))
    },
    assumptions: {
      weightedAnnualRatePct: Number(weightedExpectedRate().toFixed(2)),
      weightedBearRatePct: Number(weightedScenarioRate('bear').toFixed(2)),
      weightedBullRatePct: Number(weightedScenarioRate('bull').toFixed(2)),
      requiredAnnualRatePct: required === null ? null : Number(required.toFixed(2)),
      fallbackScenarioSpreadPct: Number(state.scenarioSpread || 0),
      currentUsdJpy: Number(state.currentUsdJpy || 0),
      stressedUsdJpy: Number((Number(state.currentUsdJpy || 0) * (1 + Number(state.fxStressPct || 0) / 100)).toFixed(2)),
      fxStressPct: Number(state.fxStressPct || 0),
      assetTypes: state.assetTypes.map(asset => ({
        id: asset.id,
        name: asset.name,
        amountJPY: Math.round(asset.amount),
        bearRatePct: assetScenarioRate(asset, 'bear'),
        baseRatePct: assetScenarioRate(asset, 'base'),
        bullRatePct: assetScenarioRate(asset, 'bull'),
        usdExposurePct: Number(asset.usdExposurePct)
      }))
    },
    contributionPlans: state.plans.map(plan => ({
      name: plan.name,
      assetTypeId: plan.assetTypeId,
      amountJPY: Number(plan.amount),
      frequency: plan.frequency,
      startMonth: plan.startMonth,
      endMonth: plan.endMonth || null,
      subsidyPct: Number(plan.bonusPct || 0)
    })),
    scenarios: { pessimistic: scenario(pessimistic), baseline: scenario(baseline), optimistic: scenario(optimistic) },
    annualMilestones: points.map(point => ({ date: monthValue(point.date), totalAssetsJPY: Math.round(point.balance), addedPrincipalJPY: Math.round(point.personal), subsidyJPY: Math.round(point.subsidy) })),
    targetAssetValuesJPY: Object.fromEntries(state.assetTypes.map(asset => [asset.name, Math.round(baseline.valuedBalances[asset.id] || 0)]))
  };
}

function setAiState(message = '', isError = false, isWorking = false) {
  const element = document.querySelector('#ai-analysis-state');
  element.hidden = !message;
  element.textContent = message;
  element.classList.toggle('error', isError);
  element.classList.toggle('working', isWorking);
}

function stopAiProgress() {
  if (aiProgressTimer) clearInterval(aiProgressTimer);
  aiProgressTimer = null;
}

function startAiProgress() {
  stopAiProgress();
  const steps = [
    '正在读取最新持仓与当前收益表现…',
    '正在分析各类资产的增长与估值条件…',
    '正在生成悲观、基准与乐观年化假设…',
    '正在计算目标路径并整理分析报告…'
  ];
  let stepIndex = 0;
  setAiState(steps[stepIndex], false, true);
  aiProgressTimer = setInterval(() => {
    stepIndex = Math.min(stepIndex + 1, steps.length - 1);
    setAiState(steps[stepIndex], false, true);
  }, 3500);
}

async function runAiAnalysis() {
  if (aiRequestInFlight) return;
  const cooldownRemaining = aiCooldownRemaining();
  if (cooldownRemaining) {
    setAiState(`AI 服务正在恢复，请约 ${cooldownRemaining} 秒后再试。`);
    refreshAiCooldownUi();
    return;
  }
  aiRequestInFlight = true;
  setSimulatorView('ai');
  const buttons = [document.querySelector('#ai-report-refresh'), document.querySelector('#ai-empty-run')];
  buttons.forEach(button => { button.disabled = true; });
  document.querySelector('#ai-empty-run').textContent = '分析中…';
  startAiProgress();
  setAiCooldown(3);
  try {
    const performance = currentPerformance();
    const forecastPayload = await postAiRequest('forecast', {
      ...(simulatorSessionMode === 'user' ? { portfolio: syncedPortfolio } : {}),
      goal: {
        targetAssets: state.targetAssets,
        targetDate: state.targetDate,
        currentUsdJpy: state.currentUsdJpy,
        currentPerformance: {
          principalJPY: Math.round(performance.principal),
          existingProfitJPY: Math.round(performance.existingProfit),
          totalReturnPct: Number(performance.profitPct.toFixed(2)),
          annualizedRatePct: performance.annualizedRate === null ? null : Number(performance.annualizedRate.toFixed(2)),
          startDate: performance.startDate
        },
        assetTypes: state.assetTypes.map(asset => ({
          id: asset.id,
          name: asset.name,
          amount: asset.amount,
          bearRate: assetScenarioRate(asset, 'bear'),
          annualRate: asset.annualRate,
          bullRate: assetScenarioRate(asset, 'bull')
        })),
        previousForecast: compactPreviousForecast(state.aiAnalysis?.forecast),
        planningContext: aiBlueprint()
      },
      settingsSnapshot: compactSettingsSnapshot()
    });
    const forecast = forecastPayload.forecast;
    const report = forecastPayload.report;
    if (forecastPayload.aiUsage) accountAiUsage = forecastPayload.aiUsage;
    if (!forecast || !Array.isArray(forecast.assetForecasts)) throw new Error('AI 没有返回可用的年化假设');
    if (!report) throw new Error('AI 没有返回分析报告');
    const rates = new Map(forecast.assetForecasts.map(item => [String(item.assetTypeId), item]));
    state.assetTypes.forEach(asset => {
      const item = rates.get(String(asset.id));
      if (!item) return;
      const baseRate = Number(item.baseRate ?? item.annualRate);
      const bearRate = Number(item.bearRate);
      const bullRate = Number(item.bullRate);
      if (Number.isFinite(baseRate)) asset.annualRate = Math.max(-99, Math.min(500, baseRate));
      const normalizedBaseRate = Number.isFinite(baseRate) ? Math.max(-99, Math.min(500, baseRate)) : asset.annualRate;
      asset.bearRate = Number.isFinite(bearRate) ? Math.max(-99, Math.min(500, bearRate)) : Math.max(-99, normalizedBaseRate - state.scenarioSpread);
      asset.bullRate = Number.isFinite(bullRate) ? Math.max(-99, Math.min(500, bullRate)) : Math.min(500, normalizedBaseRate + state.scenarioSpread);
    });
    state.aiAnalysis = { forecast, report };
    saveState();
    render();
    renderForecastQuota();
    stopAiProgress();
    setAiState('');
  } catch (error) {
    if (error?.retryAfter) setAiCooldown(error.retryAfter + 1);
    saveState();
    render();
    stopAiProgress();
    setAiState(error?.message || 'AI 分析失败，请稍后重试。', true);
  } finally {
    aiRequestInFlight = false;
    stopAiProgress();
    refreshAiCooldownUi();
  }
}

function assetTypeOptions(selectedId) {
  return state.assetTypes.map(asset => `<option value="${escapeHtml(asset.id)}" ${asset.id === selectedId ? 'selected' : ''}>${escapeHtml(asset.name)}</option>`).join('');
}

function renderAssetTypes() {
  const container = document.querySelector('#asset-type-list');
  container.innerHTML = state.assetTypes.map(asset => `<div class="asset-type-row" data-asset-id="${escapeHtml(asset.id)}">
    <div class="asset-name-line">
      ${planField('资产类型', `<input data-asset-field="name" value="${escapeHtml(asset.name)}" maxlength="16">`, 'asset-name')}
      <button class="remove-plan" data-remove-asset="${escapeHtml(asset.id)}" type="button" aria-label="删除${escapeHtml(asset.name)}">×</button>
    </div>
    ${planField('当前金额', `<div class="money-input"><b>¥</b><input data-asset-field="amount" type="number" min="0" step="1000" value="${asset.amount}"></div>`, 'asset-amount')}
    ${planField('悲观', `<div class="asset-rate"><input data-asset-field="bearRate" type="number" min="-99" max="500" step="0.1" value="${assetScenarioRate(asset, 'bear')}"><i>%</i></div>`, 'asset-bear-rate')}
    ${planField('基准', `<div class="asset-rate"><input data-asset-field="annualRate" type="number" min="-99" max="500" step="0.1" value="${asset.annualRate}"><i>%</i></div>`, 'asset-base-rate')}
    ${planField('乐观', `<div class="asset-rate"><input data-asset-field="bullRate" type="number" min="-99" max="500" step="0.1" value="${assetScenarioRate(asset, 'bull')}"><i>%</i></div>`, 'asset-bull-rate')}
    ${planField('美元占比', `<div class="asset-rate"><input data-asset-field="usdExposurePct" type="number" min="0" max="100" step="5" value="${asset.usdExposurePct}"><i>%</i></div>`, 'asset-usd-exposure')}
  </div>`).join('');
  container.querySelectorAll('[data-asset-field]').forEach(input => {
    input.oninput = () => {
      const row = input.closest('[data-asset-id]');
      const asset = state.assetTypes.find(item => item.id === row.dataset.assetId);
      if (!asset) return;
      const field = input.dataset.assetField;
      asset[field] = field === 'name' ? input.value : Number(input.value || 0);
      if (field === 'amount') asset.amount = Math.max(0, asset.amount);
      if (['bearRate', 'annualRate', 'bullRate'].includes(field)) asset[field] = Math.max(-99, Math.min(500, asset[field]));
      if (field === 'usdExposurePct') asset.usdExposurePct = Math.min(100, Math.max(0, asset.usdExposurePct));
      saveState();
      if (field === 'name') renderPlans();
      renderResults();
    };
  });
  container.querySelectorAll('[data-remove-asset]').forEach(button => {
    button.onclick = () => {
      if (state.assetTypes.length === 1) return;
      const removedId = button.dataset.removeAsset;
      state.assetTypes = state.assetTypes.filter(asset => asset.id !== removedId);
      const fallbackId = state.assetTypes[0].id;
      state.plans.forEach(plan => { if (plan.assetTypeId === removedId) plan.assetTypeId = fallbackId; });
      saveAndRender();
    };
  });
}

function renderPlans() {
  const container = document.querySelector('#plan-list');
  if (!state.plans.length) {
    container.innerHTML = '<p class="empty-plans">尚未设置定投计划</p>';
    return;
  }
  container.innerHTML = state.plans.map(plan => `<div class="plan-row" data-plan-id="${escapeHtml(plan.id)}">
    ${planField('名称', `<input data-field="name" value="${escapeHtml(plan.name)}" maxlength="24">`)}
    ${planField('归入', `<select data-field="assetTypeId">${assetTypeOptions(plan.assetTypeId)}</select>`)}
    ${planField('金额', `<input data-field="amount" type="number" min="0" step="1000" value="${plan.amount}">`)}
    ${planField('频率', `<select data-field="frequency"><option value="monthly" ${plan.frequency === 'monthly' ? 'selected' : ''}>每月</option><option value="yearly" ${plan.frequency === 'yearly' ? 'selected' : ''}>每年</option></select>`)}
    ${planField('开始', `<input data-field="startMonth" type="month" value="${plan.startMonth}">`)}
    ${planField('结束', `<input data-field="endMonth" type="month" value="${plan.endMonth}">`)}
    ${planField('补贴', `<div class="scenario"><div><input data-field="bonusPct" type="number" min="0" max="100" step="0.1" value="${plan.bonusPct}"><b>%</b></div></div>`)}
    <button class="remove-plan" data-remove-plan="${escapeHtml(plan.id)}" type="button" aria-label="删除${escapeHtml(plan.name)}">×</button>
  </div>`).join('');
  container.querySelectorAll('[data-field]').forEach(input => {
    const row = input.closest('[data-plan-id]');
    input.oninput = () => {
      const plan = state.plans.find(item => item.id === row.dataset.planId);
      if (!plan) return;
      const field = input.dataset.field;
      plan[field] = ['amount', 'bonusPct'].includes(field) ? Math.max(0, Number(input.value || 0)) : input.value;
      saveState();
      renderResults();
    };
  });
  container.querySelectorAll('[data-remove-plan]').forEach(button => {
    button.onclick = () => { state.plans = state.plans.filter(plan => plan.id !== button.dataset.removePlan); saveAndRender(); };
  });
}

function formatAchievement(date) {
  if (!date) return '40年内未达到';
  const target = parseMonth(state.targetDate);
  const difference = monthDifference(target, date);
  if (difference === 0) return '目标月达成';
  if (difference < 0) return `提前${Math.abs(difference)}个月`;
  return `延后${difference}个月`;
}

function resultCard(key, label, scenario, result) {
  const gap = result.balance - state.targetAssets;
  const achieved = achievementDate(scenario);
  return `<article class="result-card ${key}"><div class="result-label"><span>${label}</span></div><strong>${yen.format(result.balance)}</strong><p class="${gap >= 0 ? 'up' : 'down'}">${gap >= 0 ? '超过目标' : '距离目标'} ${yen.format(Math.abs(gap))}</p><p>${formatAchievement(achieved)}</p></article>`;
}

function renderAssetEditorState() {
  const editor = document.querySelector('#asset-editor');
  editor.hidden = !state.assetEditorOpen;
  document.querySelector('#asset-editor-toggle').textContent = state.assetEditorOpen ? '完成' : '调整';
}

function renderAssetValuations(result) {
  const entries = state.assetTypes.map(asset => ({
    asset,
    value: Math.max(0, Number(result.valuedBalances[asset.id] || 0))
  }));
  const rawTotal = entries.reduce((sum, entry) => sum + entry.value, 0);
  const total = Math.max(rawTotal, 1);
  let offset = 0;
  const segments = entries.filter(entry => entry.value > 0).map(entry => {
    const start = offset;
    offset += entry.value / total * 100;
    return `${assetColor(entry.asset)} ${start.toFixed(3)}% ${offset.toFixed(3)}%`;
  });
  const pieBackground = segments.length ? `conic-gradient(${segments.join(',')})` : '#edf0ee';
  document.querySelector('#valuation-date').textContent = monthLabel.format(parseMonth(state.targetDate));
  document.querySelector('#asset-valuation-list').innerHTML = `<div class="valuation-pie" style="background:${pieBackground}" role="img" aria-label="各类资产目标估值比例">
    <div><small>期末估值</small><strong>${yen.format(rawTotal)}</strong></div>
  </div>
  <div class="valuation-legend">${entries.map(({ asset, value }) => {
    const share = Math.max(0, value / total * 100);
    return `<div class="valuation-legend-row"><span><i style="background:${assetColor(asset)}"></i>${escapeHtml(asset.name)}</span><strong>${yen.format(value)}</strong><small>${share.toFixed(1)}%</small></div>`;
  }).join('')}</div>`;
}

function scenarioLabel(scenario) {
  return scenario === 'bear' ? '悲观' : scenario === 'bull' ? '乐观' : '基准';
}

function renderChartDetail(point, scenario = 'base') {
  const detail = document.querySelector('#chart-detail');
  if (!point || state.chartView !== 'bar') {
    detail.hidden = true;
    return;
  }
  detail.hidden = false;
  const performance = currentPerformance();
  const forecastProfit = point.balance - currentAssets() - point.personal - point.subsidy;
  document.querySelector('#chart-detail-date').textContent = `${monthLabel.format(point.date)} · ${scenarioLabel(scenario)}`;
  document.querySelector('#chart-detail-total').textContent = yen.format(point.balance);
  document.querySelector('#chart-detail-principal').textContent = yen.format(performance.principal);
  const existingProfitElement = document.querySelector('#chart-detail-existing-profit');
  existingProfitElement.textContent = `${performance.existingProfit > 0 ? '+' : ''}${yen.format(performance.existingProfit)}`;
  existingProfitElement.className = performance.existingProfit > 0 ? 'up' : performance.existingProfit < 0 ? 'down' : '';
  document.querySelector('#chart-detail-contribution').textContent = yen.format(point.personal);
  const profitElement = document.querySelector('#chart-detail-profit');
  profitElement.textContent = `${forecastProfit > 0 ? '+' : ''}${yen.format(forecastProfit)}`;
  profitElement.className = forecastProfit > 0 ? 'up' : forecastProfit < 0 ? 'down' : '';
}

function renderMilestones(result, scenario = 'base') {
  const points = result.points.filter((point, index, all) => index === all.length - 1 || all[index + 1].date.getFullYear() !== point.date.getFullYear());
  const performance = currentPerformance();
  document.querySelector('#milestone-title').textContent = `年度节点 · ${scenarioLabel(scenario)}情景`;
  document.querySelector('#milestone-list').innerHTML = points.map(point => {
    const profit = point.balance - performance.principal - point.personal - point.subsidy;
    const gap = point.balance - state.targetAssets;
    const dateText = point.date.getMonth() === 11 ? `${point.date.getFullYear()}年` : monthLabel.format(point.date);
    return `<div class="milestone-row">
      <span>${dateText}</span>
      <span><small>总资产</small><strong>${yen.format(point.balance)}</strong></span>
      <span><small>累计投入</small><strong>${yen.format(point.personal)}</strong></span>
      <span><small>投资收益</small><strong class="${profit > 0 ? 'up' : profit < 0 ? 'down' : ''}">${profit > 0 ? '+' : ''}${yen.format(profit)}</strong></span>
      <span><small>距离目标</small><strong class="${gap >= 0 ? 'up' : 'down'}">${gap >= 0 ? '超' : '差'} ${yen.format(Math.abs(gap))}</strong></span>
    </div>`;
  }).join('');
}

function renderChart(results) {
  if (!window.Chart) return;
  const darkTheme = document.body.classList.contains('theme-ibkr');
  const chartPalette = darkTheme
    ? { bear: '#788296', base: '#ff4d68', baseFill: 'rgba(255,77,104,.10)', bull: '#31d39a', target: '#f6f7fb', text: '#929bad', grid: 'rgba(141,150,168,.15)' }
    : { bear: '#89958f', base: '#426af4', baseFill: 'rgba(66,106,244,.08)', bull: '#e55269', target: '#17201d', text: '#7a8782', grid: '#e7ece9' };
  const isBar = state.chartView === 'bar';
  const selectedScenario = ['bear', 'base', 'bull'].includes(state.projectionScenario) ? state.projectionScenario : 'base';
  const selectedResult = selectedScenario === 'bear' ? results.pessimistic : selectedScenario === 'bull' ? results.optimistic : results.baseline;
  const allPoints = results.baseline.points;
  const indexes = isBar
    ? allPoints.map((_, index) => index).filter(index => index === 0 || index === allPoints.length - 1 || index % 12 === 0)
    : allPoints.map((_, index) => index);
  const labels = indexes.map(index => monthLabel.format(allPoints[index].date));
  const values = result => indexes.map(index => result.points[index].balance);
  const datasets = isBar
    ? state.assetTypes.map(asset => ({
      label: asset.name,
      data: indexes.map(index => selectedResult.points[index].valuedBalances[asset.id] || 0),
      backgroundColor: assetColor(asset, .82),
      borderWidth: 0,
      borderRadius: 2,
      stack: 'assets'
    }))
    : [
      { label: '悲观', data: values(results.pessimistic), borderColor: chartPalette.bear, backgroundColor: 'transparent', borderWidth: 2, pointRadius: 0, tension: .25 },
      { label: '基准', data: values(results.baseline), borderColor: chartPalette.base, backgroundColor: chartPalette.baseFill, fill: true, borderWidth: 3, pointRadius: 0, tension: .25 },
      { label: '乐观', data: values(results.optimistic), borderColor: chartPalette.bull, backgroundColor: 'transparent', borderWidth: 2, pointRadius: 0, tension: .25 }
    ];
  datasets.push({
    type: 'line',
    label: '目标',
    data: labels.map(() => isBar ? null : state.targetAssets),
    borderColor: chartPalette.target,
    backgroundColor: 'transparent',
    borderDash: [7, 7],
    borderWidth: 1.5,
    pointRadius: 0
  });
  const targetLinePlugin = {
    id: 'targetLine',
    afterDatasetsDraw(chartInstance) {
      if (!isBar) return;
      const { ctx, chartArea, scales } = chartInstance;
      const y = scales.y.getPixelForValue(state.targetAssets);
      if (y < chartArea.top || y > chartArea.bottom) return;
      ctx.save();
      ctx.beginPath();
      ctx.setLineDash([7, 7]);
      ctx.strokeStyle = chartPalette.target;
      ctx.lineWidth = 1.5;
      ctx.moveTo(chartArea.left, y);
      ctx.lineTo(chartArea.right, y);
      ctx.stroke();
      ctx.restore();
    }
  };
  if (chart) chart.destroy();
  chart = new Chart(document.querySelector('#projection-chart'), {
    type: isBar ? 'bar' : 'line',
    data: { labels, datasets },
    plugins: [targetLinePlugin],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      onClick: (_, elements) => {
        if (!isBar || !elements.length) return;
        renderChartDetail(selectedResult.points[indexes[elements[0].index]], selectedScenario);
      },
      plugins: {
        legend: { position: 'top', labels: { usePointStyle: true, boxWidth: 8, color: chartPalette.text } },
        tooltip: { callbacks: { label: context => `${context.dataset.label}：${yen.format(context.parsed.y)}` } }
      },
      scales: {
        x: { stacked: isBar, grid: { display: false }, ticks: { maxTicksLimit: 9, color: chartPalette.text } },
        y: { stacked: isBar, beginAtZero: false, suggestedMax: isBar ? state.targetAssets * 1.05 : undefined, grid: { color: chartPalette.grid }, ticks: { color: chartPalette.text, callback: value => value >= 10000000 ? `${(value / 10000000).toFixed(1)}千万` : `${Math.round(value / 10000)}万` } }
      }
    }
  });
  renderChartDetail(isBar ? selectedResult.points[indexes[indexes.length - 1]] : null, selectedScenario);
}

function renderResults() {
  const results = {
    pessimistic: simulate('bear'),
    baseline: simulate('base'),
    optimistic: simulate('bull')
  };
  const assets = currentAssets();
  const performance = currentPerformance();
  document.querySelector('#current-assets').value = Math.round(assets);
  document.querySelector('#target-current-value').textContent = yen.format(assets);
  const targetProgressPct = state.targetAssets > 0 ? assets / state.targetAssets * 100 : 0;
  document.querySelector('#target-progress-bar').style.width = `${Math.min(100, Math.max(0, targetProgressPct))}%`;
  document.querySelector('#target-progress-rate').textContent = `已完成 ${targetProgressPct.toFixed(1)}%`;
  const targetCurrentGap = assets - state.targetAssets;
  const targetProgressGap = document.querySelector('#target-progress-gap');
  targetProgressGap.textContent = `${targetCurrentGap >= 0 ? '已超过' : '还差'} ${yen.format(Math.abs(targetCurrentGap))}`;
  targetProgressGap.className = targetCurrentGap >= 0 ? 'up' : '';
  document.querySelector('#current-principal').textContent = yen.format(performance.principal);
  const currentProfit = document.querySelector('#current-profit');
  currentProfit.textContent = `${performance.existingProfit >= 0 ? '+' : ''}${yen.format(performance.existingProfit)}`;
  currentProfit.className = performance.existingProfit > 0 ? 'up' : performance.existingProfit < 0 ? 'down' : '';
  const currentProfitRate = document.querySelector('#current-profit-rate');
  currentProfitRate.textContent = `${performance.profitPct >= 0 ? '+' : ''}${performance.profitPct.toFixed(2)}%`;
  currentProfitRate.className = performance.existingProfit > 0 ? 'up' : performance.existingProfit < 0 ? 'down' : '';
  const historicalRate = document.querySelector('#historical-rate');
  historicalRate.textContent = performance.annualizedRate === null ? '—' : `${performance.annualizedRate.toFixed(2)}%`;
  historicalRate.className = performance.annualizedRate === null ? '' : performance.annualizedRate >= 0 ? 'up' : 'down';
  document.querySelector('#historical-rate-start').textContent = performance.startDate ? `自 ${performance.startDate}` : '';
  document.querySelector('#weighted-rate').innerHTML = [
    `<span>悲观 ${weightedScenarioRate('bear').toFixed(1)}%</span>`,
    `<b>基准 ${weightedScenarioRate('base').toFixed(1)}%</b>`,
    `<span>乐观 ${weightedScenarioRate('bull').toFixed(1)}%</span>`
  ].join('');
  const currentFxInput = document.querySelector('#current-usd-jpy');
  if (document.activeElement !== currentFxInput) currentFxInput.value = Number(state.currentUsdJpy || 0).toFixed(2);
  currentFxInput.readOnly = Boolean(syncedPortfolio);
  state.assetTypes.forEach(asset => {
    const amountInput = document.querySelector(`[data-asset-id="${CSS.escape(asset.id)}"] [data-asset-field="amount"]`);
    if (amountInput && document.activeElement !== amountInput) amountInput.value = Math.round(asset.amount);
  });
  document.querySelectorAll('[data-chart-view]').forEach(button => button.classList.toggle('active', button.dataset.chartView === state.chartView));
  const projectionScenarioSwitch = document.querySelector('#projection-scenario-switch');
  projectionScenarioSwitch.hidden = state.chartView !== 'bar';
  document.querySelectorAll('[data-projection-scenario]').forEach(button => button.classList.toggle('active', button.dataset.projectionScenario === state.projectionScenario));
  const fxValue = Number(state.fxStressPct || 0);
  document.querySelector('#fx-state-label').textContent = fxValue < 0 ? `USD/JPY 日元升值 ${Math.abs(fxValue)}%` : fxValue > 0 ? `USD/JPY 日元贬值 ${fxValue}%` : 'USD/JPY 无变化';
  document.querySelector('#stressed-usd-jpy').textContent = (Number(state.currentUsdJpy || 0) * (1 + fxValue / 100)).toFixed(2);
  const baselineGap = results.baseline.balance - state.targetAssets;
  document.querySelector('#baseline-ending').textContent = yen.format(results.baseline.balance);
  const gapElement = document.querySelector('#baseline-gap');
  gapElement.textContent = `${baselineGap >= 0 ? '超过目标' : '距离目标'} ${yen.format(Math.abs(baselineGap))}`;
  gapElement.className = baselineGap >= 0 ? 'up' : 'down';
  const required = requiredAnnualRate();
  document.querySelector('#required-rate').textContent = required === null ? '>500%' : `${required.toFixed(2)}%`;
  const plannedAnnualRate = document.querySelector('#planned-annual-rate');
  const plannedRate = weightedExpectedRate();
  plannedAnnualRate.textContent = `${plannedRate.toFixed(2)}%`;
  plannedAnnualRate.className = required !== null && plannedRate >= required ? 'up' : 'down';
  const achievement = results.baseline.achievedAt;
  const progressText = achievement
    ? `按当前设定，预计 <strong>${monthLabel.format(achievement)}</strong> 达到目标`
    : `按当前设定，到目标时间仍差 <strong>${yen.format(Math.abs(baselineGap))}</strong>`;
  document.querySelector('#target-rate-hint').innerHTML = progressText;
  document.querySelector('#planned-contribution').textContent = yen.format(results.baseline.personal);
  document.querySelector('#planned-subsidy').textContent = results.baseline.subsidy ? `补贴 ${yen.format(results.baseline.subsidy)}` : '无额外补贴';
  const currentContribution = contributionForMonth(parseMonth(monthValue()));
  const monthlyEquivalent = state.plans.reduce((sum, plan) => sum + Number(plan.amount || 0) * (plan.frequency === 'yearly' ? 1 / 12 : 1), 0);
  const annualEquivalent = monthlyEquivalent * 12;
  document.querySelector('#monthly-equivalent').textContent = `月均 ${yen.format(monthlyEquivalent)} · 年均 ${yen.format(annualEquivalent)}${currentContribution.subsidy ? ` · 当前补贴 ${yen.format(currentContribution.subsidy)}` : ''}`;
  document.querySelector('#scenario-results').innerHTML = [
    resultCard('pessimistic', '悲观情景', 'bear', results.pessimistic),
    resultCard('baseline', '基准情景', 'base', results.baseline),
    resultCard('optimistic', '乐观情景', 'bull', results.optimistic)
  ].join('');
  const selectedProjectionResult = state.projectionScenario === 'bear' ? results.pessimistic : state.projectionScenario === 'bull' ? results.optimistic : results.baseline;
  renderMilestones(selectedProjectionResult, state.projectionScenario);
  renderAssetValuations(selectedProjectionResult);
  const invested = selectedProjectionResult.personal + selectedProjectionResult.subsidy;
  const forecastProfit = selectedProjectionResult.balance - assets - invested;
  const cumulativeProfit = performance.existingProfit + forecastProfit;
  const total = Math.max(selectedProjectionResult.balance, 1);
  document.querySelector('#composition-title').textContent = `${scenarioLabel(state.projectionScenario)}情景资金构成`;
  document.querySelector('#base-profit').textContent = `累计收益 ${cumulativeProfit >= 0 ? '+' : ''}${yen.format(cumulativeProfit)}`;
  document.querySelector('#base-profit').className = cumulativeProfit >= 0 ? 'up' : 'down';
  document.querySelector('#current-share').style.width = `${Math.max(0, performance.principal / total * 100)}%`;
  document.querySelector('#existing-profit-share').style.width = `${Math.max(0, performance.existingProfit / total * 100)}%`;
  document.querySelector('#contribution-share').style.width = `${Math.max(0, invested / total * 100)}%`;
  document.querySelector('#profit-share').style.width = `${Math.max(0, forecastProfit / total * 100)}%`;
  renderChart(results);
}

function render() {
  renderAssetEditorState();
  renderAssetTypes();
  renderPlans();
  renderResults();
  renderAiAnalysis();
}

const simulatorViews = new Set(['target', 'planning', 'ai', 'trend', 'result']);
const simulatorViewOrder = ['target', 'planning', 'ai', 'trend', 'result'];
let activeSimulatorView = 'target';
let simulatorTabAnimationTimer = null;

function animateSimulatorTabTransition(direction) {
  if (!direction) return;
  const surfaces = [...document.querySelectorAll('[data-simulator-panel]:not(.simulator-view-hidden)')];
  if (!surfaces.length) return;
  surfaces.forEach(surface => {
    surface.classList.remove('tab-swipe-enter-forward', 'tab-swipe-enter-backward');
    void surface.offsetWidth;
    surface.classList.add(direction > 0 ? 'tab-swipe-enter-forward' : 'tab-swipe-enter-backward');
  });
  clearTimeout(simulatorTabAnimationTimer);
  simulatorTabAnimationTimer = setTimeout(() => {
    surfaces.forEach(surface => surface.classList.remove('tab-swipe-enter-forward', 'tab-swipe-enter-backward'));
  }, 280);
}

function setSimulatorView(view, scrollToTop = true, swipeDirection = 0) {
  activeSimulatorView = simulatorViews.has(view) ? view : 'target';
  document.querySelectorAll('[data-simulator-panel]').forEach(panel => {
    panel.classList.toggle('simulator-view-hidden', panel.dataset.simulatorPanel !== activeSimulatorView);
  });
  document.querySelectorAll('[data-simulator-view]').forEach(button => {
    const active = button.dataset.simulatorView === activeSimulatorView;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  if (scrollToTop) window.scrollTo({ top: 0, behavior: 'auto' });
  animateSimulatorTabTransition(swipeDirection);
}

document.querySelectorAll('[data-simulator-view]').forEach(button => {
  button.onclick = () => setSimulatorView(button.dataset.simulatorView);
});

function simulatorSwipeShouldStayInContent(target) {
  return Boolean(target.closest('input, textarea, select, dialog, [contenteditable="true"]'));
}

function enableSimulatorViewSwipe() {
  const swipeSurface = document.querySelector('.simulator-shell');
  if (!swipeSurface) return;
  let touchStart = null;
  swipeSurface.addEventListener('touchstart', event => {
    if (event.touches.length !== 1 || simulatorSwipeShouldStayInContent(event.target)) {
      touchStart = null;
      return;
    }
    const touch = event.touches[0];
    touchStart = { x: touch.clientX, y: touch.clientY };
  }, { passive: true });
  swipeSurface.addEventListener('touchend', event => {
    if (!touchStart || event.changedTouches.length !== 1) return;
    const touch = event.changedTouches[0];
    const deltaX = touch.clientX - touchStart.x;
    const deltaY = touch.clientY - touchStart.y;
    touchStart = null;
    if (Math.abs(deltaX) < 36 || Math.abs(deltaX) <= Math.abs(deltaY) * 1.08) return;
    const currentIndex = simulatorViewOrder.indexOf(activeSimulatorView);
    const nextView = simulatorViewOrder[currentIndex + (deltaX < 0 ? 1 : -1)];
    if (nextView) setSimulatorView(nextView, true, deltaX < 0 ? 1 : -1);
  }, { passive: true });
  swipeSurface.addEventListener('touchcancel', () => { touchStart = null; }, { passive: true });
}

enableSimulatorViewSwipe();

document.querySelector('#add-asset-type').onclick = () => {
  state.assetTypes.unshift({ id: crypto.randomUUID(), name: '新类型', amount: 0, bearRate: 3, annualRate: 8, bullRate: 13, usdExposurePct: 0 });
  saveAndRender();
};
document.querySelector('#asset-editor-toggle').onclick = () => {
  state.assetEditorOpen = !state.assetEditorOpen;
  saveState();
  renderAssetEditorState();
};
document.querySelector('#ai-report-refresh').onclick = runAiAnalysis;
document.querySelector('#ai-empty-run').onclick = runAiAnalysis;
refreshAiCooldownUi();
void loadAccountAiUsage();
document.querySelector('#back-dashboard').onclick = () => {
  const dashboardUrl = new URL('/index.html', location.origin);
  const storedMode = localStorage.getItem('portfolioSessionMode') || '';
  const dashboardMode = ['owner', 'friend', 'user'].includes(simulatorCookieMode)
    ? simulatorCookieMode
    : ['owner', 'friend', 'user'].includes(storedMode) ? storedMode : '';
  if (dashboardMode) dashboardUrl.searchParams.set('mode', dashboardMode);
  if (dashboardMode === 'user' && simulatorRequestedUserId) {
    dashboardUrl.searchParams.set('local', '1');
    dashboardUrl.searchParams.set('user', simulatorRequestedUserId);
  }
  dashboardUrl.searchParams.set('v', '20260922-1');
  const returnView = new URLSearchParams(location.search).get('returnView');
  if (['overview', 'holdings', 'calendar', 'analysis', 'settings'].includes(returnView)) {
    dashboardUrl.searchParams.set('view', returnView);
  }
  if (!dashboardMode && simulatorLocalMode) {
    dashboardUrl.searchParams.set('local', '1');
    if (simulatorProfileToken && simulatorProfileToken !== 'session') dashboardUrl.searchParams.set('profile', simulatorProfileToken);
  }
  else if (!dashboardMode && simulatorAccessToken) dashboardUrl.searchParams.set('token', simulatorAccessToken);
  location.href = dashboardUrl.href;
};
document.querySelectorAll('[data-chart-view]').forEach(button => {
  button.onclick = () => {
    state.chartView = button.dataset.chartView === 'bar' ? 'bar' : 'line';
    saveState();
    renderResults();
  };
});
document.querySelectorAll('[data-projection-scenario]').forEach(button => {
  button.onclick = () => {
    state.projectionScenario = ['bear', 'base', 'bull'].includes(button.dataset.projectionScenario) ? button.dataset.projectionScenario : 'base';
    saveState();
    renderResults();
  };
});
document.querySelector('#add-plan').onclick = () => {
  state.plans.unshift({ id: crypto.randomUUID(), name: '新定投', assetTypeId: state.assetTypes[0].id, amount: 10000, frequency: 'monthly', startMonth: monthValue(), endMonth: '', bonusPct: 0 });
  document.querySelector('#plan-editor').hidden = false;
  document.querySelector('#plan-editor-toggle').textContent = '收起';
  saveAndRender();
};
document.querySelector('#plan-editor-toggle').onclick = () => {
  const editor = document.querySelector('#plan-editor');
  editor.hidden = !editor.hidden;
  document.querySelector('#plan-editor-toggle').textContent = editor.hidden ? '调整' : '收起';
};
document.querySelector('#reset-simulator').onclick = () => {
  if (!confirm('恢复默认目标、资产类型和定投计划吗？')) return;
  state = defaultState();
  hydrateControls();
  saveAndRender();
};

function flushRemoteState() {
  if (localStorage.getItem(DIRTY_KEY) !== '1') return;
  clearTimeout(remoteSaveTimer);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  void saveRemoteState(true);
}

window.addEventListener('pagehide', flushRemoteState);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushRemoteState();
});

async function initializeSimulator() {
  hydrateControls();
  render();
  setSimulatorView(activeSimulatorView, false);
  const loadedRemoteState = await loadRemoteState();
  await syncMainPortfolio(!loadedRemoteState && !hadLocalSimulatorState);
  remoteSettingsReady = true;
  if (!loadedRemoteState && localStorage.getItem(DIRTY_KEY) === '1') saveState();
  else saveState(false, false);
  setSimulatorView(activeSimulatorView, false);
}

initializeSimulator();
