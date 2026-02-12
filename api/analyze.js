// api/analyze.js — Vercel Serverless Function
// Claude Sonnet 4.5로 영수증 이미지를 분석합니다.

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });
  }

  try {
    const { image, mediaType, fileName } = req.body;
    if (!image) return res.status(400).json({ error: "image (base64) required" });

    // PDF vs 이미지 구분
    const isPdf = (mediaType || "").includes("pdf");
    const contentBlock = isPdf
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: image } }
      : { type: "image", source: { type: "base64", media_type: mediaType || "image/jpeg", data: image } };

    // Claude API 호출
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5-20250929",
        max_tokens: 8192,
        messages: [
          {
            role: "user",
            content: [
              contentBlock,
              {
                type: "text",
                text: ANALYSIS_PROMPT,
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Claude API error:", response.status, errText);
      return res.status(502).json({ error: `Claude API error: ${response.status}`, detail: errText });
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || "";

    // JSON 추출 (여러 패턴 시도)
    let parsed = null;

    // 1차: ```json ... ``` 코드블록 (닫는 ``` 있는 경우)
    const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      try { parsed = JSON.parse(codeBlockMatch[1].trim()); } catch (e) { /* fallthrough */ }
    }

    // 2차: ```json 뒤의 내용 (닫는 ``` 없는 경우)
    if (!parsed) {
      const openBlockMatch = text.match(/```(?:json)?\s*([\s\S]*)/);
      if (openBlockMatch) {
        const content = openBlockMatch[1].replace(/```\s*$/, "").trim();
        try { parsed = JSON.parse(content); } catch (e) { /* fallthrough */ }
      }
    }

    // 3차: 전체 텍스트를 JSON으로
    if (!parsed) {
      try { parsed = JSON.parse(text.trim()); } catch (e) { /* fallthrough */ }
    }

    // 4차: [ ] 또는 { } 블록 추출
    if (!parsed) {
      const bracketMatch = text.match(/\[[\s\S]*\]/);
      if (bracketMatch) {
        try { parsed = JSON.parse(bracketMatch[0]); } catch (e) { /* fallthrough */ }
      }
    }
    if (!parsed) {
      const braceMatch = text.match(/\{[\s\S]*\}/);
      if (braceMatch) {
        try { parsed = JSON.parse(braceMatch[0]); } catch (e) { /* fallthrough */ }
      }
    }

    // 5차: 잘린 JSON 배열 복구 (max_tokens 초과 시)
    if (!parsed) {
      const recovered = recoverTruncatedArray(text);
      if (recovered) {
        parsed = recovered;
        console.warn("⚠️ 잘린 JSON 복구 성공:", parsed.length, "건");
      }
    }

    if (!parsed) {
      console.error("JSON parse failed. Raw text:", text);
      return res.status(500).json({ error: "Claude 응답을 파싱할 수 없습니다", raw: text.slice(0, 500) });
    }

    // 다중 영수증 응답 정규화 → 항상 배열로 반환
    let items;
    if (Array.isArray(parsed)) {
      items = parsed;
    } else if (parsed.type) {
      // 단일 영수증
      items = [parsed];
    } else {
      // 객체에 숫자 키로 들어온 경우 ({"0": {...}, "1": {...}})
      const numKeys = Object.keys(parsed).filter((k) => /^\d+$/.test(k));
      if (numKeys.length > 0) {
        items = numKeys.sort((a, b) => Number(a) - Number(b)).map((k) => parsed[k]);
      } else {
        items = [parsed];
      }
    }

    // 각 항목에 proofMetro 계산
    const results = items.map((item) => enrichResult(item, fileName));

    return res.status(200).json(results);
  } catch (err) {
    console.error("Analysis error:", err);
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
}

// ── 분석 프롬프트 ──
const ANALYSIS_PROMPT = `당신은 한국 공공기관의 출장 영수증 분석 전문가입니다.
업로드된 문서/이미지를 분석하여 아래 형식으로 JSON 배열을 반환하세요.
영수증이 1개라도 반드시 배열([...])로 감싸세요. 여러 영수증이면 배열에 모두 포함하세요.
반드시 JSON만 출력하세요. 설명이나 마크다운 없이 순수 JSON만 출력하세요.

★★★ 다건 처리 (최우선 규칙) ★★★
1건의 PDF/이미지에 여러 건의 영수증/내역이 포함되어 있으면, 절대 요약하거나 합산하지 말고 각 건을 개별 JSON 객체로 분리하여 배열에 모두 포함하세요.
- 하이패스 명세서/통행내역서: 표에 있는 각 행(각 톨게이트 통과 내역)을 개별 toll_receipt으로 분리. 8건이면 8개, 20건이면 20개의 toll_receipt을 배열에 포함.
- 철도 왕복 예매: 가는편/오는편을 각각 별도 rail_receipt으로 분리.
- 숙박 여러 건: 각 숙박을 개별 lodging_receipt으로 분리.
- 혼합 스캔: 여러 종류 영수증이 섞여 있으면 각각 해당 유형으로 분리.
누락 없이 문서에 보이는 모든 내역을 빠짐없이 개별 항목으로 출력하세요.

■ 유형 분류 핵심 규칙 (반드시 준수!)
- 철도(rail_receipt): 반드시 KTX, SRT, ITX, 무궁화 등 열차 승차권/예매내역만 해당. "역"이라는 글자가 있어도 톨게이트/고속도로 영수증이면 rail이 아님!
- 톨게이트(toll_receipt): 하이패스, 톨게이트, IC, 고속도로 통행료 영수증. "IC", "톨게이트", "하이패스", "통행료" 키워드가 있으면 반드시 toll_receipt.
- 숙박(lodging_receipt): 호텔, 모텔, 펜션, 게스트하우스, 숙소, 리조트, 에어비앤비 등 숙박업소 영수증. "호텔", "모텔", "펜션", "숙박", "HOTEL", "MOTEL", "INN", "객실", "투숙" 키워드 → 반드시 lodging_receipt. 절대 local_receipt로 분류하지 마세요!
- 현지(local_receipt): 편의점, 식당, 카페, 마트 등 일반 매장 영수증만 해당. 숙박업소 영수증을 현지영수증으로 분류하면 안 됩니다.

■ 금액 기반 분류 보조 규칙 (실무 휴리스틱)
금액을 보고 유형을 재검증하세요:
- 금액이 30,000원 이상 → 숙박 영수증일 가능성이 매우 높음. "호텔", "모텔", "펜션" 등의 키워드가 조금이라도 보이면 반드시 lodging_receipt으로 분류
- 금액이 5,000원 미만 → 현지 영수증(편의점, 카페 등)일 가능성이 높음. 단, "숙박", "호텔" 키워드가 있으면 금액과 무관하게 lodging_receipt
- 금액이 5,000원~30,000원 사이 → 키워드와 맥락을 종합적으로 판단
예시:
- "IBK 비비카드 / 가맹점: 호텔아이콘 / 70,000원" → 금액 70,000원 + "호텔" 키워드 = 100% lodging_receipt
- "GS25 세종점 / 3,500원" → 금액 3,500원 + 편의점명 = local_receipt
- "○○식당 / 45,000원" → 금액 45,000원이지만 "식당" 키워드 = local_receipt (식사 영수증)

■ 숙박 영수증 특별 주의사항 (절대 실수하지 마세요!)
- IBK 비비카드, 나이스페이먼츠, KG이니시스 등 PG사 결제 영수증이라도 → 가맹점명/업체명에 "호텔", "모텔", "펜션", "리조트", "게스트하우스" 등이 포함되면 반드시 lodging_receipt
- 야놀자, 여기어때, Booking.com, Agoda, Airbnb 등 숙박 예약 플랫폼의 예약 확인서 → lodging_receipt
- "객실", "체크인", "체크아웃", "투숙", "1박" 등의 단어가 있으면 → lodging_receipt
- 금액이 30,000원 이상이고 가맹점명에 숙박 관련 힌트가 조금이라도 있으면 → lodging_receipt

■ 주소 추출 규칙 (시/군/구 단위로 간소화)
- "전라북도 군산시 ○○동 123번지" → address: "군산시"
- "호텔아이콘 (전북 군산시)" → address: "군산시"
- "서울특별시 강남구 역삼동" → address: "서울시"
- "충북 청주시 흥덕구 오송읍" → address: "오송" (오송은 특별 처리)
- "세종특별자치시 어진동" → address: "세종시"
- "경기도 수원시" → address: "수원시"
- "부산광역시" → address: "부산시"
- 주소를 확인할 수 없으면 빈 문자열("")
주소 추출 방법:
1. "주소:", "사업장 소재지:", "가맹점 주소:" 라벨 옆 텍스트
2. 가맹점명 근처에 표시된 지역명

■ 철도 영수증 (KTX, SRT, ITX, 무궁화 등 열차 승차권만)
{
  "type": "rail_receipt",
  "category": "철도영수증",
  "data": {
    "date": "YYYY-MM-DD 또는 빈문자열",
    "from": "출발역",
    "to": "도착역",
    "trainNo": "열차번호 (예: KTX 301)",
    "seatClass": "일반실 또는 특실",
    "amount": 실제 카드/현금 결제 금액(숫자). 포인트·마일리지 결제분 제외,
    "cardLast4": "결제 카드번호 끝4자리 또는 빈문자열",
    "approvalLast4": "승인번호 끝4자리 또는 빈문자열"
  }
}

■ 숙박 영수증 (호텔, 모텔, 펜션, 게스트하우스, 리조트 등)
{
  "type": "lodging_receipt",
  "category": "숙박영수증",
  "data": {
    "hotelName": "호텔/숙소명",
    "date": "YYYY-MM-DD 또는 빈문자열",
    "amount": 실제 카드/현금 결제 금액(숫자). 포인트·마일리지 결제분 제외,
    "address": "시/군/구 단위 주소 (예: 군산시, 서울시, 오송)",
    "cardLast4": "결제 카드번호 끝4자리 또는 빈문자열"
  }
}

■ 톨게이트 영수증 (하이패스, 고속도로 통행료)
{
  "type": "toll_receipt",
  "category": "톨게이트영수증",
  "data": {
    "tollGate": "톨게이트명",
    "amount": 실제 카드/현금 결제 금액(숫자). 포인트·마일리지 결제분 제외,
    "date": "YYYY-MM-DD 또는 빈문자열",
    "cardLast4": "결제 카드번호 끝4자리 또는 빈문자열"
  }
}

■ 현지 영수증 (편의점, 식당, 카페, 마트 등 일반 매장만)
{
  "type": "local_receipt",
  "category": "현지영수증",
  "data": {
    "storeName": "가게명",
    "amount": 실제 카드/현금 결제 금액(숫자). 포인트·마일리지 결제분 제외,
    "date": "YYYY-MM-DD 또는 빈문자열",
    "address": "시/군/구 단위 주소 (예: 군산시, 서울시, 오송)",
    "cardLast4": "결제 카드번호 끝4자리 또는 빈문자열"
  }
}

■ 지도 캡처 (네이버지도, 카카오맵 등)
{
  "type": "map_capture",
  "category": "지도캡처",
  "data": {
    "from": "출발지",
    "to": "도착지",
    "distanceKm": 거리(숫자, km),
    "estimatedMinutes": 예상시간(숫자, 분)
  }
}
거리는 소수점 이하 반올림하여 정수(km)로 반환하세요.
경로 검색 결과에 여러 경로가 있으면 최단거리(추천경로)의 거리를 사용하세요.

■ 위 어디에도 해당하지 않는 경우
{
  "type": "unknown",
  "category": "기타첨부",
  "data": {}
}

■ 다건 처리 보충 (위의 ★★★ 규칙 참고)
- 하이패스 명세서: 표의 각 행 = 개별 toll_receipt. 날짜·톨게이트명·금액을 각각 정확히 분리.
- 철도 왕복: 가는편/오는편 = 2개의 rail_receipt. 각각의 cardLast4, approvalLast4 추출.
- 혼합 스캔: KTX + 톨게이트 = [rail_receipt, toll_receipt]으로 분리.

금액은 반드시 숫자(정수)로 반환하세요. 쉼표나 "원" 없이 숫자만.
★★ 결제 수단이 여러 개인 경우 (포인트+카드, 마일리지+현금, 쿠폰+카드 등):
  - amount에는 실제 카드/현금 결제 금액만 포함하세요.
  - 포인트·마일리지·쿠폰·적립금 결제분은 반드시 제외합니다.
  - 예) "포인트 결제 1,600원, 신용카드 결제 18,500원" → amount: 18500
  - 예) "마일리지 5,000원, 카드 결제 40,000원" → amount: 40000
날짜를 확인할 수 없으면 빈 문자열("")로.
주소를 확인할 수 없으면 빈 문자열("")로.
가게명(storeName)은 "상호", "가맹점", "가맹점명" 옆에 표시된 이름을 사용하세요. 주소 근처에 있는 경우도 많습니다.

■ 카드번호 인식 (모든 유형에 해당, data 안에 포함)
영수증에 결제 카드번호가 표시된 경우 끝 4자리만 "cardLast4"에 입력하세요.
확인할 수 없으면 빈 문자열("").
- 카드번호 마스킹 변형: "****-****-****-1234", "카드(끝번호)1234", "카드번호 **** 1234", "VISA ****1234", "BC ****1234" → 끝 4자리 추출
- 숫자 4자리만 입력 (예: "1234"). 하이픈이나 공백 없이.

■ 승인번호 인식 (철도 영수증만 해당!)
철도 영수증(rail_receipt)에만 "approvalLast4" 필드를 포함하세요.
다른 유형(숙박, 톨게이트, 현지)에는 승인번호를 추출하지 마세요.
- 승인번호 변형: "승인번호: 12345678", "승인No.12345678" → 끝 4자리 추출
- 확인할 수 없으면 빈 문자열("").

날짜 추출: "이용일시", "거래일시", "결제일시", "승인일시" 등에서 날짜(YYYY-MM-DD)만 추출.

■ 신뢰도 (confidence) — 모든 영수증 객체에 반드시 포함!
"confidence" 필드를 0.0~1.0 사이의 소수로 반드시 포함하세요.
- 0.85~1.0: 영수증 유형, 금액, 날짜 등 모든 핵심 정보가 명확히 확인됨
- 0.5~0.84: 일부 정보가 불확실하거나 글자가 흐림
- 0.5 미만: 유형 판단이 어렵거나 핵심 정보를 읽을 수 없음

■ 비용 분류 (expenseCategory) — 모든 영수증 객체에 반드시 포함!
"expenseCategory" 필드를 다음 3가지 중 하나로 반드시 포함하세요:
- "교통비": rail_receipt, toll_receipt 유형 (철도, 톨게이트, 자가차량 등 교통 관련)
- "숙박비": lodging_receipt 유형 (호텔, 모텔, 펜션 등 숙박)
- "현지인증": local_receipt 유형 (편의점, 식당 등 현지 영수증으로 출장지 방문 증빙)
- map_capture와 unknown은 "현지인증"으로 분류

■ 불확실성 표시 및 질문
confidence가 0.8 미만일 때만 "questions" 필드를 포함하세요.
confidence 0.8 이상이면 questions를 포함하지 마세요 (자동 분류됩니다).
questions는 한국어 문자열 배열이며, 여비정산 내역표에 필요한 정보만 물어보세요.

질문이 필요한 경우:
1. 톨게이트 영수증 → 반드시 confidence를 0.8 미만으로 설정하고 "자가차량(본인 소유)으로 이동하셨나요, 공용차량(관용차)으로 이동하셨나요?" 질문
2. 글자가 흐리거나 잘려서 금액/날짜를 정확히 읽기 어려운 경우
3. 영수증 유형이 애매한 경우 (예: 숙박인지 식당인지 불분명)
4. 날짜를 확인할 수 없는 경우 → "영수증의 날짜를 확인할 수 없습니다. 이용 날짜가 언제인가요?"
5. 금액이 불분명한 경우

예: "confidence": 0.6, "questions": ["자가차량(본인 소유)으로 이동하셨나요, 공용차량(관용차)으로 이동하셨나요?"]`;

// ── 잘린 JSON 배열 복구 ──
// max_tokens 초과로 응답이 잘린 경우, 완전한 객체만 추출
function recoverTruncatedArray(text) {
  // 텍스트에서 [ 로 시작하는 부분 찾기
  const startIdx = text.indexOf("[");
  if (startIdx === -1) return null;

  const content = text.slice(startIdx);
  const items = [];
  let depth = 0;
  let objStart = -1;

  for (let i = 1; i < content.length; i++) {
    const ch = content[i];
    if (ch === "{" && depth === 0) {
      objStart = i;
      depth = 1;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && objStart !== -1) {
        const objStr = content.slice(objStart, i + 1);
        try {
          items.push(JSON.parse(objStr));
        } catch (e) { /* 파싱 불가한 객체는 건너뜀 */ }
        objStart = -1;
      }
    }
  }

  return items.length > 0 ? items : null;
}

