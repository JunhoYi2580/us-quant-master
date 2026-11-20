import { createClient } from '@supabase/supabase-js';

// GitHub Secrets 환경변수 로드
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const missingVars = [];
if (!SUPABASE_URL) missingVars.push('SUPABASE_URL');
if (!SUPABASE_KEY) missingVars.push('SUPABASE_KEY');
if (!FINNHUB_API_KEY) missingVars.push('FINNHUB_API_KEY');

if (missingVars.length > 0) {
  console.error(`[FATAL] GitHub Secrets에 다음 필수 키가 누락되었습니다: ${missingVars.join(', ')}`);
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// Supabase watchlist 테이블 미생성 시 사용하는 기본 20개 미국 핵심 종목 풀
const DEFAULT_WATCHLIST = [
  'PLTR', 'NVDA', 'VST', 'AMD', 'SOFI',
  'RKLB', 'AAPL', 'MSFT', 'TSLA', 'META',
  'GOOGL', 'AMZN', 'AVGO', 'TSM', 'CEG',
  'IONQ', 'SMCI', 'COIN', 'UBER', 'HOOD',
];

// =========================================================================
// 자동 발동 기준 상수 (이 기준을 충족할 때만 4단계 파이프라인 자동 점화)
// =========================================================================
const TRIGGER_CRITERIA = {
  MIN_DAILY_MOVE_PCT: 2.5,     // 기준 1: 전일 대비 ±2.5% 이상 급등락
  WALL_PROXIMITY_PCT: 1.5,     // 기준 2: Put Wall / Call Wall 1.5% 이내 근접
  MIN_INTRADAY_RANGE_PCT: 3.5, // 기준 3: 일중 고저 변동폭 3.5% 이상 확대
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// =========================================================================
// [감시 종목 로드] Supabase watchlist 테이블에서 사용자 활성(ON) 종목 조회
// =========================================================================
async function loadActiveWatchlist(modules) {
  let activeSymbols = [];

  try {
    const { data, error } = await sb
      .from('watchlist')
      .select('symbol')
      .eq('is_active', true)
      .order('created_at', { ascending: true });

    if (error) throw error;
    if (Array.isArray(data) && data.length > 0) {
      activeSymbols = data
        .map((row) => String(row.symbol || '').trim().toUpperCase())
        .filter((s) => /^[A-Z.-]{1,10}$/.test(s));
    }
  } catch (e) {
    console.warn(`[Watchlist Fallback] Supabase watchlist 조회 실패 -> 기본 20종목 사용 (${e.message})`);
  }

  if (activeSymbols.length === 0) {
    activeSymbols = [...DEFAULT_WATCHLIST];
  }

  // 이미 보유 중인 종목은 사용자가 목록에서 끄더라도 평가·물타기·불타기 관리를 위해 자동 포함
  const heldSymbols = modules
    .filter((m) => Number(m.shares || 0) > 0 && m.holding_ticker && m.holding_ticker !== '현금관망')
    .map((m) => String(m.holding_ticker).trim().toUpperCase())
    .filter((s) => /^[A-Z.-]{1,10}$/.test(s));

  const merged = [...new Set([...activeSymbols, ...heldSymbols])];
  console.log(`[Watchlist] 총 ${merged.length}개 종목 감시 시작: ${merged.join(', ')}`);
  return merged;
}

// =========================================================================
// [경량 감시] 실시간 시세 조회 (Finnhub Quote API · 무료 한도 보호 지연 적용)
// =========================================================================
async function fetchLightweightQuotes(symbols) {
  const quotes = [];
  const delayMs = symbols.length > 15 ? 120 : 0;

  for (const symbol of symbols) {
    try {
      const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${FINNHUB_API_KEY}`);
      const q = await res.json();
      if (q && q.c > 0 && q.pc > 0) {
        const price = Number(q.c.toFixed(2));
        const prevClose = Number(q.pc.toFixed(2));
        const high = Number((q.h || price).toFixed(2));
        const low = Number((q.l || price).toFixed(2));
        const changePct = Number((((price - prevClose) / prevClose) * 100).toFixed(2));
        const intradayRangePct = Number((((high - low) / prevClose) * 100).toFixed(2));

        // 1차 감마 벽 추정치 (게이트 판독용)
        const putWall = Number((low * 0.97).toFixed(2));
        const callWall = Number((high * 1.04).toFixed(2));
        const hvlFlip = Number(((low + high) / 2).toFixed(2));

        quotes.push({
          symbol,
          price,
          prevClose,
          high,
          low,
          changePct,
          intradayRangePct,
          putWall,
          callWall,
          hvlFlip,
        });
      }
    } catch (e) {
      console.error(`[Quote Watch Error] ${symbol}:`, e.message);
    }

    if (delayMs > 0) await sleep(delayMs);
  }
  return quotes;
}

// =========================================================================
// [STEP 0] 무인 자동 발동 기준 판독기 (Trigger Criteria Gate)
// =========================================================================
function evaluateTriggerCriteria(quotes, modules) {
  const triggeredSymbols = new Set();
  const triggerReasons = [];

  const hasIdleModule = modules.some(
    (m) => Number(m.shares || 0) === 0 || !m.holding_ticker || m.holding_ticker === '현금관망'
  );
  const heldTickers = new Set(
    modules
      .filter((m) => Number(m.shares || 0) > 0 && m.holding_ticker && m.holding_ticker !== '현금관망')
      .map((m) => m.holding_ticker.toUpperCase())
  );

  for (const q of quotes) {
    const reasons = [];

    // 기준 1: 전일 대비 ±2.5% 이상 급등락
    if (Math.abs(q.changePct) >= TRIGGER_CRITERIA.MIN_DAILY_MOVE_PCT) {
      reasons.push(`급등락(${q.changePct > 0 ? '+' : ''}${q.changePct}%)`);
    }

    // 기준 2: 핵심 감마 벽(Put Wall / Call Wall) 근접 또는 보유종목 HVL 돌파
    const distToPutPct = ((q.price - q.putWall) / q.price) * 100;
    const distToCallPct = ((q.callWall - q.price) / q.price) * 100;

    if (distToPutPct <= TRIGGER_CRITERIA.WALL_PROXIMITY_PCT) {
      reasons.push(`Put Wall($${q.putWall}) 근접`);
    }
    if (distToCallPct <= TRIGGER_CRITERIA.WALL_PROXIMITY_PCT) {
      reasons.push(`Call Wall($${q.callWall}) 근접`);
    }
    if (heldTickers.has(q.symbol) && q.price >= q.hvlFlip) {
      reasons.push(`보유종목 HVL($${q.hvlFlip}) 상향 돌파`);
    }

    // 기준 3: 일중 변동폭 3.5% 이상 확대
    if (q.intradayRangePct >= TRIGGER_CRITERIA.MIN_INTRADAY_RANGE_PCT) {
      reasons.push(`일중 진폭 확대(${q.intradayRangePct}%)`);
    }

    // 기준 4: 현금 대기 중인 모듈이 있고, 최소 2주 매수 가능 + 과열 아님
    if (hasIdleModule && q.price * 2 <= 1000 && q.changePct < 6.0) {
      reasons.push('현금 대기 모듈 신규 진입 검토');
    }

    if (reasons.length > 0) {
      triggeredSymbols.add(q.symbol);
      triggerReasons.push(`${q.symbol}[${reasons.join(', ')}]`);
    }
  }

  return {
    shouldTrigger: triggeredSymbols.size > 0,
    targetQuotes: quotes.filter((q) => triggeredSymbols.has(q.symbol)),
    summary: triggerReasons.slice(0, 4).join(' | '),
  };
}

// =========================================================================
// [STEP 1] 기준 충족 종목 심층 데이터 & 최신 뉴스 수집 (API 한도 보호)
// =========================================================================
async function step1_collectDeepData(targetQuotes, modules) {
  const today = new Date();
  const fromDate = new Date(today.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const toDate = today.toISOString().slice(0, 10);

  const heldSet = new Set(
    modules
      .filter((m) => Number(m.shares || 0) > 0 && m.holding_ticker && m.holding_ticker !== '현금관망')
      .map((m) => m.holding_ticker.toUpperCase())
  );

  // 보유 종목 + 변동성 큰 종목 위주로 최대 20개까지 뉴스 수집 (Finnhub 무료 분당 60회 보호)
  const prioritized = [...targetQuotes].sort((a, b) => {
    const aHeld = heldSet.has(a.symbol) ? 1 : 0;
    const bHeld = heldSet.has(b.symbol) ? 1 : 0;
    if (aHeld !== bHeld) return bHeld - aHeld;
    return Math.abs(b.changePct) - Math.abs(a.changePct);
  });

  const newsTargets = new Set(prioritized.slice(0, 20).map((q) => q.symbol));
  const enriched = [];

  for (const item of targetQuotes) {
    let headlines = [];
    if (newsTargets.has(item.symbol)) {
      try {
        const res = await fetch(
          `https://finnhub.io/api/v1/company-news?symbol=${item.symbol}&from=${fromDate}&to=${toDate}&token=${FINNHUB_API_KEY}`
        );
        const newsArr = await res.json();
        if (Array.isArray(newsArr)) {
          headlines = newsArr.slice(0, 3).map((n) => n.headline).filter(Boolean);
        }
      } catch (e) {
        console.warn(`[STEP 1 News Skip] ${item.symbol}:`, e.message);
      }
      await sleep(140);
    }
    enriched.push({ ...item, headlines });
  }
  return enriched;
}

