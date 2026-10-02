const viewPreferencesKey = 'portfolioViewPreferencesV1';
document.querySelector('link[href*="ibkr-theme.css"]')?.setAttribute('href', 'ibkr-theme.css?v=20260830-7');
const themePreferenceKey = 'portfolioThemeV1';
const overviewPrivacyKey = 'portfolioOverviewAmountsHiddenV1';
let overviewAmountsHidden = localStorage.getItem(overviewPrivacyKey) === '1';
const currentThemePreference = () => localStorage.getItem(themePreferenceKey) === 'light' ? 'light' : 'ibkr';
const usesIbkrTheme = () => document.body.classList.contains('theme-ibkr');
const overviewEyeIcon = hidden => hidden
  ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18M10.6 10.7a2 2 0 0 0 2.7 2.7M9.9 4.3A10.6 10.6 0 0 1 12 4c5.3 0 9 5 9 5a15.4 15.4 0 0 1-2.6 2.8M6.2 6.2C4.2 7.5 3 9 3 9s3.7 5 9 5c1.2 0 2.3-.2 3.3-.7"/></svg>'
  : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9s3.7-5 9-5 9 5 9 5-3.7 5-9 5-9-5-9-5Z"/><circle cx="12" cy="9" r="2.5"/></svg>';
function renderOverviewPrivacy() {
  const overview = document.querySelector('.asset-overview');
  const button = document.querySelector('#overview-visibility-toggle');
  if (!overview || !button) return;
  overview.classList.toggle('amounts-hidden', overviewAmountsHidden);
  overview.querySelectorAll('#total, #principal .summary-value, #profit, #profit-pct, #daily-profit, #annualized .summary-value').forEach(element => {
    if (overviewAmountsHidden) {
      if (element.textContent !== '***') element.dataset.privateValue = element.textContent;
      element.textContent = '***';
    } else if (element.dataset.privateValue !== undefined) {
      element.textContent = element.dataset.privateValue;
      delete element.dataset.privateValue;
    }
  });
  button.innerHTML = overviewEyeIcon(overviewAmountsHidden);
  button.setAttribute('aria-pressed', String(overviewAmountsHidden));
  button.setAttribute('aria-label', overviewAmountsHidden ? '显示资产金额' : '隐藏资产金额');
  button.title = overviewAmountsHidden ? '显示资产金额' : '隐藏资产金额';
}
function toggleOverviewPrivacy() {
  overviewAmountsHidden = !overviewAmountsHidden;
  localStorage.setItem(overviewPrivacyKey, overviewAmountsHidden ? '1' : '0');
  renderOverviewPrivacy();
}
function readViewPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(viewPreferencesKey) || 'null') || {};
    const validSortKeys = new Set(['name', 'market', 'value', 'profit', 'price', 'change', 'daily']);
    const savedAccountFilter = typeof saved.accountFilter === 'string' ? saved.accountFilter : '全部';
    return {
      accountFilter: savedAccountFilter,
      productFilter: savedAccountFilter === '全部'
        ? '全部'
        : typeof saved.productFilter === 'string' ? saved.productFilter : '全部',
      sortKey: validSortKeys.has(saved.sortKey) ? saved.sortKey : 'value',
      sortDirection: saved.sortDirection === 1 ? 1 : -1
    };
  } catch {
    return { accountFilter: '全部', productFilter: '全部', sortKey: 'value', sortDirection: -1 };
  }
}
const viewPreferences = readViewPreferences();
function saveViewPreferences() {
  localStorage.setItem(viewPreferencesKey, JSON.stringify({ accountFilter, productFilter, sortKey, sortDirection }));
}
let portfolio, allocationChart, trendChart, analysisPrompt = '', pendingImportHoldings = null;
let chartLibraryPromise = null;
let displayedMonth = new Date(), reportDate = new Date(), accountFilter = viewPreferences.accountFilter, productFilter = viewPreferences.productFilter, trendMode = 'day', trendView = 'trend', sortKey = viewPreferences.sortKey, sortDirection = viewPreferences.sortDirection;
let contributionRecord = null, contributionExpanded = false, contributionHasRecord = false, selectedCalendarDate = '';
let calendarDateUserSelected = false;
let dailyAiLoadingTimer = null;
let renderedDailyAiDate = '';
let editorBaselineHoldings = [], pendingHoldingChange = null, transactionDialogResolve = null;
let importReviewFields = new Map();
let liveQuoteStream = null, lastLiveEventAt = 0, pendingLiveRender = false;
let liveQuotePollActive = false;
let liveRenderTimer = null, lastLiveRenderAt = 0;
let latestLiveHistory = null;
let historyHydrated = false, historyHydrationPromise = null;
const liveHistoryOverrides = new Map();
let pendingFxFlash = 0;
let watchModeActive = true;
let trendViewport = null, trendGesture = null;
let trendLastTapAt = 0;
const trendPointers = new Map();
const pendingHoldingFlashes = new Map();
const benchmarkDefinitions = {
  sp500: { label: 'S&P500', color: '#df4d61' },
  nasdaq100: { label: 'NASDAQ-100', color: '#8a71d6' },
  topix: { label: 'TOPIX', color: '#e39a36' }
};
const benchmarkSettingsKey = 'portfolioBenchmarkSettingsV1';
function readBenchmarkSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(benchmarkSettingsKey) || 'null');
    const visible = Array.isArray(saved?.visible) ? saved.visible.filter(id => benchmarkDefinitions[id]) : ['sp500'];
    const primary = benchmarkDefinitions[saved?.primary] ? saved.primary : 'sp500';
    return { visible, primary };
  } catch {
    return { visible: ['sp500'], primary: 'sp500' };
  }
}
let benchmarkSettings = readBenchmarkSettings();
const queryParameters = new URLSearchParams(location.search);
const requestedDashboardView = queryParameters.get('view');
const requestedProfileToken = queryParameters.get('profile');
const requestedUserId = queryParameters.get('user');
const cookieMode = document.cookie.split(';').map(item => item.trim()).find(item => item.startsWith('portfolio_mode='))?.split('=')[1] || '';
const requestedSessionMode = queryParameters.get('mode');
const storedSessionMode = localStorage.getItem('portfolioSessionMode') || '';
const sessionMode = ['owner', 'friend', 'user'].includes(requestedSessionMode)
  ? requestedSessionMode
  : ['owner', 'friend', 'user'].includes(cookieMode) ? cookieMode : storedSessionMode;
if (['owner', 'friend', 'user'].includes(sessionMode)) localStorage.setItem('portfolioSessionMode', sessionMode);
let accountAiUsage = null;
const aiQuotaText = (category, label) => {
  if (sessionMode !== 'user' || !accountAiUsage) return label;
  if (!accountAiUsage.enabled) return 'AI未开通';
  const remaining = category === 'calendar' ? accountAiUsage.calendarRemaining : accountAiUsage.forecastRemaining;
  return `${label}（${remaining}/${accountAiUsage.limit}）`;
};
function refreshDailyAiButton(label = null) {
  const button = document.querySelector('#daily-ai-summary-button');
  if (!button) return;
  const baseLabel = label || (document.querySelector('#daily-ai-report')?.hidden ? 'AI总结' : '重新分析');
  button.textContent = aiQuotaText('calendar', baseLabel);
  if (sessionMode === 'user' && accountAiUsage) {
    button.disabled = !accountAiUsage.enabled || accountAiUsage.calendarRemaining <= 0 || !selectedCalendarDate;
  }
}
async function loadAccountAiUsage() {
  if (sessionMode !== 'user') return;
  try {
    const response = await fetch('/api/ai-usage', { cache: 'no-store' });
    const payload = await response.json();
    if (response.ok && !payload.error) accountAiUsage = payload;
  } catch {}
  refreshDailyAiButton();
}
const cookieProfileMode = sessionMode === 'friend';
const localPortfolioMode = queryParameters.get('local') === '1' || Boolean(requestedProfileToken) || cookieProfileMode || sessionMode === 'user';
const localProfileToken = requestedProfileToken || (cookieProfileMode ? 'session' : null);
const queryAccessToken = queryParameters.get('token');
if (queryAccessToken && !localPortfolioMode) localStorage.setItem('portfolioAccessToken', queryAccessToken);
const accessToken = localPortfolioMode ? null : queryAccessToken || localStorage.getItem('portfolioAccessToken');
const defaultInvestmentPlan = `年度投资预算：未设置
每月定投：未设置
目标日期与目标金额：未设置
风险承受能力与个人纪律：未设置`;
function investmentPlanWithOwnerPolicy(value) {
  return String(value || defaultInvestmentPlan).trim();
}
const apiFetch = (url, options = {}) => {
  const authenticatedUrl = accessToken ? `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(accessToken)}` : url;
  return fetch(authenticatedUrl, { ...options, headers: { ...(options.headers || {}), ...(accessToken ? { 'X-Portfolio-Token': accessToken } : {}) } });
};
const authenticatedUrl = url => accessToken ? `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(accessToken)}` : url;
const localPortfolioKey = requestedUserId
  ? `portfolioDashboardLocalPortfolioV1:user:${requestedUserId}`
  : localProfileToken
  ? `portfolioDashboardLocalPortfolioV1:${localProfileToken.slice(0, 12)}`
  : 'portfolioDashboardLocalPortfolioV1';
const localPortfolioPendingKey = `${localPortfolioKey}:pending`;
const investmentPlanDraftKey = `portfolioInvestmentPlanDraftV1:${requestedUserId || localProfileToken || sessionMode || 'owner'}`;
let investmentPlanSaveTimer = null;
let investmentPlanSaveRevision = 0;
let investmentPlanOperationQueue = Promise.resolve();
const cloudDeployment = location.hostname.endsWith('.vercel.app');
const temporaryQuoteBridge = location.hostname.endsWith('.trycloudflare.com');
function configureChartTheme(force = false) {
  if (!globalThis.Chart) return globalThis.Chart;
  const theme = usesIbkrTheme() ? 'ibkr' : 'light';
  if (!force && globalThis.Chart.__portfolioTheme === theme) return globalThis.Chart;
  const dark = theme === 'ibkr';
  globalThis.Chart.defaults.color = dark ? '#929bad' : '#63716a';
  globalThis.Chart.defaults.borderColor = dark ? 'rgba(141,150,168,.15)' : '#d8e1db';
  globalThis.Chart.defaults.font.family = 'Inter, -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
  globalThis.Chart.defaults.plugins.tooltip.backgroundColor = dark ? '#1b2030' : '#17201d';
  globalThis.Chart.defaults.plugins.tooltip.titleColor = '#f6f7fb';
  globalThis.Chart.defaults.plugins.tooltip.bodyColor = '#f6f7fb';
  globalThis.Chart.defaults.plugins.tooltip.borderColor = dark ? '#343b4d' : 'transparent';
  globalThis.Chart.defaults.plugins.tooltip.borderWidth = dark ? 1 : 0;
  globalThis.Chart.__portfolioTheme = theme;
  return globalThis.Chart;
}
function ensureChartLibrary() {
  if (globalThis.Chart) return Promise.resolve(configureChartTheme());
  if (chartLibraryPromise) return chartLibraryPromise;
  chartLibraryPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js';
    script.async = true;
    script.onload = () => resolve(configureChartTheme());
    script.onerror = () => reject(new Error('图表组件加载失败'));
    document.head.appendChild(script);
  });
  return chartLibraryPromise;
}
function portfolioSavePayload(data) {
  if (!cloudDeployment) return data;
  const { history, ...core } = data || {};
  return core;
}
const profileApiUrl = path => localProfileToken === 'session'
  ? path
  : `${path}?profile=${encodeURIComponent(localProfileToken || '')}`;
const cacheBustedUrl = url => `${url}${url.includes('?') ? '&' : '?'}_=${Date.now()}`;
let profileOperationQueue = Promise.resolve();
function enqueueProfileOperation(operation) {
  const next = profileOperationQueue.then(operation, operation);
  profileOperationQueue = next.catch(() => {});
  return next;
}
const blankLocalPortfolio = () => ({
  holdings: [],
  transactions: [],
  realizedTrades: [],
  history: [],
  fx: {},
  accountStartDate: null,
  ledgerStartDate: null,
  lastRefreshAt: null,
  investmentPlan: defaultInvestmentPlan,
  totalAssetsJPY: 0
});
function readLocalPortfolio() {
  try {
    let saved = JSON.parse(localStorage.getItem(localPortfolioKey) || 'null');
    if (!saved && localProfileToken) {
      saved = JSON.parse(localStorage.getItem('portfolioDashboardLocalPortfolioV1') || 'null');
      if (saved && Array.isArray(saved.holdings)) writeLocalPortfolio(saved);
    }
    return saved && Array.isArray(saved.holdings) ? saved : blankLocalPortfolio();
  } catch {
    return blankLocalPortfolio();
  }
}
function writeLocalPortfolio(data) {
  try {
    localStorage.setItem(localPortfolioKey, JSON.stringify(data));
  } catch (error) {
    if (error?.name !== 'QuotaExceededError') throw error;
    const { history, ...core } = data || {};
    localStorage.setItem(localPortfolioKey, JSON.stringify(core));
  }
  return data;
}
function preservedHistory(primary, ...fallbacks) {
  const historyByDate = new Map();
  [...fallbacks, primary].forEach(source => {
    const history = Array.isArray(source?.history) ? source.history : [];
    history.forEach(item => {
      if (item?.date) historyByDate.set(item.date, item);
    });
  });
  liveHistoryOverrides.forEach((item, date) => historyByDate.set(date, item));
  return [...historyByDate.values()].sort((left, right) => String(left.date).localeCompare(String(right.date)));
}
function withPreservedHistory(data, ...sources) {
  const history = preservedHistory(data, ...sources);
  return history.length ? { ...(data || {}), history } : data;
}
function portfolioHasContent(data) {
  return Boolean(
    data?.holdings?.length
    || data?.transactions?.length
    || data?.realizedTrades?.length
    || data?.history?.length
    || data?.accountStartDate
  );
}
async function readProfilePortfolio() {
  if (!localProfileToken) return null;
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const endpoint = cloudDeployment ? '/api/profile-portfolio-core' : '/api/profile-portfolio';
      const url = cacheBustedUrl(profileApiUrl(endpoint));
      const response = await fetch(url, { cache: 'no-store' });
      const result = await response.json();
      if (!response.ok || result.error) throw new Error(result.error || '无法恢复朋友持仓');
      if (!result.portfolio || !Array.isArray(result.portfolio.holdings)) {
        throw new Error('朋友持仓数据格式不正确');
      }
      return result.portfolio;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 700 * (attempt + 1)));
    }
  }
  throw lastError || new Error('无法恢复朋友持仓');
}
function normalizedHistory(history) {
  return [...(Array.isArray(history) ? history : [])]
    .filter(item => item && typeof item.date === 'string')
    .filter(item => {
      const weekday = new Date(`${item.date}T12:00:00Z`).getUTCDay();
      return weekday !== 0 && weekday !== 6;
    })
    .sort((left, right) => left.date.localeCompare(right.date));
}
function historyWithLiveOverrides(history) {
  const byDate = new Map(normalizedHistory(history).map(item => [item.date, item]));
  liveHistoryOverrides.forEach((item, date) => byDate.set(date, item));
  return normalizedHistory([...byDate.values()]);
}
function reconcileLiveHistoryOverrides(serverHistory) {
  const serverByDate = new Map(normalizedHistory(serverHistory).map(item => [item.date, item]));
  liveHistoryOverrides.forEach((override, date) => {
    const server = serverByDate.get(date);
    if (!server) return;
    const sameSnapshot = Number(server.dailyProfitJPY || 0) === Number(override.dailyProfitJPY || 0)
      && Number(server.totalAssetsJPY || server.totalNetAsset || 0) === Number(override.totalAssetsJPY || override.totalNetAsset || 0)
      && JSON.stringify(server.updatedHoldings || []) === JSON.stringify(override.updatedHoldings || []);
    if (sameSnapshot) liveHistoryOverrides.delete(date);
  });
}
async function fetchPortfolioHistory() {
  const response = localPortfolioMode
    ? await fetch(cacheBustedUrl(profileApiUrl('/api/profile-portfolio-history')), { cache: 'no-store' })
    : await apiFetch(`/api/portfolio-history?_=${Date.now()}`, { cache: 'no-store' });
  const result = await response.json();
  if (!response.ok || result.error || !Array.isArray(result.history)) {
    throw new Error(result.error || '历史数据加载失败');
  }
  reconcileLiveHistoryOverrides(result.history);
  const history = historyWithLiveOverrides(result.history);
  if (!history.length) throw new Error('历史数据为空');
  return history;
}
async function portfolioReadyForRender(data, historyRequest = null, ...fallbackSources) {
  if (!cloudDeployment) {
    historyHydrated = true;
    return { data, error: null };
  }
  if (historyHydrated && Array.isArray(portfolio?.history) && portfolio.history.length) {
    return { data: withPreservedHistory(data, portfolio, ...fallbackSources), error: null };
  }
  try {
    const history = await (historyRequest || fetchPortfolioHistory());
    historyHydrated = true;
    return { data: { ...(data || {}), history }, error: null };
  } catch (error) {
    return { data: withPreservedHistory(data, ...fallbackSources), error };
  }
}
function hydrateInitialHistoryInBackground(historyRequest) {
  if (!historyRequest) return;
  historyHydrationPromise = Promise.resolve(historyRequest).then(history => {
    historyHydrated = true;
    const hydrated = { ...(portfolio || {}), history: historyWithLiveOverrides(history) };
    if (localPortfolioMode && localProfileToken) writeLocalPortfolio(hydrated);
    render(hydrated);
    return hydrated;
  }).catch(error => {
    const notice = document.querySelector('#notice');
    if (notice) notice.textContent = `历史数据加载失败，将自动重试：${error.message}`;
    return portfolio;
  }).finally(() => {
    historyHydrationPromise = null;
  });
}
async function hydratePortfolioHistory({ force = false } = {}) {
  if (!cloudDeployment || (!force && historyHydrated && Array.isArray(portfolio?.history) && portfolio.history.length)) return portfolio;
  if (historyHydrationPromise) return historyHydrationPromise;
  historyHydrationPromise = (async () => {
    const history = await fetchPortfolioHistory();
    const hydrated = { ...(portfolio || {}), history };
    historyHydrated = true;
    if (localPortfolioMode && localProfileToken) writeLocalPortfolio(hydrated);
    render(hydrated);
    return hydrated;
  })().finally(() => { historyHydrationPromise = null; });
  return historyHydrationPromise;
}
async function writeProfilePortfolio(data) {
  if (!localProfileToken) return data;
  return enqueueProfileOperation(async () => {
    let outgoing = {
      ...portfolioSavePayload(data),
      _profileRevision: Number(portfolio?._profileRevision ?? data?._profileRevision ?? 0)
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch(profileApiUrl('/api/profile-portfolio'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(outgoing)
      });
      const result = await response.json();
      if (response.ok && !result.error) return result.portfolio;
      if (response.status === 409 && result.portfolio && attempt === 0) {
        outgoing = { ...outgoing, _profileRevision: Number(result.portfolio._profileRevision || 0) };
        continue;
      }
      const error = new Error(result.error || '朋友持仓备份失败');
      error.remotePortfolio = result.portfolio;
      throw error;
    }
    throw new Error('朋友持仓备份失败');
  });
}
const yen = new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY', maximumFractionDigits: 0 });
const number = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 2 });
const preciseNumber = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 6 });
const sign = value => value > 0 ? '+' : '';
const color = value => value > 0 ? 'up' : value < 0 ? 'down' : 'neutral';
const todayInTokyo = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
const quoteProfitDayIsWeekend = item => {
  const dateText = String(item?.quote?.profitDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText)) return false;
  const weekday = new Date(`${dateText}T12:00:00Z`).getUTCDay();
  return weekday === 0 || weekday === 6;
};
const hasDailyQuote = item => Number.isFinite(Number(item.quote?.price))
  && Number.isFinite(Number(item.quote?.previousClose))
  && !quoteProfitDayIsWeekend(item);