// ── 광역지자체 매핑 ──
const METRO_MAP = {
  서울: ["서울", "서울특별시"],
  부산: ["부산", "부산광역시"],
  대구: ["대구", "대구광역시"],
  인천: ["인천", "인천광역시"],
  광주: ["광주", "광주광역시"],
  대전: ["대전", "대전광역시"],
  울산: ["울산", "울산광역시"],
  세종: ["세종", "세종특별자치시", "세종시"],
  경기: ["경기", "경기도", "수원", "성남", "용인", "안양", "안산", "고양", "과천", "광명", "구리", "군포", "김포", "남양주", "부천", "시흥", "양주", "여주", "오산", "의왕", "의정부", "이천", "파주", "평택", "포천", "하남", "화성"],
  강원: ["강원", "강원특별자치도", "강원도", "춘천", "원주", "강릉", "속초", "동해", "태백", "삼척"],
  충북: ["충북", "충청북도", "청주", "충주", "제천", "오송"],
  충남: ["충남", "충청남도", "천안", "아산", "논산", "공주", "서산", "당진", "보령", "홍성"],
  전북: ["전북", "전북특별자치도", "전라북도", "전주", "익산", "군산", "정읍"],
  전남: ["전남", "전라남도", "목포", "여수", "순천", "나주", "광양"],
  경북: ["경북", "경상북도", "포항", "경주", "구미", "안동", "김천", "영주"],
  경남: ["경남", "경상남도", "창원", "김해", "진주", "양산", "거제", "통영"],
  제주: ["제주", "제주특별자치도", "제주도", "제주시", "서귀포"],
};