// =========================================================================
// [STEP 2] Jev 35기준 정제 및 스코어링 (뉴스 + 수급 벽 + 선반영 과열 판정)
// =========================================================================
function step2_jevRefine(deepMarketList) {
  const negativeKeywords = ['miss', 'cut', 'downgrade', 'lawsuit', 'probe', 'slump', 'plunge', 'weak'];
  const positiveKeywords = ['beat', 'raise', 'upgrade', 'contract', 'surge', 'record', 'growth', 'ai'];

  return deepMarketList.map((item) => {
    const joinedNews = (item.headlines || []).join(' ').toLowerCase();
    const posHits = positiveKeywords.filter((k) => joinedNews.includes(k)).length;
    const negHits = negativeKeywords.filter((k) => joinedNews.includes(k)).length;

    const isOverheated = item.changePct >= 6.0 || item.price >= item.callWall * 0.99;
    const isPricedInRisk = item.changePct >= 4.5 && posHits > 0;
    const isBigNewsCrash = item.changePct <= -5.0;
    const isDipOpportunity = item.changePct <= -1.5 && item.price >= item.putWall;

    let jevScore = 70;
    if (item.price >= item.hvlFlip) jevScore += 8;
    if (isDipOpportunity) jevScore += 12;
    if (posHits > negHits) jevScore += 8;
    if (negHits > posHits) jevScore -= 10;
    if (isOverheated) jevScore -= 18;
    if (isPricedInRisk) jevScore -= 10;

    return {
      ...item,
      posHits,
      negHits,
      isOverheated,
      isPricedInRisk,
      isBigNewsCrash,
      isDipOpportunity,
      jevScore: Math.min(98, Math.max(35, jevScore)),
    };
  });
}

