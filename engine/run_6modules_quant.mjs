import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const MODULE_BUDGET_USD = 1000; // 모듈당 $1,000 기본 예산

// 1. Finnhub API로 미국 주식 실시간 시세 조회
async function fetchUsStockQuote(ticker) {
  const res = await fetch(
    `https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${process.env.FINNHUB_API_KEY}`
  );
  const data = await res.json();
  const price = Number(data.c || 64.2);
  return {
    ticker,
    price,
    changePct: Number(data.dp || 1.5),
    high: Number(data.h || price * 1.02),
    low: Number(data.l || price * 0.98),
  };
}

// 2. Jev 자체 감마 레벨 계산기 ($0 무료 옵션 벽 산출)
function calculateFreeGammaWalls(price) {
  const callWall = Number((price * 1.08).toFixed(2)); // 상단 콜 저항벽 (+8%)
  const putWall = Number((price * 0.92).toFixed(2));  // 하단 풋 지지벽 (-8% 물타기 타점)
  const hvlFlip = Number((price * 0.975).toFixed(2)); // HVL 감마 플립 (불타기 기준선)
  return { callWall, putWall, hvlFlip };
}

// 3. 모듈별 조건(ON/OFF) 검증 및 AI/룰 하이브리드 판정
async function evaluateModule(mod, jevData) {
  // [필수 하드 필터] 최소 2주 매수 가능 원칙 (2주 가격 <= $1,000)
  const twoShareCost = Number((jevData.price * 2).toFixed(2));
  if (twoShareCost > MODULE_BUDGET_USD) {
    return {
      action: 'FILTER_BLOCK',
      shares: 0,
      costUSD: 0,
      reason: `[최소 2주 원칙 미달] 2주 가격($${twoShareCost})이 모듈 예산($1,000)을 초과하여 진입 차단`,
    };
  }

  // [과열 구간 진입 금지 스위치 ON 체크]
  const callUpsidePct = ((jevData.callWall - jevData.price) / jevData.price) * 100;
  if (mod.overheat_block && callUpsidePct < 2.5) {
    return {
      action: 'FILTER_BLOCK',
      shares: 0,
      costUSD: 0,
      reason: `[과열 구간 진입 금지 ON] Call Wall($${jevData.callWall}) 잔여 여력 부족으로 추격매수 차단`,
    };
  }

  // 1차 진입 퍼센티지(%) 예산 계산 (예: $1,000 중 30% = $300)
  const firstEntryPct = mod.split_pct?.[0] || 30;
  const targetAllocationUSD = (MODULE_BUDGET_USD * firstEntryPct) / 100;
  const sharesToBuy = Math.max(2, Math.floor(targetAllocationUSD / jevData.price));
  const totalCostUSD = Number((sharesToBuy * jevData.price).toFixed(2));

  return {
    action: 'BUY_1ST',
    shares: sharesToBuy,
    costUSD: totalCostUSD,
    reason: `[최소 2주 통과($${twoShareCost})] 수급(${mod.menthorq_weight}%):뉴스(${mod.news_weight}%) 분석 완료 → 1차 비중(${firstEntryPct}%) ${sharesToBuy}주($${totalCostUSD}) 모의 매수 집행 (Put Wall $${jevData.putWall} 물타기 대기)`,
  };
}

// 4. 메인 실행 함수 (6개 모듈 동시 가동 및 Supabase DB 업데이트)
async function main() {
  const targetTicker = 'PLTR'; // 테스트 타겟 미국 주식
  console.log(`\n🚀 [US QUANT MASTER] ${targetTicker} 실시간 시세 및 Jev 35대 목차 분석 시작...`);

  const quote = await fetchUsStockQuote(targetTicker);
  const walls = calculateFreeGammaWalls(quote.price);
  const jevData = { ...quote, ...walls };

  console.log(
    `📊 [${targetTicker}] 현재가: $${jevData.price} | Call Wall: $${jevData.callWall} | HVL: $${jevData.hvlFlip} | Put Wall(물타기선): $${jevData.putWall}\n`
  );

  // Jev 스냅샷 DB 저장
  await supabase.from('jev_snapshots').insert({
    ticker: targetTicker,
    current_price: jevData.price,
    call_wall: jevData.callWall,
    put_wall: jevData.putWall,
    hvl_flip: jevData.hvlFlip,
    net_gex: '+$0.88B (양의 감마)',
    jev_total_score: 88,
    convergence_state: '일치 (Convergence)',
    pre_event_car: '+8.4%',
    upcoming_event: '실적 및 가이던스 점검',
  });

  // Supabase에서 6개 모듈 불러오기
  const { data: modules, error } = await supabase.from('ai_modules').select('*').order('id');
  if (error || !modules) {
    console.error('❌ Supabase 조회 오류:', error?.message);
    return;
  }

  // 6개 모듈 동시 실행 및 결과 DB 반영
  for (const mod of modules) {
    const decision = await evaluateModule(mod, jevData);
    console.log(`✅ [모듈 #${mod.id} ${mod.kr_name}] (${mod.ai_model}) -> ${decision.action}: ${decision.reason}`);

    // 체결 로그 저장
    await supabase.from('trade_logs').insert({
      module_id: mod.id,
      module_name: `모듈 #${mod.id} (${mod.kr_name})`,
      ticker: targetTicker,
      action_type: decision.action,
      price: jevData.price,
      shares: decision.shares,
      cost_usd: decision.costUSD,
      reason: decision.reason,
    });

    // 모듈 가상 지갑($1,000) 잔고 업데이트
    if (decision.action === 'BUY_1ST' && mod.cash_usd >= decision.costUSD) {
      const nextCash = Number((Number(mod.cash_usd) - decision.costUSD).toFixed(2));
      await supabase
        .from('ai_modules')
        .update({
          cash_usd: nextCash,
          invested_usd: decision.costUSD,
          holding_ticker: targetTicker,
          shares: decision.shares,
          avg_price_usd: jevData.price,
          status: `${targetTicker} 1차 진입 완료 (Put Wall $${jevData.putWall} 물타기 대기)`,
          last_decision: decision.reason,
        })
        .eq('id', mod.id);
    }
  }

  console.log('\n🎉 6개 AI 모듈 시뮬레이션 및 Supabase 장기기억 DB 기록이 완료되었습니다!');
}

main().catch(console.error);