function detectMetro(text) {
  if (!text) return null;
  for (const [metro, keywords] of Object.entries(METRO_MAP)) {
    for (const kw of keywords) {
      if (text.includes(kw)) return metro;
    }
  }
  return null;
}

function enrichResult(parsed, fileName) {
  let proofMetro = null;
  let isProof = false;

  if (parsed.type === "rail_receipt" || parsed.type === "toll_receipt") {
    isProof = true;
  } else if (parsed.type === "lodging_receipt") {
    isProof = true;
    proofMetro = detectMetro(parsed.data?.address);
  } else if (parsed.type === "local_receipt") {
    isProof = true;
    proofMetro = detectMetro(parsed.data?.address);
  }

  // expenseCategory 자동 매핑 (AI가 누락한 경우 대비)
  let expenseCategory = parsed.expenseCategory;
  if (!expenseCategory) {
    if (parsed.type === "rail_receipt" || parsed.type === "toll_receipt") {
      expenseCategory = "교통비";
    } else if (parsed.type === "lodging_receipt") {
      expenseCategory = "숙박비";
    } else {
      expenseCategory = "현지인증";
    }
  }

  return {
    ...parsed,
    proofMetro,
    isProof,
    simulated: false,
    confidence: parsed.confidence ?? 0.5,
    expenseCategory,
  };
}