const productType = item => item.name === '黄金' ? '黄金' : item.name === '预存款与现金' ? '现金' : item.symbol?.endsWith('.T') ? '日股' : !item.symbol && item.market === 'JP' ? '基金' : '美股';
function normalizeAccountType(value) {
  const text = String(value || '').normalize('NFKC').trim();
  if (!text || text === '未设置') return '未设置';
  if (/NISA/i.test(text)) return 'NISA';
  if (text.includes('特定')) return '特定';
  if (text === '一般' || text.includes('持股会') || text.includes('持株会')) return '一般';
  if (text === '金' || text.includes('黄金')) return '黄金';
  return text;
}
const accountType = item => normalizeAccountType(item.account);
const ledgerText = value => String(value || '').normalize('NFKC').trim().replace(/[\s\u200b-\u200d\ufeff]+/g, '').toUpperCase();
function ledgerHash(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
const ledgerUuid = prefix => `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
const accountLedgerId = account => `account-${ledgerHash(normalizeAccountType(account))}`;
const instrumentLedgerId = item => item.instrumentId || (item.symbol
  ? `instrument-${ledgerHash(`${String(item.market || '').toUpperCase()}:${String(item.symbol).toUpperCase()}`)}`
  : `instrument-${ledgerHash(`${String(item.market || '').toUpperCase()}:${ledgerText(item.name)}`)}`);
function normalizePortfolioLedger(data) {
  data.holdings = Array.isArray(data.holdings) ? data.holdings : [];
  data.transactions = Array.isArray(data.transactions) ? data.transactions : [];
  data.importBatches = Array.isArray(data.importBatches) ? data.importBatches : [];
  data.positionAdjustments = Array.isArray(data.positionAdjustments) ? data.positionAdjustments : [];
  data.holdings.forEach(item => {
    item.name = canonicalImportedName(item.name);
    item.id ||= ledgerUuid('position');
    item.accountId ||= accountLedgerId(item.account);
    item.instrumentId ||= instrumentLedgerId(item);
  });
  data.transactions.forEach(transaction => {
    if (transaction.holdingId) return;
    const matches = data.holdings.filter(item => {
      const symbolMatches = transaction.symbol && item.symbol && ledgerText(transaction.symbol) === ledgerText(item.symbol);
      const nameMatches = ledgerText(transaction.name) === ledgerText(item.name);
      const accountMatches = !transaction.account || normalizeAccountType(transaction.account) === normalizeAccountType(item.account);
      return accountMatches && (symbolMatches || nameMatches);
    });
    if (matches.length === 1) {
      transaction.holdingId = matches[0].id;
      transaction.instrumentId ||= matches[0].instrumentId;
      transaction.accountId ||= matches[0].accountId;
    }
  });
  return data;
}
const activeHoldings = () => (portfolio?.holdings || []).filter(item => !item.archived);
const holdingTransactions = item => (portfolio?.transactions || []).filter(transaction => transaction.holdingId === item.id || (!transaction.holdingId && transaction.name === item.name));
const transactionDay = transaction => String(transaction.timestamp || '').slice(0, 10);
function effectiveTransactionDay(transaction, item) {
  const day = transactionDay(transaction);
  if (!day || item.market !== 'US' || !item.symbol) return day;
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}
const smbcFundNames = new Set([
  'SMBC・DCインデックスファンド(日経225)',
  'SMBC・DCインデックスファンド(MSCIコクサイ)',
  'SMBC・DCインデックスファンド(S&P500)',
  '225',
  '全球',
  '500'
]);
const normalizedFundName = value => String(value || '').normalize('NFKC').replace(/[\s\u200b-\u200d\ufeff]/g, '').replace(/·/g, '・');
function recognizedSmbcFundName(value) {
  const normalized = normalizedFundName(value);
  if (smbcFundNames.has(normalized)) return true;
  const upper = normalized.toUpperCase();
  if (!upper.includes('SMBC') && !normalized.includes('三井住友')) return false;
  return upper.includes('日経225') || upper.includes('MSCIコクサイ') || upper.includes('MSCI国際') || upper.includes('S&P500') || upper.includes('SP500');
}
const unitScale = item => item.fundId || item.smbcFundCode || ['FANG+（iFreeNEXT）', 'eMAXIS Slim S&P500'].includes(item.name) || recognizedSmbcFundName(item.name) ? 10000 : 1;
const usesUsdQuote = item => item?.quote?.currency === 'USD' || (
  item?.market === 'US'
  && Boolean(item?.symbol)
  && !item?.fundId
  && item?.quoteSource !== 'internationalGold'
);
function transactionAdjustedDailyProfit(item, currentUnitValue, previousUnitValue, units) {
  const profitDate = item.quote?.profitDate || todayInTokyo();
  const transactions = holdingTransactions(item).filter(transaction => effectiveTransactionDay(transaction, item) === profitDate);
  if (!transactions.length) return units * (currentUnitValue - previousUnitValue);
  const bought = transactions.filter(item => item.type === 'BUY').reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  const sold = transactions.filter(item => item.type === 'SELL').reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  const openingUnits = Math.max(units - bought + sold, 0);
  let profit = Math.max(openingUnits - sold, 0) * (currentUnitValue - previousUnitValue);
  for (const transaction of transactions) {
    const quantity = Number(transaction.quantity || 0);
    const tradeUnitValue = Number(transaction.price || 0) * Number(transaction.exchangeRate || 1) / Number(transaction.unitScale || 1);
    const fee = Number(transaction.fee || 0);
    profit += transaction.type === 'BUY'
      ? quantity * (currentUnitValue - tradeUnitValue) - fee
      : quantity * (tradeUnitValue - previousUnitValue) - fee;
  }
  return profit;
}
function metrics(item) {
  const quote = item.quote;
  const units = Number(item.units);
  const buyPrice = Number(item.buyPrice ?? item.avgCost);
  if (!quote || !Number.isFinite(units) || !Number.isFinite(buyPrice) || units <= 0) {
    let dailyJPY = null;
    if (quote?.previousClose && hasDailyQuote(item)) dailyJPY = item.valueJPY * (quote.price / quote.previousClose - 1);
    return {
      valueJPY: item.valueJPY,
      costJPY: item.valueJPY - item.profitJPY,
      profitJPY: item.profitJPY,
      profitPct: item.profitPct,
      dailyJPY,
      exact: false
    };
  }
  const divisor = unitScale(item);
  let valueJPY, costJPY, previousJPY;
  if (usesUsdQuote(item)) {
    const fx = portfolio.fx?.USDJPY;
    if (!fx?.price) return { valueJPY: item.valueJPY, costJPY: item.valueJPY - item.profitJPY, profitJPY: item.profitJPY, profitPct: item.profitPct, dailyJPY: null, exact: false };
    valueJPY = quote.price * units * fx.price;
    costJPY = buyPrice * units;
    const currentUnitValue = quote.price * fx.price;
    const previousUnitValue = quote.previousClose * (fx.previousClose || fx.price);
    previousJPY = previousUnitValue * units;
    valueJPY = currentUnitValue * units;
    costJPY = buyPrice * units;
    const profitJPY = valueJPY - costJPY;
    return { valueJPY, costJPY, profitJPY, profitPct: costJPY ? profitJPY / costJPY * 100 : 0, dailyJPY: previousJPY && hasDailyQuote(item) ? transactionAdjustedDailyProfit(item, currentUnitValue, previousUnitValue, units) : null, exact: true };
  } else {
    valueJPY = quote.price * units / divisor;
    costJPY = buyPrice * units / divisor;
    previousJPY = quote.previousClose * units / divisor;
  }
  const profitJPY = valueJPY - costJPY;
  return { valueJPY, costJPY, profitJPY, profitPct: costJPY ? profitJPY / costJPY * 100 : 0, dailyJPY: previousJPY && hasDailyQuote(item) ? transactionAdjustedDailyProfit(item, quote.price / divisor, quote.previousClose / divisor, units) : null, exact: true };
}
const group = (items, key) => items.reduce((result, item) => { const name = key(item); result[name] = (result[name] || 0) + metrics(item).valueJPY; return result; }, {});
const shortLabel = (label, limit = 10) => label.length > limit ? `${label.slice(0, Math.max(1, limit - 1))}…` : label;
const labelPlugin = {
  id: 'labels',
  afterDatasetsDraw(chart) {
    const data = chart.data.datasets[0].data;
    const total = data.reduce((sum, value) => sum + value, 0);
    if (!total) return;
    const { ctx } = chart;
    const compact = chart.width <= 420;
    const external = { left: [], right: [] };
    chart.getDatasetMeta(0).data.forEach((arc, index) => {
      const ratio = data[index] / total;
      const label = chart.data.labels[index];
      const angle = (arc.startAngle + arc.endAngle) / 2;
      if (ratio >= .07) {
        const point = arc.tooltipPosition();
        const fontSize = compact && ratio < .12 ? 11 : 13;
        ctx.save();
        ctx.fillStyle = usesIbkrTheme() ? '#f6f7fb' : '#17201d';
        ctx.textAlign = 'center';
        ctx.font = `600 ${fontSize}px -apple-system, sans-serif`;
        ctx.fillText(`${(ratio * 100).toFixed(1)}%`, point.x, point.y - 7);
        ctx.font = `500 ${Math.max(10, fontSize - 1)}px -apple-system, sans-serif`;
        ctx.fillText(shortLabel(label, compact ? 8 : 10), point.x, point.y + 9);
        ctx.restore();
        return;
      }
      const side = Math.cos(angle) >= 0 ? 'right' : 'left';
      external[side].push({ arc, angle, index, label, ratio, y: arc.y + Math.sin(angle) * (arc.outerRadius + 14) });
    });
    Object.entries(external).forEach(([side, labels]) => {
      if (!labels.length) return;
      const gap = compact ? 24 : 28;
      const minY = compact ? 16 : 18;
      const maxY = chart.height - minY;
      labels.sort((left, right) => left.y - right.y);
      labels.forEach((item, index) => {
        item.y = Math.max(minY, Math.min(maxY, item.y));
        if (index) item.y = Math.max(item.y, labels[index - 1].y + gap);
      });
      for (let index = labels.length - 2; index >= 0; index -= 1) {
        labels[index].y = Math.min(labels[index].y, labels[index + 1].y - gap);
      }
      if (labels[0].y < minY) {
        const shift = minY - labels[0].y;
        labels.forEach(item => { item.y += shift; });
      }
      if (labels.at(-1).y > maxY) {
        const shift = labels.at(-1).y - maxY;
        labels.forEach(item => { item.y -= shift; });
      }
      labels.forEach(item => {
        const direction = side === 'right' ? 1 : -1;
        const startX = item.arc.x + Math.cos(item.angle) * item.arc.outerRadius;
        const startY = item.arc.y + Math.sin(item.angle) * item.arc.outerRadius;
        const elbowX = item.arc.x + direction * (item.arc.outerRadius + (compact ? 7 : 11));
        const textX = side === 'right' ? chart.width - 5 : 5;
        const lineEndX = side === 'right' ? textX - 4 : textX + 4;
        const stroke = chart.data.datasets[0].backgroundColor[item.index];
        ctx.save();
        ctx.strokeStyle = stroke;
        ctx.lineWidth = compact ? 1.2 : 1.4;
        ctx.beginPath();
        ctx.moveTo(startX, startY);
        ctx.lineTo(elbowX, item.y);
        ctx.lineTo(lineEndX, item.y);
        ctx.stroke();
        ctx.fillStyle = usesIbkrTheme() ? '#f6f7fb' : '#17201d';
        ctx.textAlign = side === 'right' ? 'right' : 'left';
        ctx.font = `650 ${compact ? 10 : 11}px -apple-system, sans-serif`;
        ctx.fillText(`${(item.ratio * 100).toFixed(1)}%`, textX, item.y - 2);
        ctx.font = `500 ${compact ? 9 : 10}px -apple-system, sans-serif`;
        ctx.fillText(shortLabel(item.label, compact ? 7 : 9), textX, item.y + 10);
        ctx.restore();
      });
    });
  }
};
function dailyPercent(item) {
  const quote = item.quote;
  if (!hasDailyQuote(item)) return null;
  const officialChangePct = Number(quote?.changePct);
  if (Number.isFinite(officialChangePct)) return officialChangePct;
  return quote?.previousClose ? (quote.price - quote.previousClose) / quote.previousClose * 100 : null;
}
function selectedHoldings() {
  return activeHoldings().filter(item =>
    (accountFilter === '全部' || accountType(item) === accountFilter)
    && (productFilter === '全部' || productType(item) === productFilter)
  );
}
function selectedHistoricalHoldingNames() {
  const names = new Set();
  const matches = (account, product) =>
    (accountFilter === '全部' || account === accountFilter)
    && (productFilter === '全部' || product === productFilter);
  for (const holding of portfolio.holdings || []) {
    if (matches(accountType(holding), productType(holding))) names.add(holding.name);
  }
  for (const transaction of portfolio.transactions || []) {
    if (matches(normalizeAccountType(transaction.account), transaction.product || '未设置')) names.add(transaction.name);
  }
  for (const trade of realizedTrades()) {
    if (matches(normalizeAccountType(trade.account), trade.product || '未设置')) names.add(trade.name);
  }
  return names;
}
function historicalHoldingKey(value) {
  const text = String(typeof value === 'string' ? value : value?.name || '')
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .toUpperCase();
  if (text === '225' || text.includes('日経225')) return 'SMBC:182709';
  if (text === '全球' || (text.includes('MSCI') && text.includes('コクサイ'))) return 'SMBC:182909';
  if (text === '500' || text.includes('S&P500')) return 'SMBC:182809';
  return text;
}
function orderedFilters(values, preferred) {
  return ['全部', ...preferred.filter(value => values.has(value)), ...[...values].filter(value => !preferred.includes(value)).sort()];
}
function availableFilterOptions() {
  const previousAccountFilter = accountFilter;
  const previousProductFilter = productFilter;
  const accounts = new Set(activeHoldings().map(accountType));
  const accountOptions = orderedFilters(accounts, ['NISA', '特定', '一般', '黄金', '未设置']);
  if (!accountOptions.includes(accountFilter)) accountFilter = '全部';
  const accountHoldings = activeHoldings().filter(item => accountFilter === '全部' || accountType(item) === accountFilter);
  const products = new Set(accountHoldings.map(productType));
  const productOptions = orderedFilters(products, ['美股', '基金', '日股', '黄金', '现金']);
  if (!productOptions.includes(productFilter)) productFilter = '全部';
  if (previousAccountFilter !== accountFilter || previousProductFilter !== productFilter) saveViewPreferences();
  return { accountOptions, productOptions };
}
function renderFilterControls(accountSelector, productSelector) {
  const { accountOptions, productOptions } = availableFilterOptions();
  const accountSelect = document.querySelector(accountSelector);
  const productContainer = document.querySelector(productSelector);
  if (!accountSelect || !productContainer) return;
  accountSelect.innerHTML = accountOptions.map(value => `<option value="${value}">${value === '全部' ? '全部口座' : value}</option>`).join('');
  accountSelect.value = accountFilter;
  productContainer.innerHTML = productOptions.map(value => `<button class="${value === productFilter ? 'selected' : ''}" data-product-filter="${value}">${value}</button>`).join('');
  accountSelect.onchange = () => {
    accountFilter = accountSelect.value;
    if (accountFilter === '全部') {
      productFilter = '全部';
    } else {
      const availableProducts = new Set(activeHoldings()
        .filter(item => accountType(item) === accountFilter)
        .map(productType));
      productFilter = ['美股', '基金', '日股', '黄金', '现金'].find(type => availableProducts.has(type)) || '全部';
    }
    saveViewPreferences();
    renderFilteredViews();
  };
  productContainer.querySelectorAll('[data-product-filter]').forEach(button => button.addEventListener('click', () => {
    productFilter = button.dataset.productFilter;
    saveViewPreferences();
    renderFilteredViews();
  }));
}
function renderFilters() {
  renderFilterControls('#allocation-account-select', '#allocation-filter');
}
const performanceDayMilliseconds = 86400000;
function rawHistoryPoint(record) {
  const totalAssets = Number(record.totalNetAsset ?? record.totalAssetsJPY);
  const hasPortfolioTotals = Number.isFinite(totalAssets)
    && (record.dailyProfitJPY !== undefined || record.netExternalCashFlowJPY !== undefined);
  if (hasPortfolioTotals) {
    return {
      dailyProfitJPY: record.dailyProfitJPY,
      totalAssetsJPY: totalAssets,
      totalNetAsset: totalAssets,
      netExternalCashFlowJPY: record.netExternalCashFlowJPY,
      weightedExternalCashFlowJPY: record.weightedExternalCashFlowJPY,
      dailyFxImpactJPY: record.dailyFxImpactJPY,
      dailyProfitRate: record.dailyProfitRate,
      dailyReturnRate: record.dailyReturnRate
    };
  }
  const holdingPoints = Object.values(record.breakdown?.holding || {});
  if (holdingPoints.length) return aggregateReturnPoints(holdingPoints);
  return {
    dailyProfitJPY: record.dailyProfitJPY,
    totalAssetsJPY: record.totalAssetsJPY,
    totalNetAsset: record.totalNetAsset,
    netExternalCashFlowJPY: record.netExternalCashFlowJPY,
    weightedExternalCashFlowJPY: record.weightedExternalCashFlowJPY,
    dailyFxImpactJPY: record.dailyFxImpactJPY,
    dailyProfitRate: record.dailyProfitRate,
    dailyReturnRate: record.dailyReturnRate
  };
}
function historyPointReturnBase(point) {
  const profit = Number(point.dailyProfitJPY || 0);
  const rateValue = point.dailyReturnRate;
  const rate = rateValue === null || rateValue === undefined ? null : Number(rateValue);
  if (Number.isFinite(rate) && Math.abs(rate) > 1e-12) {
    const inferredBase = profit / rate;
    if (Number.isFinite(inferredBase) && inferredBase > 0) return inferredBase;
  }
  const closingValue = Number(point.totalNetAsset ?? point.totalAssetsJPY ?? 0);
  const cashFlow = Number(point.netExternalCashFlowJPY || 0);
  const weightedFlow = Number(point.weightedExternalCashFlowJPY || 0);
  const fallbackBase = closingValue - profit - cashFlow + weightedFlow;
  return Number.isFinite(fallbackBase) && fallbackBase > 0 ? fallbackBase : 0;
}
function aggregateReturnPoints(points) {
  const total = points.reduce((result, point) => {
    result.dailyProfitJPY += Number(point.dailyProfitJPY || 0);
    result.dailyFxImpactJPY += Number(point.dailyFxImpactJPY || 0);
    result.totalAssetsJPY += Number(point.totalAssetsJPY || 0);
    result.totalNetAsset += Number(point.totalNetAsset ?? point.totalAssetsJPY ?? 0);
    result.netExternalCashFlowJPY += Number(point.netExternalCashFlowJPY || 0);
    result.weightedExternalCashFlowJPY += Number(point.weightedExternalCashFlowJPY || 0);
    result.returnBase += historyPointReturnBase(point);
    return result;
  }, { dailyProfitJPY: 0, dailyFxImpactJPY: 0, totalAssetsJPY: 0, totalNetAsset: 0, netExternalCashFlowJPY: 0, weightedExternalCashFlowJPY: 0, returnBase: 0 });
  total.dailyReturnRate = total.returnBase > 0 ? total.dailyProfitJPY / total.returnBase : null;
  return total;
}
function historyPointDailyReturn(point) {
  if (point.dailyReturnRate !== null && point.dailyReturnRate !== undefined) {
    const storedReturn = Number(point.dailyReturnRate);
    if (Number.isFinite(storedReturn) && 1 + storedReturn > 0) return storedReturn;
  }
  const returnBase = historyPointReturnBase(point);
  const dailyReturn = returnBase > 0 ? Number(point.dailyProfitJPY || 0) / returnBase : null;
  return Number.isFinite(dailyReturn) && 1 + dailyReturn > 0 ? dailyReturn : null;
}
function groupedCashFlows(cashFlows) {
  const grouped = new Map();
  for (const cashFlow of cashFlows) {
    const amount = Number(cashFlow.amount || 0);
    if (!cashFlow.date || !Number.isFinite(amount) || Math.abs(amount) < 0.005) continue;
    grouped.set(cashFlow.date, (grouped.get(cashFlow.date) || 0) + amount);
  }
  return [...grouped.entries()]
    .map(([date, amount]) => ({ date, amount }))
    .filter(cashFlow => Math.abs(cashFlow.amount) >= 0.005)
    .sort((left, right) => left.date.localeCompare(right.date));
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
    if (lowerValue * middleValue <= 0) {
      upper = middle;
      upperValue = middleValue;
    } else {
      lower = middle;
      lowerValue = middleValue;
    }
  }
  return (lower + upper) / 2;
}
function moneyWeightedPerformance(records, options = {}) {
  const pointForRecord = options.pointForRecord || rawHistoryPoint;
  const points = records.map(record => ({ record, point: pointForRecord(record) })).filter(({ point }) => point);
  if (!points.length) return { annualizedRate: null, periodReturnPct: null, startDate: null, endDate: null, openingAssets: 0, endingAssets: 0, netContributions: 0, profit: 0 };
  const first = points[0];
  const last = points.at(-1);
  const inferredOpening = Math.max(0, Number(first.point.totalNetAsset ?? first.point.totalAssetsJPY ?? 0)
    - Number(first.point.dailyProfitJPY || 0) - Number(first.point.netExternalCashFlowJPY || 0));
  const openingAssets = Math.max(0, Number(options.openingAssets ?? inferredOpening));
  const endingAssets = Math.max(0, Number(options.endingAssets ?? last.point.totalNetAsset ?? last.point.totalAssetsJPY ?? 0));
  const cashFlows = [];
  if (openingAssets > 0) cashFlows.push({ date: first.record.date, amount: -openingAssets });
  let netContributions = openingAssets;
  for (const { record, point } of points) {
    const contribution = Number(point.netExternalCashFlowJPY || 0);
    netContributions += contribution;
    if (contribution) cashFlows.push({ date: record.date, amount: -contribution });
  }
  cashFlows.push({ date: last.record.date, amount: endingAssets });
  const normalizedFlows = groupedCashFlows(cashFlows);
  const annualized = xirr(normalizedFlows);
  const startDate = normalizedFlows[0]?.date || first.record.date;
  const endDate = last.record.date;
  const elapsedDays = Math.max(0, (new Date(`${endDate}T12:00:00Z`) - new Date(`${startDate}T12:00:00Z`)) / performanceDayMilliseconds);
  const annualizedRate = annualized === null || (options.minimumAnnualizationDays || 0) > elapsedDays ? null : annualized * 100;
  const periodReturnPct = annualized === null ? null : ((1 + annualized) ** (elapsedDays / 365.2425) - 1) * 100;
  return {
    annualizedRate,
    periodReturnPct,
    startDate,
    endDate,
    openingAssets,
    endingAssets,
    netContributions,
    profit: endingAssets - netContributions
  };
}
function portfolioMoneyWeightedPerformance(useCurrentFilters = true, endingAssets = null) {
  const pointForRecord = useCurrentFilters ? selectedHistoryPoint : rawHistoryPoint;
  const allPortfolio = !useCurrentFilters || (accountFilter === '全部' && productFilter === '全部');
  return moneyWeightedPerformance(portfolio.history || [], {
    pointForRecord,
    openingAssets: allPortfolio ? 0 : undefined,
    endingAssets,
    minimumAnnualizationDays: 180
  });
}
function timeWeightedPerformance(records, options = {}) {
  const pointForRecord = options.pointForRecord || rawHistoryPoint;
  let growth = 1;
  let observations = 0;
  let startDate = null;
  let endDate = null;
  let endingAssets = 0;
  let profit = 0;
  for (const record of records) {
    const point = pointForRecord(record);
    if (!point) continue;
    const dailyProfit = Number(point.dailyProfitJPY || 0);
    const closingValue = Number(point.totalNetAsset ?? point.totalAssetsJPY ?? 0);
    const dailyReturn = historyPointDailyReturn(point);
    profit += dailyProfit;
    endingAssets = closingValue;
    if (dailyReturn === null || !Number.isFinite(dailyReturn) || 1 + dailyReturn <= 0) continue;
    growth *= 1 + dailyReturn;
    observations += 1;
    startDate ||= record.date;
    endDate = record.date;
  }
  if (Number.isFinite(Number(options.endingAssets))) endingAssets = Number(options.endingAssets);
  if (!observations || !startDate || !endDate) {
    return { annualizedRate: null, periodReturnPct: null, startDate: null, endDate: null, endingAssets, profit };
  }
  const elapsedDays = Math.max(0, (new Date(`${endDate}T12:00:00Z`) - new Date(`${startDate}T12:00:00Z`)) / performanceDayMilliseconds);
  const periodReturnPct = (growth - 1) * 100;
  const minimumDays = Number(options.minimumAnnualizationDays || 0);
  const annualizedRate = elapsedDays >= minimumDays && elapsedDays > 0 && growth > 0
    ? (growth ** (365.2425 / elapsedDays) - 1) * 100
    : null;
  return { annualizedRate, periodReturnPct, startDate, endDate, endingAssets, profit };
}
function portfolioTimeWeightedPerformance(useCurrentFilters = true, endingAssets = null) {
  return timeWeightedPerformance(portfolio.history || [], {
    pointForRecord: useCurrentFilters ? selectedHistoryPoint : rawHistoryPoint,
    endingAssets,
    minimumAnnualizationDays: 180
  });
}
function estimatedAnnualizedFromAccountStart(total, cost) {
  const startDate = portfolio.accountStartDate;
  if (!startDate || !Number.isFinite(total) || !Number.isFinite(cost) || total <= 0 || cost <= 0) return null;
  const elapsedDays = Math.max(0, (new Date(`${todayInTokyo()}T12:00:00Z`) - new Date(`${startDate}T12:00:00Z`)) / performanceDayMilliseconds);
  if (elapsedDays < 180) return null;
  const annualizedRate = ((total / cost) ** (365.2425 / elapsedDays) - 1) * 100;
  return Number.isFinite(annualizedRate) ? { annualizedRate, startDate } : null;
}
function historyMetricsReady() {
  return !cloudDeployment || historyHydrated || (Array.isArray(portfolio?.history) && portfolio.history.length > 3);
}
function latestSummaryProfit() {
  const fallback = selectedHoldings().reduce((sum, holding) => {
    const dailyProfit = Number(metrics(holding).dailyJPY);
    return Number.isFinite(dailyProfit) ? sum + dailyProfit : sum;
  }, 0);
  const records = new Map((portfolio?.history || [])
    .filter(record => record?.date && record.date <= todayInTokyo())
    .map(record => [record.date, record]));
  liveCalendarRecords().forEach((record, dateText) => {
    if (dateText <= todayInTokyo()) records.set(dateText, record);
  });
  const latestRecord = [...records.values()]
    .sort((left, right) => String(left.date).localeCompare(String(right.date)))
    .at(-1);
  if (!latestRecord) return fallback;
  const point = accountFilter === '全部' && productFilter === '全部'
    ? rawHistoryPoint(latestRecord)
    : selectedHistoryPoint(latestRecord);
  const recordedProfit = Number(point?.dailyProfitJPY);
  return Number.isFinite(recordedProfit) ? recordedProfit : fallback;
}
function renderSummary() {
  const values = selectedHoldings().map(metrics);
  const total = values.reduce((sum, item) => sum + item.valueJPY, 0);
  const profit = values.reduce((sum, item) => sum + item.profitJPY, 0);
  const cost = total - profit;
  const dailyProfit = latestSummaryProfit();
  const historyReady = historyMetricsReady();
  const annualizedPerformance = historyReady
    ? portfolioTimeWeightedPerformance(true, total)
    : { annualizedRate: null, startDate: null };
  const annualizedValue = annualizedPerformance.annualizedRate;
  const annualized = annualizedValue === null ? null : annualizedValue.toFixed(2);
  const annualizedStartDate = annualizedPerformance.startDate || portfolio.accountStartDate;
  const profitPct = cost ? profit / cost * 100 : 0;
  document.querySelector('#total').textContent = yen.format(total);
  document.querySelector('#principal').innerHTML = `投入本金：<span class="summary-value">${yen.format(cost)}</span>`;
  document.querySelector('#annualized').innerHTML = !historyReady
    ? '年化率：读取中…'
    : annualized
    ? `年化率：<span class="summary-value ${color(Number(annualized))}">${annualized}%</span>（自 ${annualizedStartDate}）`
    : '年化率：—（持有期不足半年）';
  document.querySelector('#profit').textContent = `${sign(profit)}${yen.format(profit)}`;
  document.querySelector('#profit').className = color(profit);
  document.querySelector('#profit-pct').textContent = `${sign(profitPct)}${profitPct.toFixed(2)}%`;
  document.querySelector('#profit-pct').className = color(profitPct);
  document.querySelector('#daily-profit').textContent = `${sign(dailyProfit)}${yen.format(dailyProfit)}`;
  document.querySelector('#daily-profit').className = color(dailyProfit);
  renderOverviewPrivacy();
}
function selectedHistoryPoint(item) {
  if (accountFilter === '全部' && productFilter === '全部') return rawHistoryPoint(item);
  const selected = selectedHoldings();
  const latestRecord = (portfolio.history || []).at(-1);
  const currentValues = selected.reduce((values, holding) => {
    const key = historicalHoldingKey(holding);
    values.set(key, (values.get(key) || 0) + metrics(holding).valueJPY);
    return values;
  }, new Map());
  const latestValues = Object.entries(latestRecord?.breakdown?.holding || {}).reduce((values, [name, point]) => {
    const key = historicalHoldingKey(name);
    values.set(key, (values.get(key) || 0) + Number(point.totalAssetsJPY || 0));
    return values;
  }, new Map());
  const points = Object.entries(item.breakdown?.holding || {})
    .filter(([name]) => currentValues.has(historicalHoldingKey(name)))
    .map(([name, point]) => {
      const key = historicalHoldingKey(name);
      const historicalValue = Number(latestValues.get(key) || 0);
      const scale = historicalValue > 0 ? currentValues.get(key) / historicalValue : 1;
      return {
        ...Object.fromEntries(Object.entries(point)
          .filter(([field]) => field !== 'dailyReturnRate' && field !== 'cumulativeReturnRate')
          .map(([field, value]) => [field, Number(value || 0) * scale])),
        dailyReturnRate: point.dailyReturnRate,
        cumulativeReturnRate: point.cumulativeReturnRate
      };
    });
  if (!points.length) return null;
  return aggregateReturnPoints(points);
}
function aggregateHistory() {
  const history = portfolio.history || [];
  const buckets = {};
  const benchmarkTotals = Object.fromEntries(Object.keys(benchmarkDefinitions).map(id => [id, null]));
  for (const item of history) {
    const selected = selectedHistoryPoint(item);
    if (!selected) continue;
    const cashFlow = Number(selected.netExternalCashFlowJPY || 0);
    const weightedFlow = Number(selected.weightedExternalCashFlowJPY || 0);
    const date = new Date(`${item.date}T00:00:00`);
    const monday = new Date(date);
    monday.setDate(date.getDate() - ((date.getDay() + 6) % 7));
    const key = trendMode === 'day' ? item.date : trendMode === 'month' ? item.date.slice(0, 7) : monday.toISOString().slice(0, 10);
    const bucket = buckets[key] || { profit: 0, total: null, benchmarks: {} };
    bucket.profit += selected.dailyProfitJPY || 0;
    if (selected.totalAssetsJPY) bucket.total = selected.totalAssetsJPY;
    for (const id of Object.keys(benchmarkDefinitions)) {
      if (benchmarkTotals[id] === null) {
        benchmarkTotals[id] = Math.max(0, Number(selected.totalAssetsJPY || 0) - Number(selected.dailyProfitJPY || 0) - cashFlow);
      }
      const benchmarkReturn = Number(item.benchmarkReturns?.[id] ?? (id === 'sp500' ? item.sp500Return : 0) ?? 0);
      const benchmarkProfit = (benchmarkTotals[id] + weightedFlow) * benchmarkReturn;
      benchmarkTotals[id] += cashFlow + benchmarkProfit;
      const benchmark = bucket.benchmarks[id] || { profit: 0, total: null };
      benchmark.profit += benchmarkProfit;
      benchmark.total = benchmarkTotals[id];
      bucket.benchmarks[id] = benchmark;
    }
    buckets[key] = bucket;
  }
  return buckets;
}
function currentPortfolioLabel() {
  const labels = [accountFilter, productFilter].filter(value => value !== '全部');
  return labels.length ? labels.join(' · ') : '全部持仓';
}
function currentPeriodRecords() {
  if (trendView === 'all') return portfolio.history || [];
  const year = reportDate.getFullYear();
  const month = String(reportDate.getMonth() + 1).padStart(2, '0');
  const prefix = trendView === 'month' ? `${year}-${month}` : `${year}-`;
  return (portfolio.history || []).filter(item => item.date.startsWith(prefix));
}
function periodPerformanceOptions(records) {
  const allPortfolio = accountFilter === '全部' && productFilter === '全部';
  const latestRecord = records.at(-1);
  const now = new Date();
  const currentYear = now.getFullYear();
  const reportYear = reportDate.getFullYear();
  const currentMonth = reportYear === currentYear && reportDate.getMonth() === now.getMonth();
  const options = { pointForRecord: selectedHistoryPoint };
  if (trendView === 'all' && allPortfolio) options.openingAssets = 0;
  if (trendView === 'year' && allPortfolio) {
    options.openingAssets = Number(portfolio.annualAssetAnchorsJPY?.[String(reportYear - 1)] || 0);
    const anchoredEnding = Number(portfolio.annualAssetAnchorsJPY?.[String(reportYear)]);
    if (Number.isFinite(anchoredEnding) && anchoredEnding > 0) options.endingAssets = anchoredEnding;
  }
  const currentPeriod = trendView === 'all' || (trendView === 'year' && reportYear === currentYear) || (trendView === 'month' && currentMonth);
  if (currentPeriod && latestRecord) options.endingAssets = selectedHoldings().map(metrics).reduce((sum, item) => sum + item.valueJPY, 0);
  return options;
}
function benchmarkMoneyWeightedPerformance(records, benchmarkId, options) {
  const pointForRecord = options.pointForRecord || selectedHistoryPoint;
  const points = records.map(record => ({ record, point: pointForRecord(record) })).filter(({ point }) => point);
  if (!points.length) return { periodReturnPct: null, annualizedRate: null, endingAssets: 0 };
  const first = points[0];
  const inferredOpening = Math.max(0, Number(first.point.totalNetAsset ?? first.point.totalAssetsJPY ?? 0)
    - Number(first.point.dailyProfitJPY || 0) - Number(first.point.netExternalCashFlowJPY || 0));
  const openingAssets = Math.max(0, Number(options.openingAssets ?? inferredOpening));
  let benchmarkAssets = openingAssets;
  const cashFlows = openingAssets > 0 ? [{ date: first.record.date, amount: -openingAssets }] : [];
  for (const { record, point } of points) {
    const contribution = Number(point.netExternalCashFlowJPY || 0);
    const weightedContribution = Number(point.weightedExternalCashFlowJPY || 0);
    const benchmarkReturn = Number(record.benchmarkReturns?.[benchmarkId] ?? (benchmarkId === 'sp500' ? record.sp500Return : 0) ?? 0);
    benchmarkAssets += contribution + (benchmarkAssets + weightedContribution) * benchmarkReturn;
    if (contribution) cashFlows.push({ date: record.date, amount: -contribution });
  }
  benchmarkAssets = Math.max(0, benchmarkAssets);
  const endDate = points.at(-1).record.date;
  cashFlows.push({ date: endDate, amount: benchmarkAssets });
  const normalizedFlows = groupedCashFlows(cashFlows);
  const annualized = xirr(normalizedFlows);
  const startDate = normalizedFlows[0]?.date || first.record.date;
  const elapsedDays = Math.max(0, (new Date(`${endDate}T12:00:00Z`) - new Date(`${startDate}T12:00:00Z`)) / performanceDayMilliseconds);
  return {
    annualizedRate: annualized === null ? null : annualized * 100,
    periodReturnPct: annualized === null ? null : ((1 + annualized) ** (elapsedDays / 365.2425) - 1) * 100,
    endingAssets: benchmarkAssets
  };
}
function periodPerformance(records) {
  let fxImpact = 0;
  let profit = 0;
  let endingAssets = 0;
  let growth = 1;
  let returnObservations = 0;
  const benchmarkGrowth = Object.fromEntries(Object.keys(benchmarkDefinitions).map(id => [id, 1]));
  let peak = 1;
  let maximumDrawdown = 0;
  let bestDay = null;
  let worstDay = null;
  const dailyObservations = [];
  const monthProfits = new Map();
  let winStreak = 0;
  let lossStreak = 0;
  let longestWinStreak = 0;
  let longestLossStreak = 0;
  for (const record of records) {
    const point = selectedHistoryPoint(record);
    if (!point) continue;
    const dailyProfit = Number(point.dailyProfitJPY || 0);
    const closingValue = Number(point.totalNetAsset ?? point.totalAssetsJPY ?? 0);
    const dailyReturn = historyPointDailyReturn(point) ?? 0;
    const benchmarkReturn = Number(record.benchmarkReturns?.[benchmarkSettings.primary] ?? (benchmarkSettings.primary === 'sp500' ? record.sp500Return : 0) ?? 0);
    profit += dailyProfit;
    endingAssets = closingValue;
    fxImpact += Number(point.dailyFxImpactJPY || 0);
    if (Math.abs(dailyProfit) > 0.5) {
      const day = { date: record.date, profit: dailyProfit };
      if (!bestDay || day.profit > bestDay.profit) bestDay = day;
      if (!worstDay || day.profit < worstDay.profit) worstDay = day;
    }
    if (Number.isFinite(dailyReturn) && 1 + dailyReturn > 0) {
      growth *= 1 + dailyReturn;
      returnObservations += 1;
    }
    for (const id of Object.keys(benchmarkDefinitions)) {
      const dailyBenchmarkReturn = Number(record.benchmarkReturns?.[id] ?? (id === 'sp500' ? record.sp500Return : 0) ?? 0);
      if (Number.isFinite(dailyBenchmarkReturn) && 1 + dailyBenchmarkReturn > 0) benchmarkGrowth[id] *= 1 + dailyBenchmarkReturn;
    }
    peak = Math.max(peak, growth);
    maximumDrawdown = Math.min(maximumDrawdown, growth / peak - 1);
    if (Math.abs(dailyProfit) > 0.5) {
      dailyObservations.push({ portfolioReturn: dailyReturn, benchmarkReturn, profit: dailyProfit });
      const monthKey = record.date.slice(0, 7);
      monthProfits.set(monthKey, (monthProfits.get(monthKey) || 0) + dailyProfit);
      if (dailyProfit > 0) {
        winStreak += 1;
        lossStreak = 0;
        longestWinStreak = Math.max(longestWinStreak, winStreak);
      } else {
        lossStreak += 1;
        winStreak = 0;
        longestLossStreak = Math.max(longestLossStreak, lossStreak);
      }
    }
  }
  const options = periodPerformanceOptions(records);
  if (Number.isFinite(Number(options.endingAssets))) endingAssets = Number(options.endingAssets);
  const benchmarkPct = Object.fromEntries(Object.keys(benchmarkDefinitions).map(id => [id, (benchmarkGrowth[id] - 1) * 100]));
  const returnPct = returnObservations ? (growth - 1) * 100 : null;
  const positiveDays = dailyObservations.filter(item => item.profit > 0).length;
  const upDayRatioPct = dailyObservations.length ? positiveDays / dailyObservations.length * 100 : null;
  const activeMonths = [...monthProfits.values()];
  const winningMonths = activeMonths.filter(value => value > 0).length;
  const betaPairs = dailyObservations.filter(item => Number.isFinite(item.portfolioReturn) && Number.isFinite(item.benchmarkReturn));
  const benchmarkAverage = betaPairs.reduce((sum, item) => sum + item.benchmarkReturn, 0) / betaPairs.length;
  const portfolioAverage = betaPairs.reduce((sum, item) => sum + item.portfolioReturn, 0) / betaPairs.length;
  const benchmarkVariance = betaPairs.reduce((sum, item) => sum + (item.benchmarkReturn - benchmarkAverage) ** 2, 0);
  const covariance = betaPairs.reduce((sum, item) => sum + (item.portfolioReturn - portfolioAverage) * (item.benchmarkReturn - benchmarkAverage), 0);
  const beta = betaPairs.length >= 8 && benchmarkVariance > 0 ? covariance / benchmarkVariance : null;
  return {
    profit,
    endingAssets,
    fxImpact,
    bestDay,
    worstDay,
    returnPct,
    benchmarkPct,
    alphaPct: Object.fromEntries(Object.entries(benchmarkPct).map(([id, value]) => [id, returnPct === null || value === null ? null : returnPct - value])),
    drawdownPct: maximumDrawdown * 100,
    upDayRatioPct,
    winningMonths,
    monthCount: activeMonths.length,
    longestWinStreak,
    longestLossStreak,
    beta
  };
}
function periodHoldingContributions(records) {
  const selectedNames = selectedHistoricalHoldingNames();
  const includeEveryHistoricalHolding = accountFilter === '全部' && productFilter === '全部';
  const contributions = {};
  for (const record of records) {
    for (const [name, value] of Object.entries(record.breakdown?.holding || {})) {
      if (!includeEveryHistoricalHolding && !selectedNames.has(name)) continue;
      contributions[name] = (contributions[name] || 0) + Number(value.dailyProfitJPY || 0);
    }
  }
  const ranked = Object.entries(contributions)
    .filter(([, value]) => Math.abs(value) > 0.5)
    .sort((left, right) => right[1] - left[1]);
  const bestCount = Math.min(3, Math.ceil(ranked.length / 2));
  const worstCount = Math.min(3, ranked.length - bestCount);
  return {
    best: ranked.slice(0, bestCount),
    worst: worstCount ? ranked.slice(-worstCount).reverse() : []
  };
}
function setPeriodMetric(selector, value, formatter) {
  const element = document.querySelector(selector);
  if (!Number.isFinite(value)) {
    element.textContent = '—';
    element.className = 'neutral';
    return;
  }
  element.textContent = formatter(value);
  element.className = color(value);
}
function formatPeriodDay(day) {
  if (!day?.date) return '—';
  const [, month, dateValue] = day.date.split('-').map(Number);
  return `${month}月${dateValue}日`;
}
function renderPeriodDay(prefix, day) {
  document.querySelector(`${prefix}-date`).textContent = formatPeriodDay(day);
  const value = document.querySelector(`${prefix}-value`);
  value.textContent = day ? `${sign(day.profit)}${yen.format(day.profit)}` : '—';
  value.className = day ? color(day.profit) : 'neutral';
}
function renderPeriodRanking(selector, entries, emptyText = '—', formatter = value => `${sign(value)}${yen.format(value)}`) {
  document.querySelector(selector).innerHTML = entries.length
    ? entries.map(([name, value]) => `<div><span>${escapeHtml(name)}</span><strong class="${color(value)}">${formatter(value)}</strong></div>`).join('')
    : `<p>${escapeHtml(emptyText)}</p>`;
}
function renderPeriodReport() {
  const records = currentPeriodRecords();
  const result = periodPerformance(records);
  const leaderLabels = document.querySelectorAll('#period-leaders > div > span');
  if (leaderLabels[0]) leaderLabels[0].textContent = '贡献最大 Top3';
  if (leaderLabels[1]) leaderLabels[1].textContent = '表现最差 Top3';
  const year = reportDate.getFullYear();
  const periodName = trendView === 'all'
    ? '全期表现'
    : trendView === 'month'
      ? `${year}年${reportDate.getMonth() + 1}月月报`
      : `${year}年年报`;
  document.querySelector('#period-report-title').textContent = `${periodName} · ${currentPortfolioLabel()}`;
  setPeriodMetric('#period-profit', result.profit, value => `${sign(value)}${yen.format(value)}`);
  setPeriodMetric('#period-return', result.returnPct, value => `${sign(value)}${value.toFixed(2)}%`);
  document.querySelector('#period-ending-assets').textContent = yen.format(result.endingAssets);
  const primaryBenchmark = benchmarkDefinitions[benchmarkSettings.primary];
  const primaryReturn = result.benchmarkPct[benchmarkSettings.primary];
  const primaryAlpha = result.alphaPct[benchmarkSettings.primary];
  document.querySelector('#period-benchmark-label').innerHTML = `<i style="background:${primaryBenchmark.color}"></i>${primaryBenchmark.label} 同期`;
  setPeriodMetric('#period-sp500', primaryReturn, value => `${sign(value)}${value.toFixed(2)}%`);
  setPeriodMetric('#period-alpha', primaryAlpha, value => `${value >= 0 ? '跑赢' : '跑输'} ${primaryBenchmark.label} ${Math.abs(value).toFixed(2)} 个百分点`);
  document.querySelector('#period-benchmark-list').innerHTML = Object.entries(benchmarkDefinitions)
    .filter(([id]) => id !== benchmarkSettings.primary)
    .map(([id, benchmark]) => {
      const value = result.benchmarkPct[id];
      const alpha = result.alphaPct[id];
      if (!Number.isFinite(value) || !Number.isFinite(alpha)) return `<div><span><i style="background:${benchmark.color}"></i>${benchmark.label} 同期</span><strong class="neutral">—</strong><small class="neutral">—</small></div>`;
      return `<div><span><i style="background:${benchmark.color}"></i>${benchmark.label} 同期</span><strong class="${color(value)}">${sign(value)}${value.toFixed(2)}%</strong><small class="${color(alpha)}">${alpha >= 0 ? '跑赢' : '跑输'} ${benchmark.label} ${Math.abs(alpha).toFixed(2)} 个百分点</small></div>`;
    }).join('');
  document.querySelector('#period-drawdown').textContent = `${result.drawdownPct.toFixed(2)}%`;
  document.querySelector('#period-drawdown').className = result.drawdownPct < 0 ? 'down' : 'neutral';
  renderPeriodDay('#period-best-day', result.bestDay);
  renderPeriodDay('#period-worst-day', result.worstDay);
  const holdingContributions = periodHoldingContributions(records);
  const highestContributions = holdingContributions.best;
  const lowestContributions = holdingContributions.worst;
  const showLeaders = highestContributions.length > 0 || lowestContributions.length > 0;
  document.querySelector('#period-leaders').hidden = !showLeaders;
  if (showLeaders) {
    renderPeriodRanking('#period-top-contributors', highestContributions, '—');
    renderPeriodRanking('#period-worst-contributors', lowestContributions, '—');
  }
  const showFxImpact = selectedHoldings().some(item => item.market === 'US' && item.symbol);
  const fxCard = document.querySelector('#period-fx-card');
  fxCard.hidden = !showFxImpact;
  if (showFxImpact) {
    setPeriodMetric('#period-fx-impact', result.fxImpact, value => `${sign(value)}${yen.format(value)}`);
  }
  const now = new Date();
  const isAll = trendView === 'all';
  const isCurrent = isAll || (trendView === 'month'
    ? reportDate.getFullYear() === now.getFullYear() && reportDate.getMonth() === now.getMonth()
    : reportDate.getFullYear() === now.getFullYear());
  const previousButton = document.querySelector('#previous-period');
  const nextButton = document.querySelector('#next-period');
  previousButton.hidden = isAll;
  nextButton.hidden = isAll;
  nextButton.disabled = isCurrent;
}
function renderTrendPanel() {
  const showingTrend = trendView === 'trend';
  document.querySelector('#trend-resolution').hidden = !showingTrend;
  document.querySelector('#trend-chart-wrap').hidden = !showingTrend;
  document.querySelector('#period-report').hidden = showingTrend;
  if (showingTrend) renderTrendChart();
  else renderPeriodReport();
}
function openBenchmarkDialog() {
  document.querySelectorAll('#benchmark-options input[type="checkbox"]').forEach(input => {
    input.checked = benchmarkSettings.visible.includes(input.value);
  });
  document.querySelector('#benchmark-primary').value = benchmarkSettings.primary;
  document.querySelector('#benchmark-dialog').showModal();
}
function saveBenchmarkSettings() {
  benchmarkSettings = {
    visible: [...document.querySelectorAll('#benchmark-options input[type="checkbox"]:checked')].map(input => input.value),
    primary: document.querySelector('#benchmark-primary').value
  };
  localStorage.setItem(benchmarkSettingsKey, JSON.stringify(benchmarkSettings));
  document.querySelector('#benchmark-dialog').close();
  renderTrendPanel();
}
function renderAllocationChart() {
  const items = selectedHoldings();
  const type = productFilter !== '全部' ? item => item.name : productType;
  const values = group(items, type);
  const labels = Object.keys(values);
  const categoryColors = { '美股': '#426cf2', '基金': '#0eb984', '日股': '#e55269', '黄金': '#f0c30b', '现金': '#a0a8af' };
  const detailColors = ['#426cf2','#0eb984','#e55269','#f0c30b','#8a71d6','#35a5b8','#f08b45','#ec7090','#71847b','#66b66a','#b27a4c','#5f8ed8'];
  const colors = labels.map((label, index) => productFilter === '全部' && categoryColors[label] ? categoryColors[label] : detailColors[index % detailColors.length]);
  const chartWidth = document.querySelector('.pie-wrap')?.clientWidth || window.innerWidth;
  const horizontalPadding = chartWidth <= 420 ? 24 : 38;
  if (allocationChart) allocationChart.destroy();
  allocationChart = new Chart(document.querySelector('#allocation'), {
    type: 'pie',
    data: {
      labels,
      datasets: [{ data: Object.values(values), backgroundColor: colors, borderColor: usesIbkrTheme() ? '#10131c' : '#fff', borderWidth: 2 }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { left: horizontalPadding, right: horizontalPadding, top: 6, bottom: 6 } },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: context => `${context.label}: ${yen.format(context.raw)}` } } }
    },
    plugins: [labelPlugin]
  });
}
function trendWindowSize() {
  return trendMode === 'day' ? 15 : trendMode === 'week' ? 26 : 12;
}
function defaultTrendViewport(total) {
  const count = Math.min(total, trendWindowSize());
  return { start: Math.max(0, total - count), end: Math.max(0, total - 1), total };
}
function compactTrendValue(value) {
  const amount = Number(value || 0) / 10000;
  if (Math.abs(amount) < .05) return '0';
  return `${amount < 0 ? '-' : ''}${number.format(Math.abs(amount) >= 10 ? Math.round(Math.abs(amount)) : Number(Math.abs(amount).toFixed(1)))}万`;
}
function clampTrendViewport(start, end) {
  const total = trendViewport?.total || 0;
  if (total <= 1) return { start: 0, end: Math.max(0, total - 1) };
  const minimumSpan = Math.min(3, total - 1);
  let span = Math.max(minimumSpan, Math.min(total - 1, Math.round(end - start)));
  let nextStart = Math.round(start);
  nextStart = Math.max(0, Math.min(total - 1 - span, nextStart));
  return { start: nextStart, end: nextStart + span };
}
function updateTrendYAxis(start, end) {
  if (!trendChart) return;
  const values = trendChart.data.datasets.flatMap(dataset => dataset.data.slice(start, end + 1)).map(Number).filter(Number.isFinite);
  if (!values.length) return;
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const padding = Math.max((maximum - minimum) * .1, Math.abs(maximum || minimum) * .015, 1000);
  trendChart.options.scales.y.min = minimum - padding;
  trendChart.options.scales.y.max = maximum + padding;
}
function applyTrendViewport(start, end) {
  if (!trendChart || !trendViewport) return;
  const next = clampTrendViewport(start, end);
  trendViewport.start = next.start;
  trendViewport.end = next.end;
  trendChart.options.scales.x.min = next.start;
  trendChart.options.scales.x.max = next.end;
  updateTrendYAxis(next.start, next.end);
  trendChart.update('none');
}
function resetTrendViewport() {
  if (!trendViewport) return;
  const initial = defaultTrendViewport(trendViewport.total);
  applyTrendViewport(initial.start, initial.end);
}
function trendPointerDistance(points) {
  return Math.abs(points[0].x - points[1].x);
}
function bindTrendInteractions(canvas) {
  if (canvas.dataset.trendInteractions === '1') return;
  canvas.dataset.trendInteractions = '1';
  canvas.addEventListener('wheel', event => {
    if (!trendChart || !trendViewport || !trendChart.chartArea) return;
    event.preventDefault();
    const area = trendChart.chartArea;
    const ratio = Math.max(0, Math.min(1, (event.clientX - canvas.getBoundingClientRect().left - area.left) / area.width));
    const span = trendViewport.end - trendViewport.start;
    const nextSpan = span * (event.deltaY > 0 ? 1.25 : .8);
    const anchor = trendViewport.start + span * ratio;
    applyTrendViewport(anchor - nextSpan * ratio, anchor + nextSpan * (1 - ratio));
  }, { passive: false });
  canvas.addEventListener('pointerdown', event => {
    if (!trendChart || !trendViewport) return;
    canvas.setPointerCapture?.(event.pointerId);
    trendPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const points = [...trendPointers.values()];
    if (points.length === 1) {
      trendGesture = { type: 'pan', startX: event.clientX, start: trendViewport.start, end: trendViewport.end, moved: false };
    } else if (points.length === 2) {
      trendGesture = { type: 'pinch', distance: Math.max(trendPointerDistance(points), 1), centerX: (points[0].x + points[1].x) / 2, start: trendViewport.start, end: trendViewport.end, moved: false };
    }
  });
  canvas.addEventListener('pointermove', event => {
    if (!trendPointers.has(event.pointerId) || !trendGesture || !trendChart?.chartArea) return;
    trendPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const area = trendChart.chartArea;
    const points = [...trendPointers.values()];
    if (points.length >= 2 && trendGesture.type === 'pinch') {
      const distance = Math.max(trendPointerDistance(points), 1);
      const span = trendGesture.end - trendGesture.start;
      const nextSpan = span * trendGesture.distance / distance;
      const center = (points[0].x + points[1].x) / 2;
      const ratio = Math.max(0, Math.min(1, (center - canvas.getBoundingClientRect().left - area.left) / area.width));
      const anchor = trendGesture.start + span * Math.max(0, Math.min(1, (trendGesture.centerX - canvas.getBoundingClientRect().left - area.left) / area.width));
      trendGesture.moved = true;
      applyTrendViewport(anchor - nextSpan * ratio, anchor + nextSpan * (1 - ratio));
    } else if (points.length === 1 && trendGesture.type === 'pan') {
      const span = trendGesture.end - trendGesture.start;
      const shift = (trendGesture.startX - event.clientX) / area.width * span;
      if (Math.abs(event.clientX - trendGesture.startX) > 3) trendGesture.moved = true;
      applyTrendViewport(trendGesture.start + shift, trendGesture.end + shift);
    }
  });
  const finishPointer = event => {
    const wasTap = trendPointers.size === 1 && trendGesture && !trendGesture.moved;
    trendPointers.delete(event.pointerId);
    const points = [...trendPointers.values()];
    if (points.length === 1) {
      trendGesture = { type: 'pan', startX: points[0].x, start: trendViewport.start, end: trendViewport.end, moved: false };
    } else {
      trendGesture = null;
    }
    if (wasTap && event.pointerType === 'touch') {
      const now = Date.now();
      if (now - trendLastTapAt < 350) resetTrendViewport();
      trendLastTapAt = now;
    }
  };
  canvas.addEventListener('pointerup', finishPointer);
  canvas.addEventListener('pointercancel', finishPointer);
  canvas.addEventListener('dblclick', resetTrendViewport);
}
function renderTrendChart() {
  let entries = Object.entries(aggregateHistory());
  if (!entries.length) {
    const total = selectedHoldings().map(metrics).reduce((sum, item) => sum + item.valueJPY, 0);
    entries = [[todayInTokyo(), { total, profit: 0, benchmarks: {} }]];
  }
  const points = entries.map(([, point]) => point);
  const initialViewport = defaultTrendViewport(entries.length);
  const pointRadius = trendMode === 'day' ? 2 : trendMode === 'month' ? 1.5 : 0;
  const tickLimit = trendMode === 'day' ? 8 : trendMode === 'week' ? 7 : 7;
  if (trendChart) trendChart.destroy();
  const datasets = [{
    label: currentPortfolioLabel(),
    data: points.map(point => point.total ?? point.profit),
    borderColor: usesIbkrTheme() ? '#4f7cff' : '#426cf2',
    backgroundColor: usesIbkrTheme() ? 'rgba(79,124,255,.14)' : 'rgba(66,108,242,.10)',
    fill: true,
    tension: .35,
    pointRadius,
    pointHoverRadius: 4
  }, ...benchmarkSettings.visible.map(id => {
    const benchmark = benchmarkDefinitions[id];
    return {
      label: benchmark.label,
      data: points.map(point => point.benchmarks?.[id]?.total ?? point.benchmarks?.[id]?.profit ?? null),
      borderColor: benchmark.color,
      backgroundColor: 'transparent',
      fill: false,
      tension: .35,
      pointRadius,
      pointHoverRadius: 4
    };
  })];
  const canvas = document.querySelector('#trend');
  trendChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels: entries.map(([label]) => label),
      datasets
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: true, position: 'top', labels: { usePointStyle: true, boxWidth: 8 } },
        tooltip: { callbacks: { label: context => `${context.dataset.label}: ${yen.format(context.parsed.y)}` } }
      },
      scales: {
        x: {
          min: initialViewport.start,
          max: initialViewport.end,
          ticks: {
            autoSkip: true,
            maxTicksLimit: tickLimit,
            maxRotation: 0,
            minRotation: 0,
            callback(value) {
              const label = this.getLabelForValue(value);
              return trendMode === 'month' ? label : label.slice(5);
            }
          }
        },
        y: { ticks: { maxTicksLimit: 6, callback: compactTrendValue } }
      }
    }
  });
  trendViewport = initialViewport;
  bindTrendInteractions(canvas);
  updateTrendYAxis(initialViewport.start, initialViewport.end);
  trendChart.update('none');
}
function renderCharts() {
  if (!globalThis.Chart) {
    ensureChartLibrary()
      .then(() => {
        if (portfolio) renderCharts();
      })
      .catch(error => {
        const notice = document.querySelector('#notice');
        if (notice && !notice.textContent) notice.textContent = `${error.message}，其他数据不受影响。`;
      });
    return;
  }
  renderAllocationChart();
  renderTrendPanel();
}
function contributionEntries(record) {
  const holdings = record?.breakdown?.holding || {};
  const activeByName = new Map(activeHoldings().map(item => [item.name, item]));
  return Object.entries(holdings)
    .filter(([name, values]) => name !== '预存款与现金' && activeByName.has(name) && Math.round(Number(values.dailyProfitJPY || 0)) !== 0)
    .map(([name, values]) => {
      const holding = activeByName.get(name);
      const profit = Number(values.dailyProfitJPY || 0);
      const closingValue = Number(values.totalAssetsJPY || 0);
      const openingValue = closingValue - profit;
      const recordedReturnRate = Number(values.dailyReturnRate ?? values.dailyProfitRate);
      const isCurrentQuoteDay = String(holding?.quote?.profitDate || '') === String(record?.date || '');
      const detailPercent = isCurrentQuoteDay ? dailyPercent(holding) : null;
      return {
        name,
        symbol: holding?.symbol || '—',
        profit,
        percent: Number.isFinite(detailPercent)
          ? detailPercent
          : Number.isFinite(recordedReturnRate)
          ? recordedReturnRate * 100
          : openingValue > 0 ? profit / openingValue * 100 : 0
      };
    })
    .sort((left, right) => Math.abs(right.profit) - Math.abs(left.profit));
}
function dailyAiContributionEntries(record) {
  const entries = contributionEntries(record);
  const updatedNames = new Set(
    (Array.isArray(record?.updatedHoldings) ? record.updatedHoldings : [])
      .map(normalizedDailyAiName)
      .filter(Boolean)
  );
  return updatedNames.size
    ? entries.filter(item => updatedNames.has(normalizedDailyAiName(item.name)) || updatedNames.has(normalizedDailyAiName(item.symbol)))
    : entries;
}
function latestDailyAiRecord(onOrBefore = '') {
  return (portfolio.history || [])
    .filter(record => record?.date && (!onOrBefore || record.date <= onOrBefore) && dailyAiContributionEntries(record).length)
    .sort((left, right) => left.date.localeCompare(right.date))
    .at(-1) || null;
}
function visibleContributionEntries(entries) {
  if (contributionExpanded || entries.length <= 6) return entries;
  const winners = entries.filter(item => item.profit > 0).slice(0, 3);
  const losers = entries.filter(item => item.profit < 0).slice(0, 3);
  return [...winners, ...losers].sort((left, right) => Math.abs(right.profit) - Math.abs(left.profit));
}
function renderContributionDialog() {
  const chart = document.querySelector('#contribution-chart');
  const toggle = document.querySelector('#toggle-contribution-list');
  const [year, month, day] = contributionRecord.date.split('-').map(Number);
  const entries = contributionEntries(contributionRecord);
  const visibleEntries = visibleContributionEntries(entries);
  const maximum = Math.max(...entries.map(item => Math.abs(item.profit)), 1);
  document.querySelector('#contribution-title').textContent = `${year}年${month}月${day}日`;
  const total = Number(contributionRecord.dailyProfitJPY || 0);
  const totalElement = document.querySelector('#contribution-total');
  totalElement.textContent = `当日盈亏 ${sign(total)}${yen.format(total)}`;
  totalElement.className = total > 0 ? 'contribution-positive' : total < 0 ? 'contribution-negative' : '';
  chart.innerHTML = visibleEntries.length ? `<div class="contribution-axis"><span></span><div><strong>0</strong></div><span></span></div>${visibleEntries.map(item => {
    const width = Math.max(Math.abs(item.profit) / maximum * 50, item.profit ? 1.5 : 0);
    const direction = item.profit > 0 ? 'positive' : item.profit < 0 ? 'negative' : 'zero';
    return `<div class="contribution-row">
      <div class="contribution-name"><strong>${item.name}</strong><small>${item.symbol}</small></div>
      <div class="contribution-track"><span class="contribution-zero-line"></span><span class="contribution-bar ${direction}" style="width:${width}%"></span></div>
      <div class="contribution-value ${direction}"><strong>${sign(item.profit)}${yen.format(item.profit)}</strong><small>${sign(item.percent)}${item.percent.toFixed(2)}%</small></div>
    </div>`;
  }).join('')}` : '<div class="empty-contribution">当日暂无持仓盈亏记录</div>';
  toggle.hidden = entries.length <= 6;
  document.querySelector('#contribution-actions').hidden = entries.length <= 6;
  toggle.textContent = contributionExpanded ? '收起持仓' : `展开更多持仓（共 ${entries.length} 只）`;
}
function dailyAiCacheKey(recordDate = contributionRecord?.date || '') {
  const scope = localProfileToken || sessionMode || 'owner';
  return `portfolioDailyAiSummaryV11:${scope}:${recordDate}`;
}
function dailyAiFingerprint(record = contributionRecord) {
  if (!record) return '';
  return JSON.stringify({
    date: record.date,
    profit: Math.round(Number(record.dailyProfitJPY || 0)),
    fx: Math.round(Number(record.dailyFxImpactJPY || 0)),
    updated: (Array.isArray(record.updatedHoldings) ? record.updatedHoldings : [])
      .map(normalizedDailyAiName)
      .filter(Boolean)
      .sort(),
    entries: dailyAiContributionEntries(record).map(item => [item.name, Math.round(item.profit), Number(item.percent.toFixed(3))])
  });
}
function readDailyAiCache() {
  const savedReports = portfolio?.dailyAiSummaries;
  const savedReport = savedReports && typeof savedReports === 'object'
    ? savedReports[contributionRecord?.date || '']
    : null;
  if (Number(savedReport?.analysisVersion || 0) >= 7) return savedReport;
  try {
    const cached = JSON.parse(localStorage.getItem(dailyAiCacheKey()) || 'null');
    return Number(cached?.report?.analysisVersion || 0) >= 7 ? cached.report : null;
  } catch {
    return null;
  }
}
function writeDailyAiCache(report, record = contributionRecord) {
  const reportDate = String(report?.date || record?.date || '');
  if (reportDate) {
    if (!portfolio.dailyAiSummaries || typeof portfolio.dailyAiSummaries !== 'object') portfolio.dailyAiSummaries = {};
    portfolio.dailyAiSummaries[reportDate] = report;
  }
  try {
    localStorage.setItem(dailyAiCacheKey(reportDate), JSON.stringify({ fingerprint: dailyAiFingerprint(record), report }));
  } catch {
    // AI 日报缓存失败不影响正常使用。
  }
}
function dailyAiValueClass(value, label = '') {
  const text = String(value || '').trim();
  const metricLabel = String(label || '');
  if (/分位|市值|数量|日期/.test(metricLabel)) return '';
  return text.startsWith('+') ? 'positive' : text.startsWith('-') ? 'negative' : '';
}
function normalizedDailyAiName(value) {
  return String(value || '').toLowerCase().replace(/[\s　・･（）()&＆._-]+/g, '');
}
function dailyAiDisplayMetrics(item) {
  const itemName = normalizedDailyAiName(item?.name);
  const matched = dailyAiContributionEntries(contributionRecord).find(entry => {
    const name = normalizedDailyAiName(entry.name);
    const symbol = normalizedDailyAiName(entry.symbol);
    return itemName === name || (symbol && (itemName === symbol || itemName.includes(symbol)));
  });
  const original = (Array.isArray(item?.metrics) ? item.metrics : []).filter(metric => {
    const label = String(metric?.label || '');
    const value = String(metric?.value || '');
    return !/NASDAQ|纳斯达克|S&P\s*500|TOPIX|基准|相对表现|额外跑赢|额外跑输|百分点/i.test(`${label} ${value}`);
  });
  if (!matched) return original;
  const required = [
    { label: '单日收益率', value: `${sign(matched.percent)}${matched.percent.toFixed(2)}%` },
    { label: '当日盈亏', value: `${sign(matched.profit)}${yen.format(matched.profit)}` }
  ];
  const remaining = original.filter(metric => {
    const label = String(metric?.label || '');
    return !/日涨跌|涨跌幅|单日收益率|当日盈亏|今日盈亏/.test(label)
      && normalizedDailyAiName(label) !== normalizedDailyAiName(matched.name);
  });
  return [...required, ...remaining].slice(0, 5);
}
function renderDailyAiReport(report, { scroll = true } = {}) {
  const container = document.querySelector('#daily-ai-report');
  const changes = Array.isArray(report?.changeNature) ? report.changeNature : [];
  const logicChanges = Array.isArray(report?.logicChanges) ? report.logicChanges : [];
  const actions = Array.isArray(report?.actions) ? report.actions : [];
  const reportDate = String(report?.date || contributionRecord?.date || '');
  const readableDate = /^\d{4}-\d{2}-\d{2}$/.test(reportDate)
    ? `${Number(reportDate.slice(5, 7))}月${Number(reportDate.slice(8, 10))}日`
    : '';
  container.innerHTML = `<div class="daily-ai-section daily-ai-summary-section">
    <h3>今日总结${readableDate ? ` · ${readableDate}` : ''}</h3>
    <p>${escapeHtml(report?.summary || '当天数据已经完成核对。')}</p>
  </div>
  <div class="daily-ai-section">
    <h3>1. 变化性质</h3>
    <div class="daily-ai-change-list">${changes.length ? changes.map(item => `<article class="daily-ai-change">
      <div class="daily-ai-change-head"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.label)}</span></div>
      <div class="daily-ai-metrics">${dailyAiDisplayMetrics(item).map(metric => `<div><span>${escapeHtml(metric.label)}</span><strong class="${dailyAiValueClass(metric.value, metric.label)}">${escapeHtml(metric.value)}</strong></div>`).join('')}</div>
      <p>${escapeHtml(item.analysis)}</p>
    </article>`).join('') : '<p class="daily-ai-empty">当天没有需要单独拆解的异常变化。</p>'}</div>
  </div>
  <div class="daily-ai-section">
    <h3>2. 投资逻辑变化</h3>
    <div class="daily-ai-logic-list">${logicChanges.length ? logicChanges.map(item => `<article class="daily-ai-logic">
      <div><strong>${escapeHtml(item.name)}</strong><span class="direction-${escapeHtml(item.direction)}">${escapeHtml(item.direction)}</span></div>
      <p>${escapeHtml(item.reason)}</p><small>确认条件：${escapeHtml(item.verification)}</small>
    </article>`).join('') : '<p class="daily-ai-empty">今日未发现足以改变长期投资逻辑的新证据。</p>'}</div>
  </div>
  <div class="daily-ai-section daily-ai-action-section">
    <h3>3. 行动提示</h3>
    <ol>${actions.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ol>
  </div>`;
  container.hidden = false;
  renderedDailyAiDate = contributionRecord?.date || report?.date || '';
  refreshDailyAiButton('重新分析');
  if (scroll) container.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function stopDailyAiLoading() {
  if (dailyAiLoadingTimer) clearInterval(dailyAiLoadingTimer);
  dailyAiLoadingTimer = null;
}
function clearDailyAiReport() {
  stopDailyAiLoading();
  const status = document.querySelector('#daily-ai-status');
  const report = document.querySelector('#daily-ai-report');
  status.hidden = true;
  status.classList.remove('error');
  report.hidden = true;
  report.innerHTML = '';
  renderedDailyAiDate = '';
  const button = document.querySelector('#daily-ai-summary-button');
  button.textContent = selectedCalendarDate ? aiQuotaText('calendar', 'AI总结') : '暂无数据';
}
async function requestDailyAiSummary(forceRefresh = false) {
  let requestedDate = selectedCalendarDate || contributionRecord?.date || '';
  if (!requestedDate) return;
  if (cloudDeployment && (!historyHydrated || !Array.isArray(portfolio?.history) || !portfolio.history.length)) {
    try {
      await hydratePortfolioHistory({ force: true });
    } catch (error) {
      const status = document.querySelector('#daily-ai-status');
      status.hidden = false;
      status.classList.add('error');
      status.textContent = `历史数据加载失败：${error.message}`;
      return;
    }
  }
  const analyzableRecord = latestDailyAiRecord(requestedDate);
  if (!analyzableRecord) return;
  requestedDate = analyzableRecord.date;
  selectedCalendarDate = requestedDate;
  selectContributionRecord(requestedDate);
  if (!contributionHasRecord || !contributionRecord?.date) return;
  const requestRecord = typeof structuredClone === 'function'
    ? structuredClone(contributionRecord)
    : JSON.parse(JSON.stringify(contributionRecord));
  const cached = forceRefresh ? null : readDailyAiCache();
  if (cached) {
    renderDailyAiReport(cached);
    return;
  }
  const button = document.querySelector('#daily-ai-summary-button');
  const status = document.querySelector('#daily-ai-status');
  const report = document.querySelector('#daily-ai-report');
  const loadingSteps = ['整理当天持仓变化…', '核对大盘、行业与汇率…', '结合财务与市场数据…', '形成投资逻辑判断…'];
  let loadingIndex = 0;
  button.disabled = true;
  button.textContent = '分析中…';
  status.hidden = false;
  status.classList.remove('error');
  status.textContent = loadingSteps[loadingIndex];
  stopDailyAiLoading();
  dailyAiLoadingTimer = setInterval(() => {
    loadingIndex = (loadingIndex + 1) % loadingSteps.length;
    status.textContent = loadingSteps[loadingIndex];
  }, 1600);
  try {
    const url = sessionMode === 'user'
      ? '/api/daily-ai-summary'
      : localPortfolioMode
        ? profileApiUrl('/api/profile-daily-ai-summary')
        : '/api/daily-ai-summary';
    const analysisEntries = dailyAiContributionEntries(requestRecord);
    const analysisRecord = {
      ...requestRecord,
      updatedHoldings: analysisEntries.map(item => item.name)
    };
    const response = await apiFetch(url, {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        date: requestRecord.date,
        record: analysisRecord,
        ...(sessionMode === 'user' ? { portfolio } : {})
      })
    });
    const payload = await response.json();
    if (!response.ok || payload.error || !payload.report) throw new Error(payload.error || 'AI没有返回单日总结');
    if (payload.aiUsage) accountAiUsage = payload.aiUsage;
    const resultDate = payload.analysisDate || requestRecord.date;
    writeDailyAiCache(payload.report, { ...requestRecord, date: resultDate });
    status.hidden = true;
    if (selectedCalendarDate === resultDate || contributionRecord?.date === resultDate) {
      if (contributionRecord?.date !== resultDate) selectContributionRecord(resultDate);
      renderDailyAiReport(payload.report, { scroll: document.body.dataset.dashboardView === 'calendar' });
    }
  } catch (error) {
    status.hidden = false;
    status.classList.add('error');
    status.textContent = error.message || 'AI总结生成失败，请稍后再试。';
  } finally {
    stopDailyAiLoading();
    button.disabled = false;
    refreshDailyAiButton(report.hidden ? 'AI总结' : '重新分析');
  }
}
function selectContributionRecord(dayText) {
  const matchedRecord = calendarRecordForDate(dayText);
  contributionHasRecord = Boolean(matchedRecord);
  contributionRecord = matchedRecord || {
    date: dayText,
    dailyProfitJPY: 0,
    breakdown: { holding: {} }
  };
}
function restoreDailyAiReport() {
  if (!selectedCalendarDate) {
    if (renderedDailyAiDate) clearDailyAiReport();
    return false;
  }
  const analyzableRecord = latestDailyAiRecord(selectedCalendarDate);
  if (!analyzableRecord) return false;
  selectedCalendarDate = analyzableRecord.date;
  selectContributionRecord(selectedCalendarDate);
  const cached = readDailyAiCache();
  const report = document.querySelector('#daily-ai-report');
  if (cached) {
    if (report.hidden || renderedDailyAiDate !== selectedCalendarDate) renderDailyAiReport(cached, { scroll: false });
    return true;
  }
  if (!report.hidden && renderedDailyAiDate !== selectedCalendarDate) clearDailyAiReport();
  return false;
}
function openContributionDialog(dayText) {
  selectContributionRecord(dayText);
  contributionExpanded = false;
  renderContributionDialog();
  document.querySelector('#daily-contribution-dialog').showModal();
}
function liveCalendarRecords() {
  const records = new Map();
  activeHoldings().forEach(holding => {
    const dateText = String(holding.quote?.profitDate || '');
    const value = metrics(holding);
    const dailyProfit = Number(value.dailyJPY);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText) || quoteProfitDayIsWeekend(holding) || !Number.isFinite(dailyProfit)) return;
    const record = records.get(dateText) || {
      date: dateText,
      dailyProfitJPY: 0,
      breakdown: { holding: {} },
      updatedHoldings: [],
      live: true,
    };
    const openingValue = Number(value.valueJPY || 0) - dailyProfit;
    record.dailyProfitJPY += dailyProfit;
    record.breakdown.holding[holding.name] = {
      dailyProfitJPY: dailyProfit,
      totalAssetsJPY: Number(value.valueJPY || 0),
      totalNetAsset: Number(value.valueJPY || 0),
      dailyReturnRate: openingValue > 0 ? dailyProfit / openingValue : 0,
      dailyProfitRate: openingValue > 0 ? dailyProfit / openingValue : 0,
    };
    record.updatedHoldings.push(holding.name);
    records.set(dateText, record);
  });
  records.forEach(record => {
    record.dailyProfitJPY = Math.round(record.dailyProfitJPY);
    record.updatedHoldings = [...new Set(record.updatedHoldings)];
  });
  return records;
}
function calendarRecordForDate(dayText) {
  return liveCalendarRecords().get(dayText)
    || (portfolio.history || []).find(item => item.date === dayText)
    || null;
}
function renderCalendar() {
  const year = displayedMonth.getFullYear();
  const month = displayedMonth.getMonth();
  const records = new Map((portfolio.history || []).map(item => [item.date, item.dailyProfitJPY]));
  liveCalendarRecords().forEach((record, dateText) => records.set(dateText, record.dailyProfitJPY));
  const last = new Date(year, month + 1, 0).getDate();
  const firstTradingDay = Array.from({ length: last }, (_, index) => index + 1)
    .find(day => ![0, 6].includes(new Date(year, month, day).getDay()));
  const offset = firstTradingDay
    ? (new Date(year, month, firstTradingDay).getDay() + 6) % 7
    : 0;
  const days = Array.from({ length: offset }, () => '<div class="day empty"></div>');
  let total = 0;
  for (let day = 1; day <= last; day++) {
    const weekDay = new Date(year, month, day).getDay();
    if (weekDay === 0 || weekDay === 6) continue;
    const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const value = records.get(key);
    if (value !== undefined) total += value;
    const state = value === undefined ? '' : value >= 0 ? 'positive' : 'negative';
    days.push(`<button type="button" class="day ${state}" data-calendar-date="${key}" aria-label="查看${month + 1}月${day}日盈亏贡献"><span class="date">${day}</span>${value === undefined ? '' : `<span class="value">${sign(value)}${yen.format(value)}</span>`}</button>`);
  }
  document.querySelector('#calendar-month').textContent = `${year}年${month + 1}月`;
  document.querySelector('#calendar').innerHTML = days.join('');
  document.querySelector('#month-total').innerHTML = total ? `${year}年${month + 1}月收益：<strong class="${color(total)}">${sign(total)}${yen.format(total)}</strong>` : '该月暂无已记录的收益数据';
  const monthPrefix = `${year}-${String(month + 1).padStart(2, '0')}-`;
  const availableDates = [...new Set([
    ...(portfolio.history || []).map(item => item.date),
    ...liveCalendarRecords().keys(),
  ])]
    .filter(date => date.startsWith(monthPrefix))
    .sort();
  const analyzableDates = availableDates.filter(date => {
    const record = calendarRecordForDate(date);
    return record && dailyAiContributionEntries(record).length > 0;
  });
  const latestAnalyzableDate = analyzableDates[analyzableDates.length - 1] || '';
  if (!calendarDateUserSelected || !analyzableDates.includes(selectedCalendarDate)) {
    selectedCalendarDate = latestAnalyzableDate;
  }
  const summaryButton = document.querySelector('#daily-ai-summary-button');
  const report = document.querySelector('#daily-ai-report');
  summaryButton.disabled = !selectedCalendarDate;
  const restored = restoreDailyAiReport();
  summaryButton.textContent = selectedCalendarDate ? (restored || !report.hidden ? '重新分析' : 'AI总结') : '暂无数据';
}
function renderEditor() {
  document.querySelector('#editor-rows').innerHTML = portfolio.holdings
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !item.archived)
    .map(({ item, index }) => {
      const reviewFields = importReviewFields.get(item.id) || new Set();
      const reviewClass = field => reviewFields.has(field) ? ' class="import-needs-review"' : '';
      return `<tr data-index="${index}" ${reviewFields.size ? 'class="import-review-row"' : ''}><td><input value="${item.name}"></td><td><input value="${item.symbol || ''}"></td><td><select><option value="US" ${item.market === 'US' ? 'selected' : ''}>美国</option><option value="JP" ${item.market === 'JP' ? 'selected' : ''}>日本</option></select></td><td><select${reviewClass('account')} data-review-field="account"><option value="" ${accountType(item) === '未设置' ? 'selected' : ''}>未设置</option><option value="NISA" ${accountType(item) === 'NISA' ? 'selected' : ''}>NISA</option><option value="特定" ${accountType(item) === '特定' ? 'selected' : ''}>特定</option><option value="一般" ${accountType(item) === '一般' ? 'selected' : ''}>一般</option><option value="黄金" ${accountType(item) === '黄金' ? 'selected' : ''}>黄金</option></select></td><td><input${reviewClass('buyPrice')} data-review-field="buyPrice" type="number" step="any" value="${item.buyPrice ?? item.avgCost ?? ''}"></td><td><input${reviewClass('units')} data-review-field="units" type="number" step="any" value="${item.units ?? ''}"></td><td><button class="delete-holding" data-delete="${index}">删除</button></td></tr>`;
    })
    .join('');
  document.querySelectorAll('.import-needs-review').forEach(control => {
    const clearWhenComplete = () => {
      const complete = control.dataset.reviewField === 'account'
        ? Boolean(control.value)
        : Number(control.value) > 0;
      if (complete) control.classList.remove('import-needs-review');
    };
    control.addEventListener('input', clearWhenComplete);
    control.addEventListener('change', clearWhenComplete);
  });
  document.querySelectorAll('[data-delete]').forEach(button => button.addEventListener('click', () => {
    const index = Number(button.dataset.delete);
    const holding = portfolio.holdings[index];
    if (!window.confirm(`确定删除“${holding?.name || '该持仓'}”吗？`)) return;
    portfolio.holdings.splice(index, 1);
    renderEditor();
  }));
}
function detailMatches(item) {
  return (accountFilter === '全部' || accountType(item) === accountFilter)
    && (productFilter === '全部' || productType(item) === productFilter);
}
function renderDetailFilters() {
  renderFilterControls('#holding-account-select', '#holding-filter');
}
function sortedEntries(data) { return data.holdings.map((item, index) => ({ item, index, value: metrics(item), change: dailyPercent(item) })).filter(({ item }) => !item.archived && detailMatches(item)).sort((left, right) => { const values = { name: [left.item.name, right.item.name], market: [left.item.market, right.item.market], value: [left.value.valueJPY, right.value.valueJPY], profit: [left.value.profitJPY, right.value.profitJPY], price: [left.item.quote?.price ?? -Infinity, right.item.quote?.price ?? -Infinity], change: [left.change ?? -Infinity, right.change ?? -Infinity], daily: [left.value.dailyJPY ?? -Infinity, right.value.dailyJPY ?? -Infinity] }; const [first, second] = values[sortKey]; return (typeof first === 'string' ? first.localeCompare(second, 'zh-CN') : first - second) * sortDirection; }); }
function holdingQuantityUnit(item) {
  const type = productType(item);
  if (type === '黄金') return '克';
  if (type === '基金') return '口';
  return '股';
}
function holdingAverageCost(item) {
  const rawValue = item.buyPrice ?? item.avgCost;
  const value = rawValue === '' || rawValue === null || rawValue === undefined ? NaN : Number(rawValue);
  if (!Number.isFinite(value)) return '—';
  const type = productType(item);
  const suffix = type === '基金' ? '/万口' : type === '黄金' ? '/克' : '/股';
  return `${yen.format(value)}${suffix}`;
}
function renderHoldingRows(data = portfolio) {
  document.querySelector('#rows').innerHTML = sortedEntries(data).map(({ item, value, change }) => {
    const market = item.market === 'US' ? '美国' : '日本';
    const latestPrice = item.quote ? `${number.format(item.quote.price)} ${item.quote.currency || ''}` : '—';
    const goldSpotPrice = item.name === '黄金' && Number.isFinite(Number(item.quote?.futuresUSDPerOunce))
      ? `<small class="gold-spot-price">${number.format(Number(item.quote.futuresUSDPerOunce))} USD/oz（期金）</small>`
      : '';
    return `<tr data-holding-id="${escapeHtml(item.id)}"><td><div class="holding-card-head"><span class="name">${item.name}</span><small class="holding-symbol neutral">${item.symbol || '—'}</small></div></td><td>${market}</td><td><strong class="holding-primary-value">${yen.format(value.valueJPY)}</strong><br><small class="neutral">本金：${yen.format(value.costJPY)}</small></td><td class="${color(value.profitJPY)}"><strong class="holding-primary-value">${sign(value.profitJPY)}${yen.format(value.profitJPY)}</strong><br><small>${sign(value.profitPct)}${value.profitPct.toFixed(2)}%</small></td><td class="${change === null ? 'neutral' : color(change)}"><span>${latestPrice}</span>${goldSpotPrice}${extendedQuoteMetricHtml(item, 'price')}</td><td class="${change === null ? 'neutral' : color(change)}"><span>${change === null ? '—' : `${sign(change)}${change.toFixed(2)}%`}</span>${extendedQuoteMetricHtml(item, 'change')}</td><td class="${value.dailyJPY === null ? 'neutral' : color(value.dailyJPY)}"><span>${value.dailyJPY === null ? '—' : `${sign(value.dailyJPY)}${yen.format(value.dailyJPY)}`}</span>${extendedQuoteMetricHtml(item, 'profit')}</td><td class="holding-position-meta"><div><span>平均成本</span><strong>${holdingAverageCost(item)}</strong></div><div><span>持仓数量</span><strong>${preciseNumber.format(Number(item.units) || 0)}${holdingQuantityUnit(item)}</strong></div></td></tr>`;
  }).join('');
}
function watchQuoteDetails(item) {
  const quote = item.quote || {};
  const extended = extendedQuoteDetails(item);
  const price = Number(quote.price);
  const previousClose = Number(quote.previousClose);
  const officialChangePct = Number(quote.changePct);
  const change = Number.isFinite(officialChangePct)
    ? officialChangePct
    : Number.isFinite(price) && Number.isFinite(previousClose) && previousClose
      ? (price / previousClose - 1) * 100
      : null;
  const value = metrics(item);
  return {
    price,
    change,
    valueJPY: value.valueJPY,
    profitJPY: value.profitJPY,
    profitPct: value.profitPct,
    currency: quote.currency || '',
    extended
  };
}
function watchPriceHtml(item, details) {
  if (!Number.isFinite(details.price)) return '—';
  const currency = details.currency || (item.market === 'US' ? 'USD' : 'JPY');
  return `<span>${number.format(details.price)}</span><small>${escapeHtml(currency)}</small>`;
}
function renderWatchRows(data = portfolio) {
  const rows = sortedEntries(data).filter(({ item }) => item.name !== '预存款与现金');
  document.querySelector('#watch-rows').innerHTML = rows.length ? rows.map(({ item }) => {
    const details = watchQuoteDetails(item);
    const profitAmount = Number.isFinite(details.profitJPY) ? `${sign(details.profitJPY)}${yen.format(details.profitJPY)}` : '—';
    const profitText = Number.isFinite(details.profitPct) ? `${sign(details.profitPct)}${details.profitPct.toFixed(2)}%` : '—';
    const changeText = details.change === null ? '—' : `${sign(details.change)}${details.change.toFixed(2)}%`;
    const positionValue = Number.isFinite(details.valueJPY) ? yen.format(details.valueJPY) : '—';
    const extendedQuote = details.extended
      ? `<small class="watch-extended-label">${details.extended.label}</small><strong class="watch-extended-price ${color(details.extended.changePct)}">${number.format(details.extended.price)}</strong><span class="watch-extended-spacer"></span><strong class="watch-extended-change ${color(details.extended.changePct)}">${sign(details.extended.changePct)}${details.extended.changePct.toFixed(2)}%</strong>`
      : '';
    return `<article class="watch-row" data-holding-id="${escapeHtml(item.id)}"><div class="watch-name"><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.symbol || productType(item))}</small></div><div class="watch-position"><strong>${positionValue}</strong><small class="${Number.isFinite(details.profitJPY) ? color(details.profitJPY) : 'neutral'}">${profitAmount}（${profitText}）</small></div><div class="watch-quote-line"><div class="watch-quote-grid"><small>最新价</small><strong class="watch-price ${details.change === null ? 'neutral' : color(details.change)}">${watchPriceHtml(item, details)}</strong><small>日涨跌</small><strong class="watch-change ${details.change === null ? 'neutral' : color(details.change)}">${changeText}</strong>${extendedQuote}</div></div></article>`;
  }).join('') : '<p class="watch-empty">暂无可显示持仓</p>';
}
function setWatchMode(active) {
  watchModeActive = active;
  document.querySelector('#watch-mode').hidden = !active;
  document.querySelector('#holding-detail-standard').hidden = active;
  const button = document.querySelector('#watch-mode-toggle');
  button.setAttribute('aria-label', active ? '切换到持仓模式' : '切换到行情模式');
  button.title = button.getAttribute('aria-label');
  if (active) renderWatchRows();
}
function renderFilteredViews() {
  renderFilters();
  renderDetailFilters();
  renderHoldingRows();
  renderWatchRows();
  renderSummary();
  renderAllocationChart();
  renderTrendPanel();
  requestAnimationFrame(flushLiveQuoteFlashes);
}
function renderSortControls() {
  document.querySelector('#mobile-sort-key').value = sortKey;
  const directionButton = document.querySelector('#mobile-sort-direction');
  directionButton.textContent = sortDirection === -1 ? '↓' : '↑';
  directionButton.setAttribute('aria-label', sortDirection === -1 ? '当前从高到低，点击改为从低到高' : '当前从低到高，点击改为从高到低');
  directionButton.title = directionButton.getAttribute('aria-label');
}
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
function realizedTrades() {
  return Array.isArray(portfolio.realizedTrades) ? portfolio.realizedTrades : [];
}
function manualRealizedProfitForHistory() {
  return realizedTrades()
    .filter(trade => trade.kind === 'SELL' && !trade.transactionId)
    .reduce((sum, trade) => sum + Number(trade.realizedProfitJPY || 0), 0);
}
function historicalProfitIncludingManualRealized(baseProfit) {
  return Number(baseProfit || 0) + manualRealizedProfitForHistory();
}
async function savePortfolioData(data) {
  if (localPortfolioMode) {
    writeLocalPortfolio(data);
    if (!localProfileToken) return data;
    localStorage.setItem(localPortfolioPendingKey, '1');
    const saved = withPreservedHistory(await writeProfilePortfolio(data), data, portfolio);
    writeLocalPortfolio(saved);
    localStorage.removeItem(localPortfolioPendingKey);
    return saved;
  }
  const response = await apiFetch('/api/portfolio', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(portfolioSavePayload(data))
  });
  const result = await response.json();
  if (!response.ok || result.error) throw new Error(result.error || '保存失败');
  return withPreservedHistory(result, data, portfolio);
}
function enqueueInvestmentPlanOperation(operation) {
  const next = investmentPlanOperationQueue.then(operation, operation);
  investmentPlanOperationQueue = next.catch(() => {});
  return next;
}
async function persistInvestmentPlan(value, showConfirmation = false) {
  const investmentPlan = String(value || '').trim();
  if (!portfolio || !investmentPlan) return false;
  if (
    investmentPlan === String(portfolio.investmentPlan || '').trim()
    && localStorage.getItem(investmentPlanDraftKey) === null
  ) return true;
  const revision = ++investmentPlanSaveRevision;
  try {
    const saved = await enqueueInvestmentPlanOperation(() => savePortfolioData({ ...portfolio, investmentPlan }));
    if (revision !== investmentPlanSaveRevision) return false;
    portfolio = { ...saved, investmentPlan };
    const input = document.querySelector('#investment-plan');
    if (input.value.trim() === investmentPlan) localStorage.removeItem(investmentPlanDraftKey);
    if (showConfirmation) document.querySelector('#notice').textContent = '投资计划已保存。';
    return true;
  } catch (error) {
    if (revision === investmentPlanSaveRevision) {
      document.querySelector('#notice').textContent = `投资计划保存失败，草稿已保留：${error.message}`;
    }
    return false;
  }
}
function scheduleInvestmentPlanSave() {
  const input = document.querySelector('#investment-plan');
  localStorage.setItem(investmentPlanDraftKey, input.value);
  clearTimeout(investmentPlanSaveTimer);
  investmentPlanSaveTimer = setTimeout(() => {
    investmentPlanSaveTimer = null;
    void persistInvestmentPlan(input.value);
  }, 700);
}
function resizeInvestmentPlanInput() {
  const input = document.querySelector('#investment-plan');
  if (!input) return;
  input.style.height = 'auto';
  input.style.height = `${Math.max(220, input.scrollHeight)}px`;
}
async function refreshPortfolioData(data = portfolio) {
  if (temporaryQuoteBridge && localPortfolioMode) {
    const quoteRequest = {
      holdings: (data.holdings || []).filter(item => !item.archived).map(item => ({
        id: item.id,
        name: item.name,
        symbol: item.symbol,
        fundId: item.fundId || null,
        market: item.market,
        autoQuote: true,
        quoteSource: item.quoteSource || null
      }))
    };
    const response = await fetch('/api/test-quotes', {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(quoteRequest)
    });
    const result = await response.json();
    if (!response.ok || result.error) throw new Error(result.error || '行情暂未更新');
    const refreshedPortfolio = mergeLivePatchIntoData(data, result.portfolio || result);
    writeLocalPortfolio(refreshedPortfolio);
    return { portfolio: refreshedPortfolio, errors: result.errors || [] };
  }
  if (cloudDeployment) {
    const requestPatch = () => fetchLiveQuotePatch();
    const patch = localProfileToken
      ? await enqueueProfileOperation(requestPatch)
      : await requestPatch();
    const refreshedPortfolio = mergeLivePatchIntoData(data, patch);
    if (localPortfolioMode) {
      writeLocalPortfolio(refreshedPortfolio);
      localStorage.removeItem(localPortfolioPendingKey);
    }
    return { portfolio: refreshedPortfolio, errors: patch.errors || [] };
  }
  const refreshPath = localPortfolioMode && localProfileToken
    ? profileApiUrl('/api/profile-refresh')
    : localPortfolioMode ? '/api/local-refresh' : '/api/refresh';
  const requestRefresh = async () => {
    const response = await apiFetch(refreshPath, {
      method: 'POST',
      ...(localPortfolioMode && !localProfileToken ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : {})
    });
    return { response, result: await response.json() };
  };
  const { response, result } = localProfileToken
    ? await enqueueProfileOperation(requestRefresh)
    : await requestRefresh();
  if (!response.ok || result.error) throw new Error(result.error || '行情刷新失败');
  if (localPortfolioMode) {
    writeLocalPortfolio(result.portfolio);
    localStorage.removeItem(localPortfolioPendingKey);
  }
  return result;
}
function renderReturns() {
  const trades = realizedTrades();
  const realizedProfit = trades.reduce((sum, trade) => sum + Number(trade.realizedProfitJPY || 0), 0);
  const holdingMetrics = activeHoldings().map(metrics);
  const totalAssets = holdingMetrics.reduce((sum, holding) => sum + holding.valueJPY, 0);
  const historyReady = historyMetricsReady();
  const fullPerformance = historyReady
    ? portfolioTimeWeightedPerformance(false, totalAssets)
    : { profit: null, annualizedRate: null };
  const historicalProfit = historyReady
    ? historicalProfitIncludingManualRealized(fullPerformance.profit)
    : null;
  const annualized = fullPerformance.annualizedRate;
  document.querySelector('#returns-total').textContent = yen.format(totalAssets);
  document.querySelector('#returns-annualized').textContent = !historyReady ? '读取中…' : annualized === null ? '—' : `${annualized.toFixed(2)}%`;
  document.querySelector('#returns-annualized').className = annualized === null ? 'neutral' : color(annualized);
  [['#realized-profit', realizedProfit], ['#historical-profit', historicalProfit]].forEach(([selector, value]) => {
    const element = document.querySelector(selector);
    const pending = selector === '#historical-profit' && !historyReady;
    element.textContent = pending ? '读取中…' : `${sign(value)}${yen.format(value)}`;
    element.className = pending ? 'neutral' : color(value);
  });
  document.querySelector('#holding-names').innerHTML = [...new Set(activeHoldings().map(item => item.name))].map(name => `<option value="${escapeHtml(name)}"></option>`).join('');
  const dateInput = document.querySelector('#realized-date');
  if (!dateInput.value) dateInput.value = new Date().toISOString().slice(0, 10);
  const sortedTrades = [...trades].sort((left, right) => String(right.date).localeCompare(String(left.date)) || String(right.createdAt || '').localeCompare(String(left.createdAt || '')));
  document.querySelector('#realized-records').innerHTML = sortedTrades.length ? sortedTrades.map(trade => {
    const dividend = trade.kind === 'DIVIDEND';
    return `<article class="realized-record"><div class="realized-record-head"><div><strong>${escapeHtml(trade.name)}</strong><span>${escapeHtml(trade.date)}</span></div><button data-realized-delete="${escapeHtml(trade.id)}">删除</button></div><div class="realized-record-values"><div><span>${dividend ? '分红入账' : '卖出金额'}</span><strong>${yen.format(Number(trade.proceedsJPY || 0))}</strong></div><div><span>${dividend ? '分红收益' : '实现盈亏'}</span><strong class="${color(Number(trade.realizedProfitJPY || 0))}">${sign(Number(trade.realizedProfitJPY || 0))}${yen.format(Number(trade.realizedProfitJPY || 0))}</strong></div></div>${trade.note ? `<p>${escapeHtml(trade.note)}</p>` : ''}</article>`;
  }).join('') : '<p class="empty-realized">尚无收益记录</p>';
  document.querySelectorAll('[data-realized-delete]').forEach(button => button.addEventListener('click', async () => {
    const trade = realizedTrades().find(item => item.id === button.dataset.realizedDelete);
    if (!window.confirm(`确定删除“${trade?.name || '该标的'}”的收益记录吗？`)) return;
    button.disabled = true;
    try {
      const nextPortfolio = { ...portfolio, realizedTrades: realizedTrades().filter(trade => trade.id !== button.dataset.realizedDelete) };
      const result = await savePortfolioData(nextPortfolio);
      render(result);
      document.querySelector('#notice').textContent = '收益记录已删除。';
    } catch (error) {
      button.disabled = false;
      document.querySelector('#notice').textContent = `删除失败：${error.message}`;
    }
  }));
}
function render(data) {
  const investmentPlanInput = document.querySelector('#investment-plan');
  const storedInvestmentPlanDraft = localStorage.getItem(investmentPlanDraftKey);
  const originalInvestmentPlan = String(data.investmentPlan || defaultInvestmentPlan).trim();
  const upgradedInvestmentPlan = investmentPlanWithOwnerPolicy(originalInvestmentPlan);
  const shouldPersistInvestmentPlanUpgrade = storedInvestmentPlanDraft === null && upgradedInvestmentPlan !== originalInvestmentPlan;
  const hasInvestmentPlanDraft = Boolean(
    storedInvestmentPlanDraft !== null
    || (portfolio && investmentPlanInput && investmentPlanInput.value !== String(portfolio.investmentPlan || defaultInvestmentPlan))
  );
  normalizePortfolioLedger(data);
  data.investmentPlan = upgradedInvestmentPlan;
  portfolio = data;
  const fxRate = data.fx?.USDJPY;
  document.querySelector('#fx-rate').textContent = fxRate?.price ? `USD/JPY 实时汇率 · ${number.format(fxRate.price)}` : 'USD/JPY 实时汇率 · —';
  document.querySelector('#account-start-date').value = data.accountStartDate || '';
  if (storedInvestmentPlanDraft !== null) {
    investmentPlanInput.value = storedInvestmentPlanDraft;
    if (investmentPlanSaveTimer === null) scheduleInvestmentPlanSave();
  }
  else if (!hasInvestmentPlanDraft && document.activeElement !== investmentPlanInput) investmentPlanInput.value = data.investmentPlan;
  if (shouldPersistInvestmentPlanUpgrade) {
    investmentPlanInput.value = data.investmentPlan;
    localStorage.setItem(investmentPlanDraftKey, data.investmentPlan);
    if (investmentPlanSaveTimer === null) scheduleInvestmentPlanSave();
  }
  resizeInvestmentPlanInput();
  renderFilters();
  renderDetailFilters();
  renderHoldingRows(data);
  renderWatchRows(data);
  renderSummary();
  renderCharts();
  renderCalendar();
  renderEditor();
  renderSortControls();
  renderReturns();
  requestAnimationFrame(flushLiveQuoteFlashes);
}
function renderLiveUpdate() {
  const fxRate = portfolio.fx?.USDJPY;
  document.querySelector('#fx-rate').textContent = fxRate?.price ? `USD/JPY 实时汇率 · ${number.format(fxRate.price)}` : 'USD/JPY 实时汇率 · —';
  renderHoldingRows(portfolio);
  renderWatchRows(portfolio);
  renderSummary();
  renderCalendar();
  requestAnimationFrame(flushLiveQuoteFlashes);
}
function scheduleLiveRender() {
  if (!canRenderLiveQuotes()) {
    pendingLiveRender = true;
    return;
  }
  if (liveRenderTimer) return;
  const delay = Math.max(0, 900 - (Date.now() - lastLiveRenderAt));
  liveRenderTimer = setTimeout(() => {
    liveRenderTimer = null;
    if (!canRenderLiveQuotes()) {
      pendingLiveRender = true;
      return;
    }
    pendingLiveRender = false;
    lastLiveRenderAt = Date.now();
    renderLiveUpdate();
  }, delay);
}
async function fetchLiveQuotePatch() {
  if (!cloudDeployment || (localPortfolioMode && !localProfileToken)) return null;
  if (localPortfolioMode) {
    const response = await fetch(cacheBustedUrl(profileApiUrl('/api/profile-live-quotes')), {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    const patch = await response.json();
    if (!response.ok || patch.error) throw new Error(patch.error || '实时行情加载失败');
    return patch;
  }
  const response = await apiFetch(`/api/live-quotes?_=${Date.now()}`, { cache: 'no-store' });
  const patch = await response.json();
  if (!response.ok || patch.error) throw new Error(patch.error || '实时行情加载失败');
  return patch;
}
function mergeLiveHistoryIntoData(data, patch) {
  const records = Array.isArray(patch.recentHistory) ? [...patch.recentHistory] : [];
  if (patch.currentHistory) records.push(patch.currentHistory);
  if (!records.length) return false;
  const byDate = new Map((data.history || []).map(item => [item.date, item]));
  for (const record of records) {
    if (!record?.date) continue;
    liveHistoryOverrides.set(record.date, record);
    byDate.set(record.date, record);
  }
  data.history = [...byDate.values()].sort((left, right) => String(left.date).localeCompare(String(right.date)));
  latestLiveHistory = data.history.at(-1) || null;
  return true;
}
function mergeLivePatchIntoData(data, patch) {
  if (!data?.holdings || !patch) return data;
  const byId = new Map((patch.holdings || []).filter(item => item.id).map(item => [item.id, item]));
  const byKey = new Map((patch.holdings || []).map(item => [`${item.name || ''}\u0000${item.symbol || ''}`, item]));
  const byName = new Map((patch.holdings || []).filter(item => item.name).map(item => [item.name, item]));
  data.holdings.forEach(holding => {
    const update = byId.get(holding.id) || byKey.get(`${holding.name || ''}\u0000${holding.symbol || ''}`);
    const liveUpdate = update || byName.get(holding.name);
    if (!liveUpdate) return;
    if (liveUpdate.quote) holding.quote = mergeLiveQuote(holding.quote, liveUpdate.quote);
    if (liveUpdate.quoteSource) holding.quoteSource = liveUpdate.quoteSource;
    if (Object.prototype.hasOwnProperty.call(liveUpdate, 'symbol')) holding.symbol = liveUpdate.symbol;
    if (liveUpdate.quoteUpdatedAt) holding.quoteUpdatedAt = liveUpdate.quoteUpdatedAt;
    if (liveUpdate.quoteStatus) holding.quoteStatus = liveUpdate.quoteStatus;
  });
  if (patch.fx) data.fx = patch.fx;
  if (patch.quoteHealth) data.quoteHealth = patch.quoteHealth;
  if (patch.lastRefreshAt) data.lastRefreshAt = patch.lastRefreshAt;
  mergeLiveHistoryIntoData(data, patch);
  data.quoteErrors = patch.errors || [];
  if (patch.profileRevision != null) data._profileRevision = patch.profileRevision;
  if (patch.profileSavedAt) data._profileSavedAt = patch.profileSavedAt;
  return data;
}
function applyInitialLivePatchInBackground(request) {
  if (!request) return;
  void Promise.resolve(request).then(patch => {
    if (!patch || !portfolio) return;
    mergeLivePatchIntoData(portfolio, patch);
    renderLiveUpdate();
    if (trendView === 'trend') renderTrendChart();
  }).catch(() => {});
}
async function load() {
  const privacyMigrationKey = 'portfolioLedgerTestPrivacyV1';
  if (temporaryQuoteBridge && localPortfolioMode && !localProfileToken && localStorage.getItem(privacyMigrationKey) !== '1') {
    const existing = readLocalPortfolio();
    const plan = String(existing.investmentPlan || '');
    if (['TSLA、SpaceX', 'FANG+：40,000', '住友商事持股会（8053）'].some(marker => plan.includes(marker))) {
      writeLocalPortfolio({ ...existing, investmentPlan: defaultInvestmentPlan });
    }
    localStorage.removeItem(investmentPlanDraftKey);
    localStorage.setItem(privacyMigrationKey, '1');
  }
  if (localPortfolioMode && !localProfileToken && queryParameters.get('resetHoldings') === '1') {
    const existing = readLocalPortfolio();
    writeLocalPortfolio({
      ...existing,
      holdings: [],
      transactions: [],
      realizedTrades: [],
      history: [],
      importBatches: [],
      positionAdjustments: [],
      lastRefreshAt: null,
      totalAssetsJPY: 0
    });
    localStorage.removeItem(localPortfolioPendingKey);
    const cleanedUrl = new URL(location.href);
    cleanedUrl.searchParams.delete('resetHoldings');
    history.replaceState(null, '', cleanedUrl);
  }
  const primeLiveQuotes = cloudDeployment && !Array.isArray(portfolio?.holdings);
  const initialLivePatchRequest = primeLiveQuotes ? fetchLiveQuotePatch().catch(() => null) : null;
  if (localPortfolioMode) {
    const localData = readLocalPortfolio();
    if (!localProfileToken) {
      render(localData);
      return;
    }
    const initialHistoryRequest = cloudDeployment && !historyHydrated ? fetchPortfolioHistory() : null;
    try {
      if (localStorage.getItem(localPortfolioPendingKey) === '1' && portfolioHasContent(localData)) {
        const saved = withPreservedHistory(await writeProfilePortfolio(localData), portfolio, localData);
        const readyData = withPreservedHistory(saved, portfolio, localData);
        writeLocalPortfolio(readyData);
        localStorage.removeItem(localPortfolioPendingKey);
        render(readyData);
        applyInitialLivePatchInBackground(initialLivePatchRequest);
        hydrateInitialHistoryInBackground(initialHistoryRequest);
        return;
      }
      const remoteCore = await readProfilePortfolio();
      const remoteData = withPreservedHistory(remoteCore, portfolio, localData);
      if (remoteData && (portfolioHasContent(remoteData) || !portfolioHasContent(localData))) {
        writeLocalPortfolio(remoteData);
        render(remoteData);
        applyInitialLivePatchInBackground(initialLivePatchRequest);
        hydrateInitialHistoryInBackground(initialHistoryRequest);
      } else {
        render(localData);
        applyInitialLivePatchInBackground(initialLivePatchRequest);
        hydrateInitialHistoryInBackground(initialHistoryRequest);
        if (portfolioHasContent(localData)) {
          const saved = withPreservedHistory(await writeProfilePortfolio(localData), portfolio, localData);
          writeLocalPortfolio(saved);
          render(saved);
        }
      }
    } catch (error) {
      if (initialHistoryRequest) await initialHistoryRequest.catch(() => null);
      if (portfolioHasContent(localData)) {
        render(localData);
        document.querySelector('#notice').textContent = `暂时无法同步朋友数据，已显示本机上次数据：${error.message}`;
        return;
      }
      document.querySelector('#notice').textContent = `朋友数据加载失败，请重新打开完整链接：${error.message}`;
      throw error;
    }
    return;
  }
  const initialHistoryRequest = cloudDeployment && !historyHydrated ? fetchPortfolioHistory() : null;
  const endpoint = cloudDeployment ? '/api/portfolio-core' : '/api/portfolio';
  const response = await apiFetch(endpoint);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '无法读取持仓数据');
  const readyData = withPreservedHistory(data, portfolio);
  render(readyData);
  applyInitialLivePatchInBackground(initialLivePatchRequest);
  hydrateInitialHistoryInBackground(initialHistoryRequest);
}
async function ensurePortfolioLoaded() {
  if (Array.isArray(portfolio?.holdings)) return portfolio;
  if (localPortfolioMode) {
    portfolio = readLocalPortfolio();
    return portfolio;
  }
  const response = await apiFetch('/api/portfolio');
  const data = await response.json();
  if (!response.ok || data.error) {
    const message = data.error === '需要访问口令'
      ? '需要用带访问口令的完整链接打开看板后再导入'
      : data.error || '无法读取现有持仓';
    throw new Error(message);
  }
  portfolio = data;
  return data;
}
function managementPanelIsOpen() {
  return ['editor', 'settings', 'data-transfer', 'returns'].some(id => !document.querySelector(`#${id}`).hidden);
}
function canRenderLiveQuotes() {
  const investmentPlanInput = document.querySelector('#investment-plan');
  const hasInvestmentPlanDraft = investmentPlanInput.value !== String(portfolio?.investmentPlan || defaultInvestmentPlan);
  return !document.hidden && !managementPanelIsOpen() && document.activeElement !== investmentPlanInput && !hasInvestmentPlanDraft;
}
function priceMovement(previousPrice, nextPrice) {
  const previous = Number(previousPrice);
  const next = Number(nextPrice);
  if (!Number.isFinite(previous) || !Number.isFinite(next) || previous === next) return 0;
  return next > previous ? 1 : -1;
}
function restartFlash(element, className) {
  if (!element) return;
  element.classList.remove('quote-flash-up', 'quote-flash-down', 'fx-flash-up', 'fx-flash-down');
  void element.offsetWidth;
  element.classList.add(className);
  setTimeout(() => element.classList.remove(className), 900);
}
function flushLiveQuoteFlashes() {
  pendingHoldingFlashes.forEach((movement, holdingId) => {
    const row = [...document.querySelectorAll('#rows tr')].find(item => item.dataset.holdingId === holdingId);
    restartFlash(row, movement > 0 ? 'quote-flash-up' : 'quote-flash-down');
    const watchRow = [...document.querySelectorAll('#watch-rows .watch-row')].find(item => item.dataset.holdingId === holdingId);
    restartFlash(watchRow, movement > 0 ? 'quote-flash-up' : 'quote-flash-down');
  });
  pendingHoldingFlashes.clear();
  if (pendingFxFlash) {
    restartFlash(document.querySelector('#fx-rate'), pendingFxFlash > 0 ? 'fx-flash-up' : 'fx-flash-down');
    pendingFxFlash = 0;
  }
}
const extendedQuoteKeys = ['extendedPrice', 'extendedSession', 'extendedMarketTime', 'extendedChangePct', 'extendedReceivedAt'];
function mergeLiveQuote(previousQuote = {}, nextQuote = {}) {
  const merged = { ...previousQuote, ...nextQuote };
  const nextSession = nextQuote.marketSession;
  const nextExtendedSession = nextQuote.extendedSession;
  if (nextExtendedSession === 'pre' || nextExtendedSession === 'post') return merged;
  if (nextSession === 'regular' || ((nextSession === 'pre' || nextSession === 'post') && previousQuote.extendedSession !== nextSession)) {
    extendedQuoteKeys.forEach(key => delete merged[key]);
  }
  return merged;
}
function applyLiveQuotePatch(patch) {
  if (!portfolio?.holdings || !patch) return;
  const nextFxPrice = patch.fx?.USDJPY?.price;
  pendingFxFlash = priceMovement(portfolio.fx?.USDJPY?.price, nextFxPrice) || pendingFxFlash;
  const byId = new Map((patch.holdings || []).filter(item => item.id).map(item => [item.id, item]));
  const byKey = new Map((patch.holdings || []).map(item => [`${item.name || ''}\u0000${item.symbol || ''}`, item]));
  const byName = new Map((patch.holdings || []).filter(item => item.name).map(item => [item.name, item]));
  portfolio.holdings.forEach(holding => {
    const update = byId.get(holding.id) || byKey.get(`${holding.name || ''}\u0000${holding.symbol || ''}`);
    const resolvedUpdate = update || byName.get(holding.name);
    if (!resolvedUpdate) return;
    const liveUpdate = resolvedUpdate;
    const movement = priceMovement(
      holding.quote?.extendedPrice ?? holding.quote?.price,
      liveUpdate.quote?.extendedPrice ?? liveUpdate.quote?.price
    );
    if (movement) pendingHoldingFlashes.set(holding.id, movement);
    if (liveUpdate.quote) holding.quote = mergeLiveQuote(holding.quote, liveUpdate.quote);
    if (liveUpdate.quoteSource) holding.quoteSource = liveUpdate.quoteSource;
    if (Object.prototype.hasOwnProperty.call(liveUpdate, 'symbol')) holding.symbol = liveUpdate.symbol;
    if (liveUpdate.quoteUpdatedAt) holding.quoteUpdatedAt = liveUpdate.quoteUpdatedAt;
    if (liveUpdate.quoteStatus) holding.quoteStatus = liveUpdate.quoteStatus;
  });
  if (patch.fx) portfolio.fx = patch.fx;
  if (patch.quoteHealth) portfolio.quoteHealth = patch.quoteHealth;
  if (patch.lastRefreshAt) portfolio.lastRefreshAt = patch.lastRefreshAt;
  if (mergeLiveHistoryIntoData(portfolio, patch)) {
    renderCalendar();
  }
  portfolio.quoteErrors = patch.errors || [];
  if (localPortfolioMode && localProfileToken) {
    if (patch.profileRevision != null) portfolio._profileRevision = patch.profileRevision;
    if (patch.profileSavedAt) portfolio._profileSavedAt = patch.profileSavedAt;
    writeLocalPortfolio(portfolio);
  }
  lastLiveEventAt = Date.now();
  scheduleLiveRender();
}
function connectLiveQuotes() {
  if (cloudDeployment || localPortfolioMode || !globalThis.EventSource || liveQuoteStream) return;
  liveQuoteStream = new EventSource(authenticatedUrl('/api/stream'));
  liveQuoteStream.addEventListener('quotes', event => {
    try {
      applyLiveQuotePatch(JSON.parse(event.data));
    } catch {}
  });
  liveQuoteStream.onerror = () => {
    if (liveQuoteStream?.readyState === EventSource.CLOSED) liveQuoteStream = null;
  };
}
async function pollLiveQuotes() {
  if (liveQuotePollActive || document.hidden || managementPanelIsOpen()) return;
  if (localPortfolioMode && !localProfileToken) return;
  if (lastLiveEventAt && Date.now() - lastLiveEventAt < 4500) return;
  liveQuotePollActive = true;
  try {
    const requestQuotes = () => fetch(cacheBustedUrl(profileApiUrl('/api/profile-live-quotes')), {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    const response = localPortfolioMode
      ? await enqueueProfileOperation(requestQuotes)
      : await apiFetch(`/api/live-quotes?_=${Date.now()}`, { cache: 'no-store' });
    const patch = await response.json();
    if (response.ok && !patch.error) applyLiveQuotePatch(patch);
    else if (patch.portfolio && localPortfolioMode) {
      writeLocalPortfolio(patch.portfolio);
      render(patch.portfolio);
    }
  } catch {
  } finally {
    liveQuotePollActive = false;
  }
}
function syncPortfolio(force = false) {
  if (!force && lastLiveEventAt && Date.now() - lastLiveEventAt < 45000) return;
  const investmentPlanInput = document.querySelector('#investment-plan');
  const hasInvestmentPlanDraft = investmentPlanInput.value !== String(portfolio?.investmentPlan || defaultInvestmentPlan);
  if (document.hidden || managementPanelIsOpen() || document.activeElement === investmentPlanInput || hasInvestmentPlanDraft) return;
  load().catch(() => {});
}
function closeManagementPanels() {
  const panels = ['settings', 'editor', 'data-transfer', 'returns'].map(id => document.querySelector(`#${id}`));
  const editor = document.querySelector('#editor');
  if (!editor.hidden) {
    portfolio.holdings = cloneHoldings(editorBaselineHoldings);
    renderEditor();
  }
  panels.forEach(panel => { panel.hidden = true; });
}
function toggleManagementPanel(targetId) {
  const target = document.querySelector(`#${targetId}`);
  const shouldOpen = target.hidden;
  closeManagementPanels();
  if (shouldOpen) target.hidden = false;
}
const markdownCell = value => String(value ?? '').replace(/\|/g, '／').replace(/\r?\n/g, ' ').trim();
async function copyText(text) {
  let clipboardError = null;
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (error) {
      clipboardError = error;
    }
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '0';
  textarea.setAttribute('readonly', '');
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) throw clipboardError || new Error('浏览器未允许访问剪贴板，请刷新页面后重试');
}
function holdingsMarkdown(holdings = activeHoldings()) {
  const header = '| 名称 | 代码 | 市场 | 口座 | 当前市值JPY | 累计盈亏JPY | 收益率 | 买入价JPY | 数量 |\n|---|---|---|---|---:|---:|---:|---:|---:|';
  const rows = holdings.map(item => {
    const value = metrics(item);
    return `| ${markdownCell(item.name)} | ${markdownCell(item.symbol)} | ${item.market === 'US' ? 'US' : 'JP'} | ${markdownCell(item.account || '未设置')} | ${markdownCell(Math.round(value.valueJPY))} | ${markdownCell(Math.round(value.profitJPY))} | ${markdownCell(`${value.profitPct.toFixed(2)}%`)} | ${markdownCell(item.buyPrice ?? item.avgCost)} | ${markdownCell(item.units)} |`;
  });
  return `${header}\n${rows.join('\n')}`;
}
function quoteDisplay(item) {
  if (!item.quote?.price) return '—';
  const unit = item.quote.currency === 'JPY/g' ? 'JPY/g' : item.fundId ? 'JPY/万口' : item.quote.currency;
  return `${preciseNumber.format(item.quote.price)} ${unit || ''}`.trim();
}
function extendedQuoteDetails(item) {
  const quote = item.quote || {};
  const extendedPrice = Number(quote.extendedPrice);
  const regularPrice = Number(quote.price);
  const units = Number(item.units);
  const fx = Number(portfolio.fx?.USDJPY?.price);
  if (item.market !== 'US' || !['pre', 'post'].includes(quote.extendedSession) || !Number.isFinite(extendedPrice) || !Number.isFinite(regularPrice)) return null;
  const changePct = Number.isFinite(Number(quote.extendedChangePct))
    ? Number(quote.extendedChangePct)
    : regularPrice ? (extendedPrice / regularPrice - 1) * 100 : 0;
  const estimatedJPY = Number.isFinite(units) && Number.isFinite(fx)
    ? (extendedPrice - regularPrice) * units * fx
    : null;
  return { label: quote.extendedSession === 'pre' ? '盘前' : '盘后', price: extendedPrice, changePct, estimatedJPY };
}
function extendedQuoteMetricHtml(item, metric) {
  const details = extendedQuoteDetails(item);
  if (!details) return '';
  if (metric === 'price') return `<small class="extended-quote-line ${color(details.changePct)}"><b>${details.label}</b>${number.format(details.price)}</small>`;
  if (metric === 'change') return `<small class="extended-quote-line ${color(details.changePct)}"><b>${details.label}</b>${sign(details.changePct)}${details.changePct.toFixed(2)}%</small>`;
  if (details.estimatedJPY === null) return '';
  return `<small class="extended-quote-line ${color(details.estimatedJPY)}"><b>${details.label}估算</b>${sign(details.estimatedJPY)}${yen.format(details.estimatedJPY)}</small>`;
}
function buildLatestHoldingsBlock() {
  const holdings = activeHoldings();
  const values = holdings.map(metrics);
  const total = values.reduce((sum, item) => sum + item.valueJPY, 0);
  const cost = values.reduce((sum, item) => sum + item.costJPY, 0);
  const profit = values.reduce((sum, item) => sum + item.profitJPY, 0);
  const dailyProfit = values.reduce((sum, item) => sum + (item.dailyJPY || 0), 0);
  const realizedProfit = realizedTrades().reduce((sum, trade) => sum + Number(trade.realizedProfitJPY || 0), 0);
  const historicalProfit = historicalProfitIncludingManualRealized(
    portfolioTimeWeightedPerformance(false, total).profit
  );
  const profitPct = cost ? profit / cost * 100 : 0;
  const rows = holdings.map(item => {
    const value = metrics(item);
    const change = dailyPercent(item);
    return `| ${markdownCell(item.name)} | ${markdownCell(item.symbol || '—')} | ${markdownCell(productType(item))} | ${markdownCell(item.account || '未设置')} | ${preciseNumber.format(item.units || 0)} | ${preciseNumber.format(item.buyPrice ?? item.avgCost ?? 0)} JPY | ${quoteDisplay(item)} | ${yen.format(value.valueJPY)} | ${sign(value.profitJPY)}${yen.format(value.profitJPY)} | ${sign(value.profitPct)}${value.profitPct.toFixed(2)}% | ${change === null ? '—' : `${sign(change)}${change.toFixed(2)}%`} | ${value.dailyJPY === null ? '—' : `${sign(value.dailyJPY)}${yen.format(value.dailyJPY)}`} |`;
  });
  const refreshedAt = portfolio.lastRefreshAt ? new Date(portfolio.lastRefreshAt).toLocaleString('ja-JP') : '尚未刷新';
  const fx = portfolio.fx?.USDJPY?.price;
  return `# 看板最新持仓（自动生成，优先级最高）

以下数据来自看板当前登记内容。若与前文示例、旧持仓或记忆冲突，必须以本区为准，不得自行补充或猜测。

- 生成时间：${new Date().toLocaleString('ja-JP')}
- 最后行情刷新：${refreshedAt}
- 账户开始日：${portfolio.accountStartDate || '未设置'}
- USD/JPY：${fx ? number.format(fx) : '—'}
- 当前总资产：${yen.format(total)}
- 当前持仓成本：${yen.format(cost)}
- 当前浮动盈亏：${sign(profit)}${yen.format(profit)}（${sign(profitPct)}${profitPct.toFixed(2)}%）
- 今日盈亏：${sign(dailyProfit)}${yen.format(dailyProfit)}
- 已实现收益：${sign(realizedProfit)}${yen.format(realizedProfit)}
- 历史累计收益：${sign(historicalProfit)}${yen.format(historicalProfit)}

| 名称 | 代码 | 商品种类 | 口座 | 数量 | 买入均价JPY | 最新价 | 市值JPY | 累计盈亏JPY | 收益率 | 日涨跌 | 今日盈亏JPY |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
${rows.join('\n')}

注意：最新价和今日数据对应“最后行情刷新”时间，不应被描述为晚于该时间的实时行情。投资计划必须以【当前投资计划】为准。`;
}
function buildInvestmentPlanBlock(investmentPlan = portfolio.investmentPlan || defaultInvestmentPlan) {
  return `# 当前投资计划（看板设置，优先级最高）

以下计划由用户在看板中维护。若与基础 Prompt 中的旧计划、示例或记忆冲突，必须以本区为准。

${String(investmentPlan || defaultInvestmentPlan).trim()}`;
}
function buildAnalysisRequest(investmentPlan) {
  return `${analysisPrompt.trim()}\n\n---\n\n${buildInvestmentPlanBlock(investmentPlan)}\n\n---\n\n${buildLatestHoldingsBlock()}`;
}
function buildImportPrompt() {
  return `你是我的持仓数据整理助手。请根据我随后提供的券商截图、持仓文字或账目，整理出完整、最新的持仓列表。\n\n严格要求：\n1. 只输出一个 Markdown 表格，不要解释，不要代码围栏，也不要向我提问。\n2. 表头必须严格为：名称、代码、市场、口座、当前市值JPY、累计盈亏JPY、收益率、买入价JPY、数量。\n3. 市场只能填写 US 或 JP；根据名称、代码和券商画面能够判断时直接填写。\n4. 美股代码填写标准 ticker；日股代码填写“证券代码.T”；基金和黄金代码留空。\n5. 能确认口座时填写 NISA、特定、持股会或黄金；无法确认时填写未设置，我会在导入后手动补充。\n6. 图片里显示的当前市值、累计盈亏金额和收益率必须原样填写，不得省略。盈利填正数，亏损填负数。\n7. 买入价JPY：股票填写每股平均买入成本（日元），基金填写每万口平均成本（日元），黄金填写每克平均成本（日元）。数量：股票填股数，基金填口数，黄金填克数。\n8. 必须优先进行计算，不要只因为截图没有直接写出数量和买入价就放弃。先计算总成本＝当前市值－累计盈亏；若只有收益率，则总成本＝当前市值÷（1＋收益率）。\n9. 然后尽最大可能取得每单位当前价格：优先读取截图里的当前价；截图未显示时，根据证券代码、截图日期和时间查询或识别同一时点最接近的公开行情。美股还要使用同一时点的 USD/JPY 换算成日元。不得使用明显不同时点的价格。\n10. 取得当前价格后必须继续反算：股票数量＝当前市值÷每股当前日元价格；基金口数＝当前市值÷每万口净值×10000；黄金克数＝当前市值÷每克当前日元价格。再计算平均买入价＝总成本÷数量；基金平均买入价＝总成本÷口数×10000。\n11. 股票数量优先校验为合理的整数或券商支持的小数股。用反算结果重新计算市值、盈亏金额和收益率，误差应尽量控制在截图舍入范围内；若明显不一致，重新检查价格时点、汇率和单位，不要随意填数。\n12. 只有在截图没有当前价、也确实无法取得对应时点行情时，买入价和数量才允许留空。即使有个别空项，也必须先输出完整表格，不得拒绝、不得追问。\n13. 不要把当前市值、累计盈亏或收益率误填进买入价或数量。\n14. 必须把图片中能够识别出的全部真实持仓列入表格；导入时系统会先比较差异，再新增、更新或归档，不会删除历史交易。\n\n输出模板：\n| 名称 | 代码 | 市场 | 口座 | 当前市值JPY | 累计盈亏JPY | 收益率 | 买入价JPY | 数量 |\n|---|---|---|---|---:|---:|---:|---:|---:|\n| AMD | AMD | US | 未设置 | 1052924 | 757688 | 256.63% | 21088.29 | 14 |\n| 无法确认数量的基金 |  | JP | 未设置 | 902527 | 212527 | 30.80% |  |  |\n\n下面是当前看板持仓，仅供名称和代码参考，请以我随后发送的真实持仓为准：\n${holdingsMarkdown()}`;
}
function splitMarkdownRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
}
function buildSanitizedImportPrompt() {
  return `你是持仓数据整理助手。请根据随后提供的券商截图、持仓文字或账目，整理出完整、最新的持仓列表。

严格要求：
1. 只输出一个 Markdown 表格，不要解释、不要代码围栏、不要提问。
2. 表头必须严格为：名称、代码、基金ID、市场、口座、当前市值JPY、累计盈亏JPY、收益率、买入价JPY、数量。
3. 市场只能填写 US 或 JP。股票代码填写标准 ticker 或“证券代码.T”；基金和黄金的代码留空。
4. 基金ID填写该产品可核验的正式 ISIN 或基金识别码；无法可靠确认时留空，禁止猜测。
5. 能确认口座时填写 NISA、特定、一般或黄金；无法确认时填写未设置。
6. 当前市值、累计盈亏金额和收益率必须按截图原样填写。盈利为正数，亏损为负数。
7. 总成本＝当前市值－累计盈亏；若只有收益率，总成本＝当前市值÷（1＋收益率）。亏损必须保留负号，例如市值250000、累计盈亏-10000时，总成本是260000而不是240000；收益率-4%时，总成本应高于市值。禁止对亏损取绝对值后直接相减。
8. 对日本投信必须先依据截图中的完整名称识别基金公司和唯一正式产品。必须区分同指数但不同公司的产品、普通版与 Slim／DC／iFree／ニッセイ等不同系列，禁止把指数点位、ETF 价格或其他同名基金净值当成本基金净值。
9. 识别基金后，查询截图估值日对应的官方基准价（每万口净值）。若截图没有日期，使用截图显示内容所对应的最近公布净值；不得用明显不同时点的数据。
10. 基金数量（口数）＝当前市值÷每万口净值×10000；基金买入价JPY（每万口平均成本）＝总成本÷口数×10000。计算后必须反算：买入价×口数÷10000＝总成本，当前市值－总成本＝累计盈亏；正负号和收益率必须与截图一致。
11. 股票数量＝当前市值÷同一时点每股日元价格；美股须使用同一时点 USD/JPY。黄金克数＝当前市值÷同一时点每克日元价格。平均买入价＝总成本÷数量。
12. 数量允许小数。不要因为券商使用碎股、基金口数或黄金克数就强制取整。
13. 只有在无法唯一识别产品、也无法取得对应时点单价时，买入价和数量才允许留空；其他列仍必须输出。
14. 不要把当前市值、累计盈亏或收益率误填进买入价或数量。
15. 必须包含图片中能识别出的全部真实持仓。

输出模板：
| 名称 | 代码 | 基金ID | 市场 | 口座 | 当前市值JPY | 累计盈亏JPY | 收益率 | 买入价JPY | 数量 |
|---|---|---|---|---|---:|---:|---:|---:|---:|
| 示例公司 | EXAMPLE |  | US | 未设置 | 500000 | 50000 | 11.11% | 30000 | 10 |
| 示例基金 |  | JP0000000000 | JP | 未设置 | 300000 | 20000 | 7.14% | 28000 | 100000 |`;
}
function canonicalImportedName(value) {
  const original = String(value || '').normalize('NFKC').trim();
  const compact = original.replace(/[\s・·（）()]/g, '').toUpperCase();
  if (/^(金|黄金|ゴールド)$/.test(original)) return '黄金';
  if (compact.includes('EMAXISSLIM') && (compact.includes('S&P500') || compact.includes('SP500') || compact.includes('米国株式'))) return 'eMAXIS Slim S&P500';
  if (compact.includes('IFREENEXT') && compact.includes('FANG+')) return 'FANG+（iFreeNEXT）';
  if (compact.includes('EMAXIS') && compact.includes('NASDAQ100')) return 'eMAXIS NASDAQ100';
  if (compact.includes('ニッセイ') && compact.includes('NASDAQ100')) return 'ニッセイNASDAQ100';
  return original;
}
function parseImportMarkdown(text) {
  if (text.includes('你是我的持仓数据整理助手')) throw new Error('你粘贴的是整理 Prompt，请粘贴 AI 最终返回的持仓表格');
  const lines = text.split(/\r?\n/);
  const headerIndex = lines.findIndex(line => line.includes('|') && /(名称|銘柄名)/.test(line) && /(数量|數量|保有数量|口数)/.test(line));
  if (headerIndex < 0) throw new Error('没有找到包含名称和数量的 Markdown 表格');
  const headers = splitMarkdownRow(lines[headerIndex]);
  const normalizedHeaders = headers.map(header => header.normalize('NFKC').replace(/\s/g, ''));
  const column = (...names) => normalizedHeaders.findIndex(header => names.some(name => header.startsWith(name)));
  const indexes = {
    name: column('名称', '銘柄名'),
    symbol: column('代码', '代碼', 'コード', '銘柄コード'),
    fundId: column('基金ID', 'ファンドID', 'ISIN'),
    market: column('市场', '市場', 'マーケット'),
    account: column('口座', '账户', '帳戶'),
    valueJPY: column('当前市值', '目前市值', '評価額', '時価評価額'),
    profitJPY: column('累计盈亏', '累計損益', '評価損益'),
    profitPct: column('收益率', '収益率', '損益率'),
    buyPrice: column('买入价', '買入価格', '平均取得価額', '取得単価'),
    units: column('数量', '數量', '保有数量', '保有口数', '口数'),
    autoQuote: column('自动报价', '自動報價', '自動取得')
  };
  if ([indexes.name, indexes.symbol, indexes.market, indexes.account, indexes.buyPrice, indexes.units].some(index => index < 0)) throw new Error('表头必须包含名称、代码、市场（或市場）、口座、买入价JPY、数量');
  const holdings = [];
  for (const line of lines.slice(headerIndex + 1)) {
    if (!line.includes('|')) {
      if (holdings.length) break;
      continue;
    }
    const cells = splitMarkdownRow(line);
    if (cells.every(cell => /^:?-{3,}:?$/.test(cell))) continue;
    const name = canonicalImportedName(cells[indexes.name]);
    if (!name) continue;
    if (/[<>]/.test(name)) throw new Error(`名称“${name}”包含不允许的字符`);
    const marketText = cells[indexes.market]?.trim().toUpperCase();
    const market = ['US', '美国', '美股'].includes(marketText) ? 'US' : ['JP', '日本', '日股'].includes(marketText) ? 'JP' : null;
    if (!market) throw new Error(`${name} 的市场必须是 US 或 JP`);
    const parseNumber = value => {
      let text = String(value ?? '').normalize('NFKC').trim();
      const negative = /^\(.*\)$/.test(text) || /^[▲△▼]/.test(text);
      text = text
        .replace(/^\((.*)\)$/, '$1')
        .replace(/^[▲△▼]/, '')
        .replace(/[−–—]/g, '-')
        .replace(/[￥¥,%％,\s]/g, '');
      const parsed = Number(text);
      return negative ? -Math.abs(parsed) : parsed;
    };
    const numericText = value => /^(?:|—|―|-|无|不明|未设置)$/i.test(String(value ?? '').normalize('NFKC').trim()) ? '' : String(value).trim();
    const buyPriceText = numericText(cells[indexes.buyPrice]);
    const unitsText = numericText(cells[indexes.units]);
    const valueText = indexes.valueJPY >= 0 ? String(cells[indexes.valueJPY] ?? '').trim() : '';
    const profitText = indexes.profitJPY >= 0 ? String(cells[indexes.profitJPY] ?? '').trim() : '';
    const profitPctText = indexes.profitPct >= 0 ? String(cells[indexes.profitPct] ?? '').trim() : '';
    const buyPrice = buyPriceText ? parseNumber(buyPriceText) : null;
    const units = unitsText ? parseNumber(unitsText) : null;
    const importedValueJPY = valueText ? parseNumber(valueText) : null;
    const importedProfitJPY = profitText ? parseNumber(profitText) : null;
    const importedProfitPct = profitPctText ? parseNumber(profitPctText) : null;
    if (buyPrice !== null && (!Number.isFinite(buyPrice) || buyPrice <= 0)) throw new Error(`${name} 的买入价无效，请留空或填写正数`);
    if (units !== null && (!Number.isFinite(units) || units <= 0)) throw new Error(`${name} 的数量无效，请留空或填写正数`);
    if (importedValueJPY !== null && (!Number.isFinite(importedValueJPY) || importedValueJPY < 0)) throw new Error(`${name} 的当前市值无效`);
    if (importedProfitJPY !== null && !Number.isFinite(importedProfitJPY)) throw new Error(`${name} 的累计盈亏无效`);
    if (importedProfitPct !== null && !Number.isFinite(importedProfitPct)) throw new Error(`${name} 的收益率无效`);
    let symbol = (cells[indexes.symbol] || '').trim().replace(/^(—|无)$/, '') || null;
    const fundId = indexes.fundId >= 0 ? (cells[indexes.fundId] || '').trim().replace(/^(—|无)$/, '') || null : null;
    if (market === 'JP' && /^\d{4}$/.test(symbol || '')) symbol = `${symbol}.T`;
    const accountText = (cells[indexes.account] || '').trim();
    const normalizedAccount = normalizeAccountType(accountText);
    const account = normalizedAccount === '未设置' ? null : normalizedAccount;
    if (account && !['NISA', '特定', '一般', '黄金'].includes(account)) throw new Error(`${name} 的口座不正确`);
    holdings.push({
      name, symbol, fundId, market, account,
      buyPrice, units, importedValueJPY, importedProfitJPY, importedProfitPct, autoQuote: true
    });
  }
  if (!holdings.length) throw new Error('表格中没有可导入的持仓');
  const keys = holdings.map(item => `${normalizeAccountType(item.account)}:${item.symbol?.toUpperCase() || ledgerText(item.name)}`);
  if (new Set(keys).size !== keys.length) throw new Error('表格中存在重复持仓');
  return holdings;
}
function importFingerprint(holdings) {
  const rows = holdings.map(item => [
    normalizeAccountType(item.account), String(item.market || '').toUpperCase(),
    String(item.symbol || '').toUpperCase(), String(item.fundId || '').toUpperCase(), ledgerText(item.name),
    item.buyPrice === null ? '' : Number(item.buyPrice).toFixed(6),
    item.units === null ? '' : Number(item.units).toFixed(6),
    item.importedValueJPY === null || item.importedValueJPY === undefined ? '' : Number(item.importedValueJPY).toFixed(2),
    item.importedProfitJPY === null || item.importedProfitJPY === undefined ? '' : Number(item.importedProfitJPY).toFixed(2),
    item.importedProfitPct === null || item.importedProfitPct === undefined ? '' : Number(item.importedProfitPct).toFixed(4)
  ].join('|')).sort();
  return ledgerHash(rows.join('\n'));
}
function importMatch(currentHoldings, imported) {
  const account = normalizeAccountType(imported.account);
  const accountUnknown = account === '未设置';
  const sameAccount = item => accountUnknown || normalizeAccountType(item.account) === account;
  if (imported.symbol) {
    const symbolMatches = currentHoldings.filter(item => sameAccount(item) && ledgerText(item.symbol) === ledgerText(imported.symbol));
    if (symbolMatches.length === 1) return symbolMatches[0];
  }
  const nameMatches = currentHoldings.filter(item => sameAccount(item) && ledgerText(item.name) === ledgerText(imported.name));
  return nameMatches.length === 1 ? nameMatches[0] : null;
}
function importedTotalCost(item) {
  const hasValue = item.importedValueJPY !== null && item.importedValueJPY !== undefined;
  const hasProfit = item.importedProfitJPY !== null && item.importedProfitJPY !== undefined;
  const hasProfitPct = item.importedProfitPct !== null && item.importedProfitPct !== undefined;
  const value = Number(item.importedValueJPY);
  const profit = Number(item.importedProfitJPY);
  const profitPct = Number(item.importedProfitPct);
  if (hasValue && hasProfit && Number.isFinite(value) && Number.isFinite(profit)) return value - profit;
  if (hasValue && hasProfitPct && Number.isFinite(value) && Number.isFinite(profitPct) && profitPct > -100) return value / (1 + profitPct / 100);
  return null;
}
function resolveHoldingImportEvidence(item, data) {
  const hasValue = item.importedValueJPY !== null && item.importedValueJPY !== undefined;
  const hasProfit = item.importedProfitJPY !== null && item.importedProfitJPY !== undefined;
  const hasProfitPct = item.importedProfitPct !== null && item.importedProfitPct !== undefined;
  const value = Number(item.importedValueJPY);
  const profit = Number(item.importedProfitJPY);
  const profitPct = Number(item.importedProfitPct);
  const totalCost = importedTotalCost(item);
  let changed = false;
  if (hasValue && Number.isFinite(value)) item.valueJPY = value;
  if (hasProfit && Number.isFinite(profit)) item.profitJPY = profit;
  if (hasProfitPct && Number.isFinite(profitPct)) item.profitPct = profitPct;
  const scale = unitScale(item);
  const fx = usesUsdQuote(item) ? Number(data.fx?.USDJPY?.price) : 1;
  const quotePrice = Number(item.quote?.price);
  const hasUsableQuote = Number.isFinite(quotePrice) && quotePrice > 0 && Number.isFinite(fx) && fx > 0;
  if (Number(item.units) > 0 && Number(item.buyPrice) > 0 && Number.isFinite(totalCost)) {
    const enteredCost = Number(item.units) * Number(item.buyPrice) / scale;
    const costTolerance = Math.max(500, Math.abs(totalCost) * 0.005);
    const enteredValue = hasUsableQuote ? Number(item.units) * quotePrice * fx / scale : null;
    const valueTolerance = Math.max(500, Math.abs(value) * 0.03);
    const valueMismatch = hasValue && Number.isFinite(value) && Number.isFinite(enteredValue)
      && Math.abs(enteredValue - value) > valueTolerance;
    if (valueMismatch) {
      item.units = value * scale / (quotePrice * fx);
      item.buyPrice = totalCost * scale / Number(item.units);
      changed = true;
    } else if (Math.abs(enteredCost - totalCost) > costTolerance) {
      item.buyPrice = totalCost * scale / Number(item.units);
      changed = true;
    }
  }
  if ((item.units === null || item.units === undefined) && Number.isFinite(totalCost) && Number(item.buyPrice) > 0) {
    item.units = totalCost * scale / Number(item.buyPrice);
    changed = true;
  }
  if ((item.units === null || item.units === undefined) && hasValue && Number.isFinite(value) && Number(item.quote?.price) > 0) {
    if (Number.isFinite(fx) && fx > 0) {
      item.units = value * scale / (Number(item.quote.price) * fx);
      changed = true;
    }
  }
  if ((item.buyPrice === null || item.buyPrice === undefined) && Number(item.units) > 0 && Number.isFinite(totalCost)) {
    item.buyPrice = totalCost * scale / Number(item.units);
    changed = true;
  }
  return changed;
}
function resolvePortfolioImportEvidence(data) {
  let resolved = 0;
  for (const item of data.holdings || []) {
    if (resolveHoldingImportEvidence(item, data)) resolved += 1;
  }
  return resolved;
}
function holdingImportMissingFields(item) {
  const missing = [];
  if (!item.account || normalizeAccountType(item.account) === '未设置') missing.push('口座');
  if (item.buyPrice === null || item.buyPrice === undefined || !(Number(item.buyPrice) > 0)) missing.push('买入价');
  if (item.units === null || item.units === undefined || !(Number(item.units) > 0)) missing.push('数量');
  return missing;
}
function incompleteHoldingsMessage(data) {
  const incomplete = (data.holdings || []).filter(item => !item.archived).map(item => ({ item, missing: holdingImportMissingFields(item) })).filter(entry => entry.missing.length);
  if (!incomplete.length) return '';
  const details = incomplete.slice(0, 5).map(({ item, missing }) => `${item.name}（缺${missing.join('、')}）`).join('；');
  const remainder = incomplete.length > 5 ? `；另有 ${incomplete.length - 5} 项` : '';
  return `部分持仓尚未完整登记：${details}${remainder}。请打开“编辑持仓”确认并补充。`;
}
function openImportReviewEditor(data) {
  importReviewFields = new Map((data.holdings || [])
    .filter(item => !item.archived)
    .map(item => {
      const missing = holdingImportMissingFields(item);
      const fields = new Set();
      if (missing.includes('口座')) fields.add('account');
      if (missing.includes('买入价')) fields.add('buyPrice');
      if (missing.includes('数量')) fields.add('units');
      return [item.id, fields];
    })
    .filter(([, fields]) => fields.size));
  if (!importReviewFields.size) return false;
  portfolio = data;
  setDashboardView('settings');
  editorBaselineHoldings = cloneHoldings(data.holdings);
  renderEditor();
  toggleManagementPanel('editor');
  requestAnimationFrame(() => {
    const first = document.querySelector('.import-needs-review');
    first?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    first?.focus({ preventScroll: true });
  });
  return true;
}
function buildImportPlan(currentPortfolio, importedHoldings) {
  normalizePortfolioLedger(currentPortfolio);
  const fingerprint = importFingerprint(importedHoldings);
  const duplicate = importFingerprint(currentPortfolio.holdings.filter(item => !item.archived)) === fingerprint;
  const matchedIds = new Set();
  const additions = [], updates = [], unchanged = [];
  const mergedActive = importedHoldings.map(imported => {
    const existing = importMatch(currentPortfolio.holdings, imported);
    if (!existing) {
      const created = {
        ...imported,
        id: ledgerUuid('position'),
        accountId: accountLedgerId(imported.account),
        instrumentId: instrumentLedgerId(imported),
        valueJPY: imported.importedValueJPY ?? 0,
        profitJPY: imported.importedProfitJPY ?? 0,
        profitPct: imported.importedProfitPct ?? 0,
        archived: false
      };
      additions.push({ after: created });
      return created;
    }
    matchedIds.add(existing.id);
    const resolved = {
      ...imported,
      account: imported.account ?? existing.account ?? null,
      fundId: imported.fundId ?? existing.fundId ?? null,
      buyPrice: imported.buyPrice ?? existing.buyPrice ?? existing.avgCost ?? null,
      units: imported.units ?? existing.units ?? null,
      importedValueJPY: imported.importedValueJPY ?? existing.importedValueJPY ?? null,
      importedProfitJPY: imported.importedProfitJPY ?? existing.importedProfitJPY ?? null,
      importedProfitPct: imported.importedProfitPct ?? existing.importedProfitPct ?? null
    };
    const symbolChanged = ledgerText(existing.symbol) !== ledgerText(resolved.symbol)
      || ledgerText(existing.fundId) !== ledgerText(resolved.fundId)
      || existing.market !== resolved.market;
    const changed = existing.archived
      || ledgerText(existing.name) !== ledgerText(resolved.name)
      || symbolChanged
      || normalizeAccountType(existing.account) !== normalizeAccountType(resolved.account)
      || Number(existing.buyPrice ?? existing.avgCost ?? 0) !== Number(resolved.buyPrice ?? 0)
      || Number(existing.units ?? 0) !== Number(resolved.units ?? 0)
      || (imported.importedValueJPY !== null && Number(existing.importedValueJPY) !== Number(imported.importedValueJPY))
      || (imported.importedProfitJPY !== null && Number(existing.importedProfitJPY) !== Number(imported.importedProfitJPY))
      || (imported.importedProfitPct !== null && Number(existing.importedProfitPct) !== Number(imported.importedProfitPct));
    const merged = {
      ...existing, ...resolved, archived: false,
      id: existing.id,
      accountId: accountLedgerId(resolved.account),
      instrumentId: symbolChanged ? instrumentLedgerId(resolved) : existing.instrumentId || instrumentLedgerId(resolved)
    };
    if (symbolChanged) {
      delete merged.quote;
      delete merged.quoteUpdatedAt;
      if (!resolved.fundId) delete merged.fundId;
      delete merged.quoteSource;
    }
    (changed ? updates : unchanged).push({ before: existing, after: merged });
    return merged;
  });
  const archived = currentPortfolio.holdings
    .filter(item => !item.archived && !matchedIds.has(item.id))
    .map(item => ({ before: item, after: { ...item, archived: true, archivedAt: new Date().toISOString() } }));
  const alreadyArchived = currentPortfolio.holdings.filter(item => item.archived && !matchedIds.has(item.id));
  mergedActive.forEach(item => resolveHoldingImportEvidence(item, currentPortfolio));
  const incomplete = mergedActive.filter(item => holdingImportMissingFields(item).length);
  return {
    fingerprint,
    duplicate: duplicate || (!additions.length && !updates.length && !archived.length),
    additions, updates, unchanged, archived, incomplete,
    holdings: [...mergedActive, ...archived.map(change => change.after), ...alreadyArchived]
  };
}
function previewImport() {
  try {
    const importedHoldings = parseImportMarkdown(document.querySelector('#import-markdown').value);
    const currentPortfolio = normalizePortfolioLedger(structuredClone(portfolio || { holdings: [], transactions: [] }));
    pendingImportHoldings = buildImportPlan(currentPortfolio, importedHoldings);
    const plan = pendingImportHoldings;
    document.querySelector('#import-preview').textContent = plan.duplicate
      ? '这份持仓已经导入过，没有需要重复处理的内容'
      : `差异：新增 ${plan.additions.length} · 更新 ${plan.updates.length} · 无变化 ${plan.unchanged.length} · 归档 ${plan.archived.length}${plan.incomplete.length ? ` · 待补充 ${plan.incomplete.length}（请在编辑持仓中确认）` : ''}`;
  } catch (error) {
    pendingImportHoldings = null;
    document.querySelector('#import-preview').textContent = `检查失败：${error.message}`;
  }
}
async function exportHoldings() {
  const markdown = holdingsMarkdown();
  const textarea = document.querySelector('#import-markdown');
  textarea.value = markdown;
  textarea.focus();
  textarea.select();
  pendingImportHoldings = null;
  document.querySelector('#import-preview').textContent = '当前持仓 Markdown 已生成，可直接检查或导入';
  await copyText(markdown);
  document.querySelector('#notice').textContent = '持仓 Markdown 已复制，并显示在导入框中。';
}
async function importHoldings() {
  previewImport();
  if (!pendingImportHoldings) return;
  if (pendingImportHoldings.duplicate) {
    document.querySelector('#notice').textContent = '相同持仓快照已经导入，无需重复保存。';
    return;
  }
  const plan = pendingImportHoldings;
  if (!localPortfolioMode && !window.confirm(`将新增 ${plan.additions.length}、更新 ${plan.updates.length}、归档 ${plan.archived.length} 条持仓。历史交易不会删除，确定继续吗？`)) return;
  const button = document.querySelector('#import-holdings');
  const preview = document.querySelector('#import-preview');
  const importedCount = plan.additions.length + plan.updates.length + plan.unchanged.length;
  button.disabled = true;
  button.textContent = '导入中…';
  preview.textContent = `正在导入 ${importedCount} 条持仓…`;
  try {
    const currentPortfolio = await ensurePortfolioLoaded();
    const latestPlan = buildImportPlan(currentPortfolio, parseImportMarkdown(document.querySelector('#import-markdown').value));
    if (latestPlan.duplicate) throw new Error('相同持仓快照已经导入');
    const now = new Date().toISOString();
    const changes = [...latestPlan.additions, ...latestPlan.updates, ...latestPlan.archived].map(change => ({
      id: ledgerUuid('adjustment'),
      batchFingerprint: latestPlan.fingerprint,
      holdingId: change.after.id,
      instrumentId: change.after.instrumentId,
      accountId: change.after.accountId,
      name: change.after.name,
      reason: 'PROMPT_RECONCILIATION',
      beforeUnits: change.before ? Number(change.before.units || 0) : 0,
      afterUnits: change.after.units === null ? null : Number(change.after.units),
      beforeBuyPrice: change.before ? Number(change.before.buyPrice ?? change.before.avgCost ?? 0) : 0,
      afterBuyPrice: change.after.buyPrice === null ? null : Number(change.after.buyPrice),
      archived: Boolean(change.after.archived),
      createdAt: now
    }));
    const importedPortfolio = {
      ...currentPortfolio,
      holdings: latestPlan.holdings,
      positionAdjustments: [...currentPortfolio.positionAdjustments, ...changes],
      importBatches: [...currentPortfolio.importBatches, {
        id: ledgerUuid('import'), fingerprint: latestPlan.fingerprint, source: 'prompt', createdAt: now,
        counts: { added: latestPlan.additions.length, updated: latestPlan.updates.length, unchanged: latestPlan.unchanged.length, archived: latestPlan.archived.length }
      }]
    };
    const saved = await savePortfolioData(importedPortfolio);
    const savedPortfolio = saved.portfolio || saved;
    render(savedPortfolio);
    preview.textContent = `已保存 ${importedCount} 条持仓，正在刷新行情…`;
    pendingImportHoldings = null;
    const initialIncompleteMessage = incompleteHoldingsMessage(savedPortfolio);
    if (!openImportReviewEditor(savedPortfolio)) {
      closeManagementPanels();
      setDashboardView('settings');
    }
    document.querySelector('#notice').textContent = initialIncompleteMessage || `已导入 ${importedCount} 条持仓，正在后台刷新行情。`;
    void refreshPortfolioData(savedPortfolio).then(async refreshed => {
      const resolvedCount = resolvePortfolioImportEvidence(refreshed.portfolio);
      const finalPortfolio = resolvedCount ? await savePortfolioData(refreshed.portfolio) : refreshed.portfolio;
      if (document.querySelector('#editor').hidden) render(finalPortfolio);
      else portfolio = finalPortfolio;
      const incompleteMessage = incompleteHoldingsMessage(finalPortfolio);
      document.querySelector('#notice').textContent = incompleteMessage || (refreshed.errors.length ? '持仓已保存；部分行情暂未更新，可稍后刷新页面重试。' : '持仓已完整导入并更新行情。');
    }).catch(refreshError => {
      const incompleteMessage = incompleteHoldingsMessage(savedPortfolio);
      document.querySelector('#notice').textContent = incompleteMessage || '持仓已保存；行情暂未更新，可稍后刷新页面重试。';
    });
  } catch (error) {
    preview.textContent = `导入失败：${error.message}`;
    document.querySelector('#notice').textContent = `导入失败：${error.message}`;
  } finally {
    button.disabled = false;
    button.textContent = '确认合并';
  }
}
if (localPortfolioMode) {
  globalThis.__ledgerTest = {
    parseImportMarkdown,
    buildImportPlan,
    normalizePortfolioLedger,
    importFingerprint
  };
}
function cloneHoldings(holdings) {
  return holdings.map(item => ({ ...item, quote: item.quote ? { ...item.quote } : item.quote }));
}
function collectEditorHoldings() {
  const holdings = cloneHoldings(portfolio.holdings);
  document.querySelectorAll('#editor-rows tr').forEach(row => {
    const item = holdings[Number(row.dataset.index)];
    const inputs = row.querySelectorAll('input,select');
    const previousName = item.name;
    const previousSymbol = item.symbol;
    const previousMarket = item.market;
    item.name = inputs[0].value.trim();
    item.symbol = inputs[1].value.trim().toUpperCase() || null;
    item.market = inputs[2].value;
    if (item.market === 'JP' && /^\d{4}$/.test(item.symbol || '')) item.symbol = `${item.symbol}.T`;
    item.account = inputs[3].value || null;
    item.accountId = accountLedgerId(item.account);
    item.buyPrice = inputs[4].value === '' ? null : Number(inputs[4].value);
    item.units = inputs[5].value === '' ? null : Number(inputs[5].value);
    item.autoQuote = true;
    if (item.name !== previousName || item.symbol !== previousSymbol || item.market !== previousMarket) {
      item.instrumentId = instrumentLedgerId({ ...item, instrumentId: null });
      delete item.quote;
      delete item.quoteUpdatedAt;
      delete item.quoteStatus;
      delete item.fundId;
      delete item.smbcFundCode;
      if (item.name !== '黄金') delete item.quoteSource;
    }
  });
  return holdings;
}
function holdingQuantityChanges(previousHoldings, nextHoldings) {
  const previous = new Map(previousHoldings.map(item => [item.id, item]));
  const next = new Map(nextHoldings.map(item => [item.id, item]));
  const changes = [];
  for (const id of new Set([...previous.keys(), ...next.keys()])) {
    const before = previous.get(id) || null;
    const after = next.get(id) || null;
    const oldUnits = Number(before?.units || 0);
    const newUnits = Number(after?.units || 0);
    const difference = newUnits - oldUnits;
    if (Math.abs(difference) < 1e-9) continue;
    changes.push({ id, before, after, oldUnits, newUnits, difference, holding: after || before });
  }
  return changes;
}
function defaultTransactionPrice(change) {
  const holding = change.holding;
  const scale = unitScale(holding);
  const fx = holding.market === 'US' && !holding.fundId ? Number(portfolio.fx?.USDJPY?.price || 1) : 1;
  if (change.difference > 0 && change.after?.buyPrice != null && Math.abs(Number(change.after.buyPrice) - Number(change.before?.buyPrice || 0)) > 1e-9) {
    const oldCost = Number(change.before?.buyPrice || 0) * change.oldUnits / scale;
    const newCost = Number(change.after.buyPrice || 0) * change.newUnits / scale;
    const inferred = (newCost - oldCost) * scale / change.difference / fx;
    if (Number.isFinite(inferred) && inferred > 0) return inferred;
  }
  return Number(holding.quote?.price || 0);
}
function showTransactionQuestion(change) {
  pendingHoldingChange = change;
  const action = change.difference > 0 ? '加仓' : '减仓';
  document.querySelector('#transaction-title').textContent = `${change.holding.name} · ${action}`;
  document.querySelector('#transaction-question').textContent = change.difference < 0
    ? `持仓数量从 ${preciseNumber.format(change.oldUnits)} 变为 ${preciseNumber.format(change.newUnits)}。确认后会按当前行情估算卖出金额，并自动把利润写入收益记录。`
    : `持仓数量从 ${preciseNumber.format(change.oldUnits)} 变为 ${preciseNumber.format(change.newUnits)}。这是一次${action}行为吗？`;
  const dialog = document.querySelector('#transaction-dialog');
  dialog.showModal();
  return new Promise(resolve => { transactionDialogResolve = resolve; });
}
function automaticTransactionDetails(change) {
  const usesUsd = change.holding.market === 'US' && !change.holding.fundId;
  const exchangeRate = usesUsd ? Number(portfolio.fx?.USDJPY?.price || 0) : 1;
  const price = defaultTransactionPrice(change);
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(exchangeRate) || exchangeRate <= 0) return null;
  return { record: true, date: todayInTokyo(), price, fee: 0, exchangeRate, usesUsd };
}
function finishTransactionQuestion(result) {
  const dialog = document.querySelector('#transaction-dialog');
  if (dialog.open) dialog.close();
  const resolve = transactionDialogResolve;
  transactionDialogResolve = null;
  pendingHoldingChange = null;
  resolve?.(result);
}
function applyTransaction(change, details, holdings) {
  const type = change.difference > 0 ? 'BUY' : 'SELL';
  const quantity = Math.abs(change.difference);
  const holding = change.after || { ...change.before, units: 0, archived: true };
  const scale = unitScale(holding);
  const exchangeRate = details.usesUsd ? details.exchangeRate : 1;
  const grossAmount = details.price * quantity * exchangeRate / scale;
  const amountJPY = type === 'BUY' ? grossAmount + details.fee : grossAmount - details.fee;
  if (amountJPY < 0) throw new Error('手续费不能超过卖出金额');
  const averageCostBeforeJPY = Number(change.before?.buyPrice || 0);
  let averageCostAfterJPY = averageCostBeforeJPY;
  if (type === 'BUY') {
    const previousCost = averageCostBeforeJPY * change.oldUnits / scale;
    averageCostAfterJPY = change.newUnits > 0 ? (previousCost + amountJPY) * scale / change.newUnits : 0;
  }
  let target = holdings.find(item => item.id === change.id);
  if (!target) {
    target = holding;
    holdings.push(target);
  }
  target.units = change.newUnits;
  target.buyPrice = averageCostAfterJPY;
  target.archived = change.newUnits <= 0;
  const realizedProfitJPY = type === 'SELL'
    ? amountJPY - averageCostBeforeJPY * quantity / scale
    : 0;
  const transactionId = globalThis.crypto?.randomUUID?.() || `transaction-${Date.now()}-${Math.random()}`;
  const localTimestamp = details.date === todayInTokyo()
    ? `${new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo', hour12: false }).replace(' ', 'T')}+09:00`
    : `${details.date}T12:00:00+09:00`;
  const transaction = {
    id: transactionId,
    holdingId: target.id,
    instrumentId: target.instrumentId || instrumentLedgerId(target),
    accountId: target.accountId || accountLedgerId(target.account),
    name: target.name,
    symbol: target.symbol || '',
    market: target.market,
    account: target.account || '未设置',
    product: productType(target),
    type,
    price: details.price,
    quantity,
    fee: details.fee,
    currency: details.usesUsd ? 'USD' : 'JPY',
    exchangeRate,
    unitScale: scale,
    amountJPY,
    externalCashFlowJPY: type === 'BUY' ? amountJPY : -amountJPY,
    averageCostBeforeJPY,
    averageCostAfterJPY,
    realizedProfitJPY,
    timestamp: localTimestamp,
    fundId: target.fundId || null,
    quoteSource: target.quoteSource || null
  };
  portfolio.transactions = [...(portfolio.transactions || []), transaction];
  portfolio.ledgerStartDate ||= details.date;
  if (type === 'SELL') {
    const currentRealizedTrades = realizedTrades();
    if (currentRealizedTrades.some(trade => trade.transactionId === transactionId)) return;
    portfolio.realizedTrades = [...currentRealizedTrades, {
      id: `sale-${transactionId}`,
      transactionId,
      date: details.date,
      name: target.name,
      proceedsJPY: amountJPY,
      realizedProfitJPY,
      note: '由减仓自动记录',
      kind: 'SELL',
      account: target.account || '未设置',
      product: productType(target),
      createdAt: new Date().toISOString()
    }];
  }
}
async function saveEditedHoldings() {
  const button = document.querySelector('#save-holdings');
  let holdingsSaved = false;
  const previousHoldings = cloneHoldings(editorBaselineHoldings);
  const previousTransactions = [...(portfolio.transactions || [])];
  const previousRealizedTrades = [...realizedTrades()];
  const nextHoldings = collectEditorHoldings();
  const changes = holdingQuantityChanges(previousHoldings, nextHoldings);
  portfolio.holdings = nextHoldings;
  button.disabled = true;
  try {
    for (const change of changes) {
      const decision = await showTransactionQuestion(change);
      if (decision === 'cancel') {
        portfolio.holdings = previousHoldings;
        portfolio.transactions = previousTransactions;
        portfolio.realizedTrades = previousRealizedTrades;
        renderEditor();
        document.querySelector('#notice').textContent = '已取消修改。';
        return;
      }
      if (decision?.record) applyTransaction(change, decision, portfolio.holdings);
    }
    button.textContent = '保存中…';
    const saved = await savePortfolioData(portfolio);
    holdingsSaved = true;
    importReviewFields = new Map();
    render(saved);
    editorBaselineHoldings = cloneHoldings(saved.holdings);
    closeManagementPanels();
    setDashboardView('settings');
    button.disabled = false;
    button.textContent = '保存修改';
    document.querySelector('#notice').textContent = '持仓已保存，行情与收益正在后台更新…';
    const refreshed = await refreshPortfolioData(saved);
    render(refreshed.portfolio);
    editorBaselineHoldings = cloneHoldings(refreshed.portfolio.holdings);
    document.querySelector('#notice').textContent = refreshed.errors.length ? `持仓已保存；部分行情未更新：${refreshed.errors.join('；')}` : '持仓与收益记录已更新。';
  } catch (error) {
    if (!holdingsSaved) {
      portfolio.holdings = previousHoldings;
      portfolio.transactions = previousTransactions;
      portfolio.realizedTrades = previousRealizedTrades;
      renderEditor();
    }
    document.querySelector('#notice').textContent = holdingsSaved ? `持仓已保存，但行情更新失败：${error.message}` : `保存失败：${error.message}`;
  } finally {
    button.disabled = false;
    button.textContent = '保存修改';
  }
}
document.querySelector('#returns-toggle').addEventListener('click', () => toggleManagementPanel('returns'));
document.querySelector('#realized-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = document.querySelector('#add-realized');
  const proceedsJPY = Number(document.querySelector('#realized-proceeds').value);
  const realizedProfitJPY = Number(document.querySelector('#realized-pnl').value);
  if (!Number.isFinite(proceedsJPY) || proceedsJPY < 0 || !Number.isFinite(realizedProfitJPY)) {
    document.querySelector('#notice').textContent = '请输入正确的卖出金额和实现盈亏。';
    return;
  }
  const trade = {
    id: globalThis.crypto?.randomUUID?.() || `sale-${Date.now()}`,
    date: document.querySelector('#realized-date').value,
    name: document.querySelector('#realized-name').value.trim(),
    proceedsJPY,
    realizedProfitJPY,
    note: document.querySelector('#realized-note').value.trim(),
    kind: 'SELL',
    account: '未设置',
    product: '未设置',
    createdAt: new Date().toISOString()
  };
  button.disabled = true;
  button.textContent = '保存中…';
  try {
    const result = await savePortfolioData({ ...portfolio, realizedTrades: [...realizedTrades(), trade] });
    render(result);
    event.target.reset();
    document.querySelector('#realized-date').value = new Date().toISOString().slice(0, 10);
    document.querySelector('#notice').textContent = '收益记录已添加。';
    closeManagementPanels();
  } catch (error) {
    document.querySelector('#notice').textContent = `添加失败：${error.message}`;
  } finally {
    button.disabled = false;
    button.textContent = '添加记录';
  }
});
document.querySelector('#edit-toggle').addEventListener('click', () => {
  if (document.querySelector('#editor').hidden) editorBaselineHoldings = cloneHoldings(portfolio.holdings);
  toggleManagementPanel('editor');
});
document.querySelector('#add-holding').addEventListener('click', () => {
  portfolio.holdings.unshift({ id: globalThis.crypto?.randomUUID?.() || `holding-${Date.now()}`, name: '新持仓', symbol: null, market: 'US', account: null, valueJPY: 0, profitJPY: 0, profitPct: 0, autoQuote: true, units: null, buyPrice: null });
  renderEditor();
  const nameInput = document.querySelector('#editor-rows tr:first-child input');
  nameInput?.focus();
  nameInput?.select();
});
document.querySelector('#save-holdings').addEventListener('click', saveEditedHoldings);
document.querySelector('#transaction-no').addEventListener('click', () => finishTransactionQuestion({ record: false }));
document.querySelector('#transaction-yes').addEventListener('click', () => {
  const details = automaticTransactionDetails(pendingHoldingChange);
  if (!details) {
      document.querySelector('#notice').textContent = '无法自动计算本次交易价格，请确认买入价和代码。';
    finishTransactionQuestion('cancel');
    return;
  }
  finishTransactionQuestion(details);
});
document.querySelector('#cancel-transaction-dialog').addEventListener('click', () => finishTransactionQuestion('cancel'));
document.querySelector('#transaction-dialog').addEventListener('cancel', event => {
  event.preventDefault();
  finishTransactionQuestion('cancel');
});
document.querySelector('#data-toggle').addEventListener('click', () => toggleManagementPanel('data-transfer'));
document.querySelector('#copy-import-prompt').addEventListener('click', async () => { await copyText(buildSanitizedImportPrompt()); document.querySelector('#notice').textContent = '持仓整理 Prompt 已复制。'; });
document.querySelector('#export-holdings').addEventListener('click', exportHoldings);
document.querySelector('#preview-import').addEventListener('click', previewImport);
document.querySelector('#import-holdings').addEventListener('click', importHoldings);
document.querySelector('#import-markdown').addEventListener('input', () => { pendingImportHoldings = null; document.querySelector('#import-preview').textContent = '内容已变化，请重新检查'; });
document.querySelectorAll('th[data-sort]').forEach(header => header.addEventListener('click', () => {
  sortDirection = sortKey === header.dataset.sort ? -sortDirection : -1;
  sortKey = header.dataset.sort;
  saveViewPreferences();
  render(portfolio);
}));
let dashboardTabAnimationTimer = null;