// =========================================================================
// [보유 계좌 평가 갱신] 파이프라인 미발동 시에도 보유 종목 수익률은 실시간 유지
// =========================================================================
async function syncHeldModulesValuation(allQuotes, modules) {
  const nowIso = new Date().toISOString();
  for (const mod of modules) {
    const shares = Number(mod.shares || 0);
    if (shares > 0 && mod.holding_ticker && mod.holding_ticker !== '현금관망') {
      const held = allQuotes.find((x) => x.symbol === mod.holding_ticker.toUpperCase());
      if (held) {
        const evalUsd = Number((shares * held.price).toFixed(2));
        const roiPct = Number((((Number(mod.cash_usd) + evalUsd - 1000) / 1000) * 100).toFixed(2));
        await sb
          .from('modules')
          .update({
            invested_usd: evalUsd,
            roi_pct: roiPct,
            updated_at: nowIso,
          })
          .eq('id', mod.id);
      }
    }
  }
}

// =========================================================================
// [STEP 3 & 4] 6개 AI 모듈별 필터 검증(ON/OFF 반영) 및 자동 분할 매매 집행
// =========================================================================
async function step3and4_analyzeAndExecute(refinedList, modules, triggerSummary) {
  const nowIso = new Date().toISOString();

  for (const mod of modules) {
    const cash = Number(mod.cash_usd || 0);
    const shares = Number(mod.shares || 0);
    const avgPrice = Number(mod.avg_price_usd || 0);

    // ---------------------------------------------------------------------
    // CASE 1: 이미 보유 중인 모듈 -> 물타기(Put Wall) / 불타기(HVL) 조건 판정
    // ---------------------------------------------------------------------
    if (shares > 0 && mod.holding_ticker && mod.holding_ticker !== '현금관망') {
      const held = refinedList.find((x) => x.symbol === mod.holding_ticker.toUpperCase());
      if (!held) continue;

      if (mod.big_news_cooling_3h && held.isBigNewsCrash) {
        console.log(`[모듈 #${mod.id}] ${held.symbol} 급락(${held.changePct}%) -> 3시간 냉각기 동결 유지`);
        continue;
      }

      // 물타기 조건: Put Wall 근접 & 평단 대비 -4% 이하 & 잔여 현금 충분
      const waterPct = Number(mod.split_water_pct || 0);
      if (waterPct > 0 && held.price <= avgPrice * 0.96 && held.price >= held.putWall * 0.99 && cash >= held.price) {
        const allocUsd = Math.min(cash, 1000 * (waterPct / 100));
        const addShares = Math.floor(allocUsd / held.price);
        if (addShares >= 1) {
          const addCost = Number((addShares * held.price).toFixed(2));
          const newShares = shares + addShares;
          const newAvg = Number(((shares * avgPrice + addCost) / newShares).toFixed(2));
          const newCash = Number((cash - addCost).toFixed(2));
          const evalUsd = Number((newShares * held.price).toFixed(2));
          const roiPct = Number((((newCash + evalUsd - 1000) / 1000) * 100).toFixed(2));

          const { error: uErr } = await sb
            .from('modules')
            .update({
              cash_usd: newCash,
              invested_usd: evalUsd,
              shares: newShares,
              avg_price_usd: newAvg,
              roi_pct: roiPct,
              updated_at: nowIso,
            })
            .eq('id', mod.id);

          if (uErr) {
            console.error(`[모듈 #${mod.id} 물타기 DB 오류]`, uErr.message);
            continue;
          }

          await sb.from('trade_logs').insert({
            module_id: mod.id,
            ticker: held.symbol,
            action_type: `물타기 매수 (${waterPct}%)`,
            shares: addShares,
            price: held.price,
            reason: `[자동발동: ${triggerSummary}] Put Wall($${held.putWall}) 지지 확인 + Jev ${held.jevScore}점 -> ${addShares}주 추가 매집`,
            created_at: nowIso,
          });
          console.log(`[모듈 #${mod.id}] ${held.symbol} 물타기 ${addShares}주 @ $${held.price}`);
          continue;
        }
      }

      // 불타기 조건: HVL 돌파 + 평단 대비 +3% 이상 수익 + 과열 아님
      const pyramidPct = Number(mod.split_pyramid_pct || 0);
      if (
        pyramidPct > 0 &&
        !(mod.overheat_block && held.isOverheated) &&
        held.price >= avgPrice * 1.03 &&
        held.price >= held.hvlFlip &&
        cash >= held.price
      ) {
        const allocUsd = Math.min(cash, 1000 * (pyramidPct / 100));
        const addShares = Math.floor(allocUsd / held.price);
        if (addShares >= 1) {
          const addCost = Number((addShares * held.price).toFixed(2));
          const newShares = shares + addShares;
          const newAvg = Number(((shares * avgPrice + addCost) / newShares).toFixed(2));
          const newCash = Number((cash - addCost).toFixed(2));
          const evalUsd = Number((newShares * held.price).toFixed(2));
          const roiPct = Number((((newCash + evalUsd - 1000) / 1000) * 100).toFixed(2));

          const { error: uErr } = await sb
            .from('modules')
            .update({
              cash_usd: newCash,
              invested_usd: evalUsd,
              shares: newShares,
              avg_price_usd: newAvg,
              roi_pct: roiPct,
              updated_at: nowIso,
            })
            .eq('id', mod.id);

          if (uErr) {
            console.error(`[모듈 #${mod.id} 불타기 DB 오류]`, uErr.message);
            continue;
          }

          await sb.from('trade_logs').insert({
            module_id: mod.id,
            ticker: held.symbol,
            action_type: `불타기 매수 (${pyramidPct}%)`,
            shares: addShares,
            price: held.price,
            reason: `[자동발동: ${triggerSummary}] HVL($${held.hvlFlip}) 추세 돌파 + Jev ${held.jevScore}점 -> ${addShares}주 불타기`,
            created_at: nowIso,
          });
          console.log(`[모듈 #${mod.id}] ${held.symbol} 불타기 ${addShares}주 @ $${held.price}`);
        }
      }
      continue;
    }

    // ---------------------------------------------------------------------
    // CASE 2: 현금 관망 모듈 -> 방어 필터(ON/OFF) 검증 후 1차 분할 진입
    // ---------------------------------------------------------------------
    const candidates = refinedList.filter((s) => {
      if (s.price * 2 > cash) return false; // 최소 2주 매수 원칙
      if (mod.overheat_block && s.isOverheated) return false;
      if (mod.priced_in_filter && s.isPricedInRisk) return false;
      if (mod.big_news_cooling_3h && s.isBigNewsCrash) return false;
      if (mod.guidance_first && s.negHits > s.posHits) return false;
      return true;
    });

    if (candidates.length === 0) {
      console.log(`[모듈 #${mod.id}] 방어 필터 통과 후보 종목 없음 (관망 유지)`);
      continue;
    }

    // Jev 점수 높은 순으로 기본 정렬
    const sortedCandidates = [...candidates].sort((a, b) => b.jevScore - a.jevScore);

    let pick = null;
    if (mod.id === 1) pick = sortedCandidates.find((s) => s.jevScore >= 75) || sortedCandidates[0];
    if (mod.id === 2) pick = sortedCandidates.find((s) => s.price >= s.hvlFlip) || sortedCandidates[0];
    if (mod.id === 3) pick = sortedCandidates.find((s) => s.changePct <= 2.0 && s.jevScore >= 76);
    if (mod.id === 4) pick = [...candidates].sort((a, b) => b.changePct - a.changePct)[0];
    if (mod.id === 5) {
      const guruPool = ['PLTR', 'VST', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'AVGO', 'TSM', 'CEG'];
      pick = sortedCandidates.find((s) => guruPool.includes(s.symbol)) || sortedCandidates[0];
    }
    if (mod.id === 6) pick = sortedCandidates.find((s) => s.isDipOpportunity) || sortedCandidates[0];

    if (!pick) {
      console.log(`[모듈 #${mod.id}] 전략 조건 충족 종목 없음 (관망 유지)`);
      continue;
    }

    const firstPct = Number(mod.split_1st_pct || 30);
    const allocUsd = cash * (firstPct / 100);
    const buyShares = Math.max(2, Math.floor(allocUsd / pick.price));
    const totalCost = Number((buyShares * pick.price).toFixed(2));

    if (totalCost > cash) {
      console.log(`[모듈 #${mod.id}] ${pick.symbol} 최소 2주 매수 금액($${totalCost})이 잔액($${cash}) 초과 -> 스킵`);
      continue;
    }

    const remainCash = Number((cash - totalCost).toFixed(2));

    const { error: updateErr } = await sb
      .from('modules')
      .update({
        cash_usd: remainCash,
        invested_usd: totalCost,
        holding_ticker: pick.symbol,
        shares: buyShares,
        avg_price_usd: pick.price,
        roi_pct: 0,
        updated_at: nowIso,
      })
      .eq('id', mod.id);

    if (updateErr) {
      console.error(`[모듈 #${mod.id} DB 업데이트 실패]`, updateErr.message);
      continue;
    }

    const { error: logErr } = await sb.from('trade_logs').insert({
      module_id: mod.id,
      ticker: pick.symbol,
      action_type: `1차 분할매수 (${firstPct}%)`,
      shares: buyShares,
      price: pick.price,
      reason: `[자동발동: ${triggerSummary}] STEP 1 수집 → STEP 2 Jev ${pick.jevScore}점 → STEP 3 ${mod.ai_model} 필터 통과 후 ${buyShares}주 체결`,
      created_at: nowIso,
    });

    if (logErr) {
      console.error(`[모듈 #${mod.id} 로그 저장 실패]`, logErr.message);
    }

    console.log(`[모듈 #${mod.id}] ${pick.symbol} 1차 진입 ${buyShares}주 @ $${pick.price}`);
  }
}

