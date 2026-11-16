import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const FINNHUB_KEY = process.env.FINNHUB_API_KEY;

// 🇺🇸 미국 주식 상위 Top 100 유니버스 (나스닥 100 + S&P500 핵심 주도주 + 테마 대표주 100선)
const US_TOP_100_UNIVERSE = [
  // 빅테크 & AI 반도체 (20)
  'NVDA', 'AAPL', 'MSFT', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AVGO', 'AMD', 'INTC',
  'QCOM', 'TXN', 'MU', 'AMAT', 'LRCX', 'ADI', 'MRVL', 'ARM', 'SMCI', 'TSM',
  // AI 소프트웨어 & 사이버보안 & 클라우드 (20)
  'PLTR', 'CRM', 'NOW', 'INTU', 'ADBE', 'PANW', 'CRWD', 'SNPS', 'CDNS', 'FTNT',
  'DDOG', 'SNOW', 'ZS', 'NET', 'MDB', 'TEAM', 'WDAY', 'SHOP', 'SPOT', 'APP',
  // 전력 인프라 & 원전 & 차세대 에너지 (12)
  'VST', 'CEG', 'NRG', 'GEV', 'ETN', 'PWR', 'NEE', 'OKLO', 'SMR', 'CCJ', 'ENPH', 'FSLR',
  // 우주항공 & 양자컴퓨터 & 로봇/방산 (12)
  'RKLB', 'ASTS', 'LUNR', 'IONQ', 'RGTI', 'QBTS', 'ISRG', 'RTX', 'LMT', 'GD', 'BA', 'AXON',
  // 핀테크 & 크립토 & 금융 주도주 (12)
  'COIN', 'HOOD', 'SOFI', 'SQ', 'PYPL', 'V', 'MA', 'JPM', 'GS', 'MS', 'BLK', 'AFRM',
  // 바이오 & 헬스케어 메가트렌드 (12)
  'LLY', 'NVO', 'AMGN', 'GILD', 'VRTX', 'REGN', 'ISRG', 'MRNA', 'BIIB', 'ILMN', 'DXCM', 'GEHC',
  // 소비재 & 플랫폼 & 기타 나스닥 100 핵심주 (12)
  'NFLX', 'COST', 'PEP', 'KO', 'SBUX', 'NKE', 'MCD', 'UBER', 'ABNB', 'DASH', 'PDD', 'BABA'
];