function getDashboardViewContent() {
  let content = document.querySelector('#dashboard-view-content');
  if (content) return content;
  const main = document.querySelector('main');
  const header = main?.querySelector(':scope > header');
  if (!main || !header) return null;
  content = document.createElement('div');
  content.id = 'dashboard-view-content';
  [...main.children].filter(element => element !== header).forEach(element => content.append(element));
  main.append(content);
  return content;
}

function createDashboardTabSnapshot() {
  const content = getDashboardViewContent();
  if (!content || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return null;
  const snapshot = content.cloneNode(true);
  const rect = content.getBoundingClientRect();
  snapshot.removeAttribute('id');
  snapshot.className = 'tab-swipe-snapshot';
  snapshot.setAttribute('aria-hidden', 'true');
  snapshot.style.top = `${rect.top}px`;
  snapshot.style.left = `${rect.left}px`;
  snapshot.style.width = `${rect.width}px`;
  snapshot.style.height = `${Math.max(rect.height, window.innerHeight - Math.max(rect.top, 0))}px`;
  [...content.children].forEach((source, index) => {
    const cloned = snapshot.children[index];
    if (!cloned) return;
    cloned.style.setProperty('display', getComputedStyle(source).display, 'important');
  });
  const sourceCanvases = [...content.querySelectorAll('canvas')];
  snapshot.querySelectorAll('canvas').forEach((canvas, index) => {
    const source = sourceCanvases[index];
    if (!source) return;
    canvas.width = source.width;
    canvas.height = source.height;
    canvas.getContext('2d')?.drawImage(source, 0, 0);
  });
  document.body.append(snapshot);
  return snapshot;
}

function animateDashboardTabTransition(direction, snapshot) {
  if (!direction) return;
  const surface = getDashboardViewContent();
  if (!surface) return;
  surface.classList.remove('tab-swipe-enter-forward', 'tab-swipe-enter-backward');
  void surface.offsetWidth;
  surface.classList.add(direction > 0 ? 'tab-swipe-enter-forward' : 'tab-swipe-enter-backward');
  if (snapshot) snapshot.classList.add(direction > 0 ? 'tab-swipe-exit-forward' : 'tab-swipe-exit-backward');
  clearTimeout(dashboardTabAnimationTimer);
  dashboardTabAnimationTimer = setTimeout(() => {
    surface.classList.remove('tab-swipe-enter-forward', 'tab-swipe-enter-backward');
    snapshot?.remove();
  }, 280);
}

function setDashboardView(view, swipeDirection = 0, { preserveScroll = false } = {}) {
  const nextView = ['overview', 'holdings', 'calendar', 'settings'].includes(view) ? view : 'overview';
  getDashboardViewContent();
  const snapshot = swipeDirection ? createDashboardTabSnapshot() : null;
  closeManagementPanels();
  document.body.dataset.dashboardView = nextView;
  const overviewButton = document.querySelector('#overview-toggle');
  const holdingsButton = document.querySelector('#holdings-toggle');
  const calendarButton = document.querySelector('#calendar-toggle');
  const analysisButton = document.querySelector('#analysis-toggle');
  const settingsButton = document.querySelector('#settings-toggle');
  overviewButton.classList.toggle('selected', nextView === 'overview');
  holdingsButton.classList.toggle('selected', nextView === 'holdings');
  calendarButton.classList.toggle('selected', nextView === 'calendar');
  analysisButton.classList.toggle('selected', nextView === 'analysis');
  settingsButton.classList.toggle('selected', nextView === 'settings');
  overviewButton.setAttribute('aria-pressed', String(nextView === 'overview'));
  holdingsButton.setAttribute('aria-pressed', String(nextView === 'holdings'));
  calendarButton.setAttribute('aria-pressed', String(nextView === 'calendar'));
  analysisButton.setAttribute('aria-pressed', String(nextView === 'analysis'));
  settingsButton.setAttribute('aria-pressed', String(nextView === 'settings'));
  if (nextView === 'settings') document.querySelector('#settings').hidden = false;
  if (!preserveScroll) window.scrollTo({ top: 0, behavior: swipeDirection ? 'auto' : 'smooth' });
  if (nextView === 'analysis') requestAnimationFrame(resizeInvestmentPlanInput);
  const shouldRefreshHistory = nextView === 'calendar'
    || (nextView === 'overview' && (!historyHydrated || !Array.isArray(portfolio?.history) || !portfolio.history.length));
  if (shouldRefreshHistory) {
    void hydratePortfolioHistory({ force: true }).catch(error => {
      document.querySelector('#notice').textContent = `历史数据加载失败，将自动重试：${error.message}`;
    });
  }
  if (nextView === 'overview') requestAnimationFrame(() => {
    allocationChart?.resize();
    trendChart?.resize();
  });
  animateDashboardTabTransition(swipeDirection, snapshot);
}

const dashboardTabOrder = ['overview', 'holdings', 'calendar', 'settings'];

function openGoalSimulator(returnView = document.body.dataset.dashboardView || 'overview') {
  const simulatorUrl = new URL('goal-simulator.html', location.href);
  simulatorUrl.search = '';
  simulatorUrl.searchParams.set('v', '20260922-1');
  simulatorUrl.searchParams.set('returnView', returnView);
  if (localPortfolioMode) {
    simulatorUrl.searchParams.set('local', '1');
    if (sessionMode === 'user' && requestedUserId) {
      simulatorUrl.searchParams.set('mode', 'user');
      simulatorUrl.searchParams.set('user', requestedUserId);
    }
    if (localProfileToken && localProfileToken !== 'session') simulatorUrl.searchParams.set('profile', localProfileToken);
  }
  else if (accessToken) simulatorUrl.searchParams.set('token', accessToken);
  location.href = simulatorUrl.href;
}

function navigateDashboardTab(view, swipeDirection = 0) {
  if (view === 'prediction') {
    openGoalSimulator();
    return;
  }
  setDashboardView(view, swipeDirection);
}

function swipeShouldStayInContent(target) {
  return Boolean(target.closest('input, textarea, select, dialog, [contenteditable="true"]'));
}

function enableDashboardTabSwipe() {
  const swipeSurface = document.querySelector('main');
  if (!swipeSurface) return;
  let touchStart = null;
  let drag = null;
  let isSettling = false;
  const clearDragStyles = () => {
    const content = getDashboardViewContent();
    if (content) {
      content.classList.remove('tab-swipe-dragging');
      content.style.transform = '';
      content.style.transition = '';
    }
    drag?.snapshot?.classList.remove('tab-swipe-dragging');
    if (drag?.snapshot) {
      drag.snapshot.style.transform = '';
      drag.snapshot.style.transition = '';
    }
  };
  const previewDashboardDrag = (deltaX, target) => {
    const currentView = document.body.dataset.dashboardView || 'overview';
    const currentIndex = dashboardTabOrder.indexOf(currentView);
    const direction = deltaX < 0 ? 1 : -1;
    if (currentIndex < 0) return null;
    const nextIndex = (currentIndex + direction + dashboardTabOrder.length) % dashboardTabOrder.length;
    const nextView = dashboardTabOrder[nextIndex];
    const snapshot = createDashboardTabSnapshot();
    if (!snapshot) return null;
    setDashboardView(nextView, 0, { preserveScroll: true });
    const content = getDashboardViewContent();
    const width = Math.max(content?.getBoundingClientRect().width || 0, window.innerWidth);
    content?.classList.add('tab-swipe-dragging');
    snapshot.classList.add('tab-swipe-dragging');
    return { currentView, nextView, direction, snapshot, width };
  };
  const settleDashboardDrag = (activeDrag, complete) => {
    const content = getDashboardViewContent();
    const exitOffset = activeDrag.direction > 0 ? -activeDrag.width : activeDrag.width;
    const duration = 220;
    isSettling = true;
    if (!complete) setDashboardView(activeDrag.currentView, 0, { preserveScroll: true });
    if (content) {
      content.style.transition = `transform ${duration}ms cubic-bezier(.16,.82,.24,1)`;
      content.style.transform = 'translate3d(0, 0, 0)';
    }
    activeDrag.snapshot.style.transition = `transform ${duration}ms cubic-bezier(.16,.82,.24,1), opacity ${duration}ms ease`;
    activeDrag.snapshot.style.transform = `translate3d(${complete ? exitOffset : 0}px, 0, 0)`;
    activeDrag.snapshot.style.opacity = complete ? '.08' : '1';
    setTimeout(() => {
      activeDrag.snapshot.remove();
      clearDragStyles();
      isSettling = false;
    }, duration + 20);
  };
  const startDashboardFlick = (deltaX) => {
    const activeDrag = previewDashboardDrag(deltaX);
    if (!activeDrag) return;
    const content = getDashboardViewContent();
    const incomingOffset = activeDrag.direction > 0 ? activeDrag.width : -activeDrag.width;
    if (content) content.style.transform = `translate3d(${incomingOffset}px, 0, 0)`;
    requestAnimationFrame(() => settleDashboardDrag(activeDrag, true));
  };
  const getTouch = (touches, identifier) => [...touches].find(touch => touch.identifier === identifier);
  const startedInsideDashboard = target => target instanceof Element && target.closest('main') === swipeSurface;
  document.addEventListener('touchstart', event => {
    if (event.touches.length !== 1 || !startedInsideDashboard(event.target) || isSettling || swipeShouldStayInContent(event.target)) {
      touchStart = null;
      drag = null;
      return;
    }
    const touch = event.touches[0];
    touchStart = { id: touch.identifier, x: touch.clientX, y: touch.clientY };
  }, { passive: true, capture: true });
  document.addEventListener('touchmove', event => {
    if (!touchStart) return;
    const touch = getTouch(event.touches, touchStart.id);
    if (!touch) return;
    const deltaX = touch.clientX - touchStart.x;
    const deltaY = touch.clientY - touchStart.y;
    if (!drag) {
      if (Math.abs(deltaX) < 12 || Math.abs(deltaX) <= Math.abs(deltaY) * .7) return;
      drag = previewDashboardDrag(deltaX, event.target);
      if (!drag) return;
    }
    event.preventDefault();
    const progress = Math.max(-drag.width, Math.min(drag.width, deltaX));
    const incomingOffset = drag.direction > 0 ? drag.width + progress : -drag.width + progress;
    const content = getDashboardViewContent();
    if (content) content.style.transform = `translate3d(${incomingOffset}px, 0, 0)`;
    drag.snapshot.style.transform = `translate3d(${progress}px, 0, 0)`;
  }, { passive: false, capture: true });
  document.addEventListener('touchend', event => {
    if (!touchStart) return;
    const touch = getTouch(event.changedTouches, touchStart.id);
    if (!touch) return;
    const deltaX = touch.clientX - touchStart.x;
    const deltaY = touch.clientY - touchStart.y;
    touchStart = null;
    if (!drag) {
      if (Math.abs(deltaX) >= 24 && Math.abs(deltaX) > Math.abs(deltaY) * .7) startDashboardFlick(deltaX);
      return;
    }
    const activeDrag = drag;
    drag = null;
    settleDashboardDrag(activeDrag, Math.abs(deltaX) >= activeDrag.width * .12);
  }, { passive: true, capture: true });
  document.addEventListener('touchcancel', event => {
    if (!touchStart || !getTouch(event.changedTouches, touchStart.id)) return;
    touchStart = null;
    if (!drag) return;
    const activeDrag = drag;
    drag = null;
    setDashboardView(activeDrag.currentView, 0, { preserveScroll: true });
    activeDrag.snapshot.remove();
    clearDragStyles();
  }, { passive: true, capture: true });
}
function applyThemePreference(theme) {
  const nextTheme = theme === 'light' ? 'light' : 'ibkr';
  localStorage.setItem(themePreferenceKey, nextTheme);
  document.body.classList.toggle('theme-ibkr', nextTheme === 'ibkr');
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) themeMeta.content = nextTheme === 'ibkr' ? '#07090f' : '#f4f7f3';
  configureChartTheme(true);
  if (portfolio && globalThis.Chart) {
    renderAllocationChart();
    renderTrendPanel();
  }
}
const themeSelect = document.querySelector('#theme-select');
themeSelect.value = currentThemePreference();
themeSelect.addEventListener('change', event => applyThemePreference(event.target.value));
applyThemePreference(themeSelect.value);
document.querySelector('#overview-visibility-toggle').addEventListener('click', toggleOverviewPrivacy);
renderOverviewPrivacy();
document.querySelector('#settings-toggle').addEventListener('click', () => setDashboardView('settings'));
document.querySelector('#overview-toggle').addEventListener('click', () => setDashboardView('overview'));
document.querySelector('#holdings-toggle').addEventListener('click', () => setDashboardView('holdings'));
document.querySelector('#calendar-toggle').addEventListener('click', () => setDashboardView('calendar'));
document.querySelector('#analysis-toggle').addEventListener('click', () => setDashboardView('analysis'));
document.querySelector('#watch-mode-toggle').addEventListener('click', () => setWatchMode(!watchModeActive));
document.querySelector('#goal-simulator-toggle').addEventListener('click', () => openGoalSimulator());
enableDashboardTabSwipe();
document.querySelector('#switch-profile').addEventListener('click', async () => {
  const button = document.querySelector('#switch-profile');
  button.disabled = true;
  button.textContent = '正在退出…';
  try {
    await fetch('/api/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
  } finally {
    localStorage.removeItem('portfolioAccessToken');
    localStorage.removeItem('portfolioSessionMode');
    location.replace('/');
  }
});
document.querySelector('#save-settings').addEventListener('click', async () => {
  portfolio.accountStartDate = document.querySelector('#account-start-date').value || null;
  applyThemePreference(themeSelect.value);
  try {
    const result = await savePortfolioData(portfolio);
    render(result);
    document.querySelector('#notice').textContent = '账户设置已保存。';
    setDashboardView('overview');
  } catch (error) {
    document.querySelector('#notice').textContent = `保存失败：${error.message}`;
  }
});
document.querySelectorAll('[data-trend-view]').forEach(button => button.addEventListener('click', () => {
  trendView = button.dataset.trendView;
  reportDate = new Date();
  document.querySelectorAll('[data-trend-view]').forEach(item => item.classList.toggle('selected', item === button));
  renderTrendPanel();
  if (!historyHydrated || !Array.isArray(portfolio?.history) || !portfolio.history.length) {
    void hydratePortfolioHistory({ force: true }).catch(error => {
      document.querySelector('#notice').textContent = `历史数据加载失败，将自动重试：${error.message}`;
    });
  }
}));
document.querySelectorAll('[data-trend-mode]').forEach(button => button.addEventListener('click', () => {
  trendMode = button.dataset.trendMode;
  document.querySelectorAll('[data-trend-mode]').forEach(item => item.classList.toggle('selected', item === button));
  renderTrendChart();
}));
document.querySelector('#benchmark-settings').addEventListener('click', openBenchmarkDialog);
document.querySelector('#close-benchmark-dialog').addEventListener('click', () => document.querySelector('#benchmark-dialog').close());
document.querySelector('#save-benchmark-settings').addEventListener('click', saveBenchmarkSettings);
document.querySelector('#benchmark-dialog').addEventListener('click', event => {
  if (event.target === event.currentTarget) event.currentTarget.close();
});
document.querySelector('#previous-period').addEventListener('click', () => {
  if (trendView === 'all') return;
  if (trendView === 'month') reportDate.setMonth(reportDate.getMonth() - 1);
  else reportDate.setFullYear(reportDate.getFullYear() - 1);
  renderPeriodReport();
});
document.querySelector('#next-period').addEventListener('click', () => {
  if (trendView === 'all') return;
  if (trendView === 'month') reportDate.setMonth(reportDate.getMonth() + 1);
  else reportDate.setFullYear(reportDate.getFullYear() + 1);
  renderPeriodReport();
});
document.querySelector('#previous-month').addEventListener('click', () => {
  displayedMonth.setMonth(displayedMonth.getMonth() - 1);
  calendarDateUserSelected = false;
  clearDailyAiReport();
  renderCalendar();
});
document.querySelector('#next-month').addEventListener('click', () => {
  displayedMonth.setMonth(displayedMonth.getMonth() + 1);
  calendarDateUserSelected = false;
  clearDailyAiReport();
  renderCalendar();
});
document.querySelector('#calendar').addEventListener('click', event => {
  const day = event.target.closest('[data-calendar-date]');
  if (day) {
    calendarDateUserSelected = true;
    selectedCalendarDate = day.dataset.calendarDate;
    clearDailyAiReport();
    openContributionDialog(selectedCalendarDate);
    restoreDailyAiReport();
  }
});
document.querySelector('#daily-ai-summary-button').addEventListener('click', () => {
  if (!selectedCalendarDate) return;
  const forceRefresh = !document.querySelector('#daily-ai-report').hidden;
  void requestDailyAiSummary(forceRefresh);
});
void loadAccountAiUsage();
document.querySelector('#close-contribution').addEventListener('click', () => {
  document.querySelector('#daily-contribution-dialog').close();
});
document.querySelector('#toggle-contribution-list').addEventListener('click', () => {
  contributionExpanded = !contributionExpanded;
  renderContributionDialog();
});
document.querySelector('#daily-contribution-dialog').addEventListener('click', event => {
  if (event.target === event.currentTarget) {
    event.currentTarget.close();
  }
});
const investmentPlanInput = document.querySelector('#investment-plan');
investmentPlanInput.addEventListener('input', () => {
  resizeInvestmentPlanInput();
  scheduleInvestmentPlanSave();
});
investmentPlanInput.addEventListener('blur', () => {
  clearTimeout(investmentPlanSaveTimer);
  investmentPlanSaveTimer = null;
  void persistInvestmentPlan(investmentPlanInput.value);
});
document.querySelector('#copy').addEventListener('click', async () => {
  if (!portfolio || !analysisPrompt) {
    document.querySelector('#notice').textContent = '组合或分析模板尚未加载，请稍后重试。';
    return;
  }
  const button = document.querySelector('#copy');
  const investmentPlan = document.querySelector('#investment-plan').value.trim();
  if (!investmentPlan) {
    document.querySelector('#notice').textContent = '请先填写投资计划。';
    return;
  }
  button.disabled = true;
  button.textContent = '复制中…';
  clearTimeout(investmentPlanSaveTimer);
  investmentPlanSaveTimer = null;
  investmentPlanSaveRevision += 1;
  try {
    await copyText(buildAnalysisRequest(investmentPlan));
    button.textContent = '保存中…';
    try {
      portfolio = await enqueueInvestmentPlanOperation(() => savePortfolioData({ ...portfolio, investmentPlan }));
      localStorage.removeItem(investmentPlanDraftKey);
      document.querySelector('#investment-plan').value = investmentPlan;
      resizeInvestmentPlanInput();
      document.querySelector('#notice').textContent = `投资计划已保存，分析请求已复制，包含 ${activeHoldings().length} 条最新持仓。`;
    } catch (error) {
      portfolio = { ...portfolio, investmentPlan };
      document.querySelector('#investment-plan').value = investmentPlan;
      resizeInvestmentPlanInput();
      document.querySelector('#notice').textContent = `分析请求已复制，但投资计划暂时保存失败：${error.message}`;
    }
  } catch (error) {
    document.querySelector('#notice').textContent = `复制失败：${error.message}`;
  } finally {
    button.disabled = false;
    button.textContent = '复制分析';
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (pendingLiveRender && canRenderLiveQuotes()) {
    pendingLiveRender = false;
    renderLiveUpdate();
  }
  syncPortfolio(true);
});
window.addEventListener('focus', () => syncPortfolio(true));
setInterval(syncPortfolio, 30000);
setInterval(pollLiveQuotes, cloudDeployment ? 5000 : 1000);
const promptRequest = localPortfolioMode
  ? fetch('/analysis-prompt.md').then(response => response.text()).then(prompt => ({ prompt }))
  : apiFetch('/api/analysis-prompt').then(response => response.json());
async function loadAndRefreshPortfolio() {
  await load();
  if (cloudDeployment) return;
  try {
    const result = await refreshPortfolioData();
    render(result.portfolio);
    if (result.errors?.length) document.querySelector('#notice').textContent = `部分行情未更新：${result.errors.join('；')}`;
  } catch (error) {
    document.querySelector('#notice').textContent = `行情刷新失败，已显示上次数据：${error.message}`;
  }
}
Promise.all([loadAndRefreshPortfolio(), promptRequest]).then(([, prompt]) => {
  analysisPrompt = prompt.prompt || '';
  if (['overview', 'holdings', 'calendar', 'settings'].includes(requestedDashboardView)) {
    setDashboardView(requestedDashboardView);
    const cleanUrl = new URL(location.href);
    cleanUrl.searchParams.delete('view');
    history.replaceState(null, '', cleanUrl);
  }
  connectLiveQuotes();
  if (cloudDeployment) void pollLiveQuotes();
}).catch(error => {
  document.querySelector('#notice').textContent = `无法加载组合：${error.message}`;
});
document.querySelector('#mobile-sort-key').addEventListener('change', event => { sortKey = event.target.value; sortDirection = -1; saveViewPreferences(); render(portfolio); });
document.querySelector('#mobile-sort-direction').addEventListener('click', () => { sortDirection *= -1; saveViewPreferences(); render(portfolio); });