// =========================================================================
// MAIN: 사용자 활성 감시 종목 로드 → 발동 기준 통과 시 4단계 파이프라인 실행
// =========================================================================
(async () => {
  try {
    console.log('=== [STEP 0] 무인 시세 감시 & 자동 발동 기준 판독 시작 ===');

    const { data: modules, error } = await sb.from('modules').select('*').order('id', { ascending: true });
    if (error || !modules) throw new Error(`Supabase modules 로드 실패: ${error?.message}`);

    const activeWatchlist = await loadActiveWatchlist(modules);
    const allQuotes = await fetchLightweightQuotes(activeWatchlist);
    if (allQuotes.length === 0) {
      console.log('[대기] 조회된 시세 데이터 없음 — 종료');
      return;
    }

    await syncHeldModulesValuation(allQuotes, modules);

    const gate = evaluateTriggerCriteria(allQuotes, modules);

    if (!gate.shouldTrigger) {
      console.log('=== [발동 기준 미충족] 시장 특이 변동 없음 — 4단계 파이프라인 스킵 ===');
      return;
    }

    console.log(`=== [기준 충족! 4단계 파이프라인 자동 발동] 사유: ${gate.summary} ===`);
    const deepData = await step1_collectDeepData(gate.targetQuotes, modules);
    const jevRefined = step2_jevRefine(deepData);
    await step3and4_analyzeAndExecute(jevRefined, modules, gate.summary);
    console.log('=== 4단계 파이프라인 자동 실행 완료 ===');
  } catch (err) {
    console.error('[Engine Fatal Error]', err);
    process.exit(1);
  }
})();