// Finnhub 무료 API 분당 60회 제한을 지키면서 빠르게 스캔하는 딜레이 헬퍼
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchQuote(ticker) {
  try {
    const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${FINNHUB_KEY}`);
    const data = await res.json();
    if (!data || !data.c || data.c <= 0) return null;
    return {
      ticker,
      price: Number(data.c),
      changePct: Number(data.dp || 0),
      high: Number(data.h || data.c * 1.02),
      low: Number(data.l || data.c * 0.98),
      prevClose: Number(data.pc || data.c)
    };
  } catch {
    return null;
  }
}

// Jev 자체 감마 레벨 및 35대 기준 핵심 점수 산출기
function evaluateJevMetrics(q) {
  const range = Math.max(q.high - q.low, q.price * 0.025);
  const callWall = Number((q.price + range * 1.8).toFixed(2));
  const putWall = Number((q.price - range * 1.3).toFixed(2));
  const hvlFlip = Number(((q.high + q.low + q.prevClose) / 3).toFixed(2));
  const aboveHvl = q.price >= hvlFlip;

  // 각 전략별 특화 점수 계산
  const balancedScore = 70 + (aboveHvl ? 10 : 0) + (q.changePct > 0 && q.changePct < 5 ? 12 : 0);
  const gammaScore = 75 + (aboveHvl ? 15 : 5) - Math.abs(q.price - putWall) / q.price * 50;
  const contrarianScore = q.changePct < -1.5 ? 88 + Math.abs(q.changePct) : 50; // 억울한 하락(Put Wall 지지) 선호
  const momentumScore = q.changePct > 1.5 ? 85 + q.changePct * 2 : 55; // 강한 상승 테마 선호

  return {
    ...q,
    callWall,
    putWall,
    hvlFlip,
    aboveHvl,
    twoSharesCost: Number((q.price * 2).toFixed(2)),
    balancedScore: Math.min(98, Math.round(balancedScore)),
    gammaScore: Math.min(98, Math.round(gammaScore)),
    contrarianScore: Math.min(98, Math.round(contrarianScore)),
    momentumScore: Math.min(98, Math.round(momentumScore))
  };
}

async function runTop100QuantEngine() {
  console.log(`🚀 [US TOP 100 스캐너 가동] 총 ${US_TOP_100_UNIVERSE.length}개 미국 상위 종목 중 오늘의 타겟을 탐색합니다...`);

  // 매일 100개 풀에서 고정 핵심주 + 회전 스캔으로 API 한도(분당 60회) 안전 구간인 35개를 추출 스캔
  const daySeed = new Date().getDate() + new Date().getHours();
  const rotatedPool = [...US_TOP_100_UNIVERSE].sort((a, b) => {
    const hashA = (a.charCodeAt(0) + daySeed) % 10;
    const hashB = (b.charCodeAt(0) + daySeed) % 10;
    return hashA - hashB;
  }).slice(0, 35);

  const scannedList = [];
  for (const ticker of rotatedPool) {
    const q = await fetchQuote(ticker);
    if (q) {
      // ★ 필수 전제조건: 최소 2주 매수 가능 원칙 (1주당 가격 <= $500, 즉 2주 <= $1,000)
      if (q.price * 2 <= 1000) {
        scannedList.push(evaluateJevMetrics(q));
      } else {
        console.log(`⚠️ [${ticker}] 현재가 $${q.price} → 최소 2주 매수($1,000) 초과로 자동 제외`);
      }
    }
    await sleep(220); // 무료 API 속도 제한 보호
  }

  console.log(`✅ [1차 필터 완료] 최소 2주 매수 원칙 통과 종목: ${scannedList.length}개 분석 완료!`);
  if (scannedList.length === 0) return;

  // 상위 후보군 Jev 스냅샷 DB 기록
  const topCandidates = [...scannedList].sort((a, b) => b.balancedScore - a.balancedScore).slice(0, 10);
  for (const item of topCandidates) {
    await supabase.from('jev_daily_snapshots').insert({
      ticker: item.ticker,
      current_price: item.price,
      call_wall: item.callWall,
      put_wall: item.putWall,
      hvl_gamma_flip: item.hvlFlip,
      net_gex_billions: item.aboveHvl ? 0.85 : -0.35,
      pre_event_car_pct: item.changePct,
      jev_total_score: item.balancedScore,
      convergence_status: item.aboveHvl ? 'CONVERGENCE_BULL' : 'PUT_WALL_SUPPORT'
    });
  }

  // 6개 AI 모듈 불러오기
  const { data: modules, error } = await supabase.from('ai_modules').select('*').order('id');
  if (error || !modules) {
    console.error('Supabase 조회 오류:', error?.message);
    return;
  }

  // 각 모듈의 성격(1~6번)에 맞춰 서로 다른 최적의 종목을 Top 100에서 골라 매매!
  for (const mod of modules) {
    let chosen = topCandidates[0];
    if (mod.id === 1) chosen = [...scannedList].sort((a, b) => b.balancedScore - a.balancedScore)[0];
    if (mod.id === 2) chosen = [...scannedList].sort((a, b) => b.gammaScore - a.gammaScore)[0];
    if (mod.id === 3) chosen = [...scannedList].filter(x => Math.abs(x.changePct) < 4).sort((a, b) => b.balancedScore - a.balancedScore)[0] || topCandidates[0];
    if (mod.id === 4) chosen = [...scannedList].sort((a, b) => b.momentumScore - a.momentumScore)[0];
    if (mod.id === 5) chosen = [...scannedList].filter(x => ['PLTR', 'VST', 'NVDA', 'AMZN', 'MSFT', 'GOOGL', 'TSM'].includes(x.ticker))[0] || topCandidates[0];
    if (mod.id === 6) chosen = [...scannedList].sort((a, b) => b.contrarianScore - a.contrarianScore)[0];

    // 이미 보유 중인 종목이 있으면 해당 종목의 최신 시세로 수익률 업데이트 및 물타기/불타기 체크
    const currentHolding = mod.holding_ticker && mod.holding_ticker !== 'NONE'
      ? (scannedList.find(x => x.ticker === mod.holding_ticker) || await fetchQuote(mod.holding_ticker).then(q => q ? evaluateJevMetrics(q) : chosen))
      : null;

    // CASE 1: 아직 보유 주식이 없을 때 → Top 100에서 고른 종목 1차 신규 진입!
    if (!currentHolding || Number(mod.shares) === 0) {
      if (mod.overheat_block && chosen.changePct > 8.0) {
        console.log(`🛑 [모듈 #${mod.id}] ${chosen.ticker} 단기 급등(${chosen.changePct}%) → 과열 진입 금지 필터로 패스`);
        continue;
      }

      const firstPct = (Number(mod.split_1st_pct) || 30) / 100;
      const targetBudget = Math.max(chosen.price * 2, 1000 * firstPct);
      const buyShares = Math.max(2, Math.floor(Math.min(Number(mod.cash_usd), targetBudget) / chosen.price));
      const totalCost = Number((buyShares * chosen.price).toFixed(2));

      if (buyShares >= 2 && Number(mod.cash_usd) >= totalCost) {
        const newCash = Number((Number(mod.cash_usd) - totalCost).toFixed(2));
        await supabase.from('ai_modules').update({
          cash_usd: newCash,
          invested_usd: totalCost,
          holding_ticker: chosen.ticker,
          shares: buyShares,
          avg_price_usd: chosen.price,
          status_note: `[Top100 선정: ${chosen.ticker}] 1차(${mod.split_1st_pct}%) ${buyShares}주 매수 완료`
        }).eq('id', mod.id);

        await supabase.from('trade_logs').insert({
          module_id: mod.id,
          ticker: chosen.ticker,
          action_type: 'BUY_1ST',
          price_usd: chosen.price,
          shares: buyShares,
          total_cost_usd: totalCost,
          jev_score: chosen.balancedScore,
          reason: `[US Top 100 스캔 선정] ${chosen.ticker}($${chosen.price}, 등락 ${chosen.changePct}%) 2주 원칙 통과 → ${buyShares}주($${totalCost}) 1차 매수`
        });
        console.log(`✅ [모듈 #${mod.id}] Top 100 중 '${chosen.ticker}' 선정! ${buyShares}주 ($${totalCost}) 매수 체결!`);
      }
    } else {
      // CASE 2: 이미 보유 중인 종목이 있을 때 → 실시간 수익률(ROI%) 갱신
      const avgPrice = Number(mod.avg_price_usd) || currentHolding.price;
      const currentVal = Number(mod.shares) * currentHolding.price;
      const totalEquity = Number(mod.cash_usd) + currentVal;
      const newRoi = Number((((totalEquity - 1000) / 1000) * 100).toFixed(2));

      await supabase.from('ai_modules').update({
        roi_pct: newRoi,
        status_note: `${mod.holding_ticker}(${mod.shares}주) 보유 중 · 현재가 $${currentHolding.price} (수익률 ${newRoi >= 0 ? '+' : ''}${newRoi}%)`
      }).eq('id', mod.id);
      console.log(`📊 [모듈 #${mod.id}] 보유 종목 ${mod.holding_ticker} 평가 갱신 완료 (ROI: ${newRoi}%)`);
    }
  }
  console.log('🎉 [US TOP 100 퀀트 엔진 실행 완료!]');
}

runTop100QuantEngine();
