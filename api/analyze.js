// api/analyze.js — Vercel Serverless Function
// Claude Haiku 4.5로 영수증 이미지를 분석합니다.

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
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
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

■ 유형 분류 핵심 규칙 (반드시 준수!)
- 철도(rail_receipt): 반드시 KTX, SRT, ITX, 무궁화 등 열차 승차권/예매내역만 해당. "역"이라는 글자가 있어도 톨게이트/고속도로 영수증이면 rail이 아님!
- 톨게이트(toll_receipt): 하이패스, 톨게이트, IC, 고속도로 통행료 영수증. "IC", "톨게이트", "하이패스", "통행료" 키워드가 있으면 반드시 toll_receipt.
- 숙박(lodging_receipt): 호텔, 모텔, 펜션, 게스트하우스, 숙소, 리조트, 에어비앤비 등 숙박업소 영수증. "호텔", "모텔", "펜션", "숙박", "HOTEL", "MOTEL", "INN", "객실", "투숙" 키워드 → 반드시 lodging_receipt. 절대 local_receipt로 분류하지 마세요!
- 현지(local_receipt): 편의점, 식당, 카페, 마트 등 일반 매장 영수증만 해당. 숙박업소 영수증을 현지영수증으로 분류하면 안 됩니다.

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
    "amount": 금액(숫자)
  }
}

■ 숙박 영수증 (호텔, 모텔, 펜션, 게스트하우스, 리조트 등)
{
  "type": "lodging_receipt",
  "category": "숙박영수증",
  "data": {
    "hotelName": "호텔/숙소명",
    "date": "YYYY-MM-DD 또는 빈문자열",
    "amount": 금액(숫자),
    "address": "전체 주소"
  }
}

■ 톨게이트 영수증 (하이패스, 고속도로 통행료)
{
  "type": "toll_receipt",
  "category": "톨게이트영수증",
  "data": {
    "tollGate": "톨게이트명",
    "amount": 금액(숫자),
    "date": "YYYY-MM-DD 또는 빈문자열"
  }
}

■ 현지 영수증 (편의점, 식당, 카페, 마트 등 일반 매장만)
{
  "type": "local_receipt",
  "category": "현지영수증",
  "data": {
    "storeName": "가게명",
    "amount": 금액(숫자),
    "date": "YYYY-MM-DD 또는 빈문자열",
    "address": "전체 주소 (영수증에 있는 경우)"
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

■ 위 어디에도 해당하지 않는 경우
{
  "type": "unknown",
  "category": "기타첨부",
  "data": {}
}

금액은 반드시 숫자(정수)로 반환하세요. 쉼표나 "원" 없이 숫자만.
날짜를 확인할 수 없으면 빈 문자열("")로.
주소를 확인할 수 없으면 빈 문자열("")로.
가게명(storeName)은 "상호", "가맹점", "가맹점명" 옆에 표시된 이름을 사용하세요. 주소 근처에 있는 경우도 많습니다.

■ 불확실성 표시 및 질문 (매우 중요! 적극적으로 질문하세요!)
각 영수증 객체 안에 "questions" 필드를 추가하여 사용자에게 확인이 필요한 사항을 질문하세요.
questions는 한국어 문자열 배열입니다.

반드시 질문해야 하는 경우 (무조건 questions 포함):
1. 톨게이트 영수증 → 반드시 "자가차량(본인 소유)으로 이동하셨나요, 공용차량(관용차)으로 이동하셨나요?" 질문
2. 글자가 흐리거나 잘려서 금액/날짜/가게명 등을 정확히 읽기 어려운 경우
3. 영수증 유형이 애매한 경우 (예: 숙박인지 식당인지 불분명)
4. 주소나 지역을 특정하기 어려운 경우
5. 날짜를 확인할 수 없는 경우 → "영수증의 날짜를 확인할 수 없습니다. 이용 날짜가 언제인가요?"
6. 금액이 불분명한 경우

예: "questions": ["자가차량(본인 소유)으로 이동하셨나요, 공용차량(관용차)으로 이동하셨나요?", "통행료가 4,800원이 맞나요?"]

확신이 100% 높고 위 필수 질문 조건에 해당하지 않을 때만 questions를 생략하세요.`;

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

  return {
    ...parsed,
    proofMetro,
    isProof,
    simulated: false,
  };
}
