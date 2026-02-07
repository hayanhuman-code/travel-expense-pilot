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
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: mediaType || "image/jpeg",
                  data: image,
                },
              },
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

    // JSON 추출 (마크다운 코드블록 처리)
    let jsonStr = text;
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) jsonStr = jsonMatch[1];
    jsonStr = jsonStr.trim();

    const parsed = JSON.parse(jsonStr);

    // proofMetro 계산 (주소에서 광역지자체 추출)
    const result = enrichResult(parsed, fileName);

    return res.status(200).json(result);
  } catch (err) {
    console.error("Analysis error:", err);
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
}

// ── 분석 프롬프트 ──
const ANALYSIS_PROMPT = `당신은 한국 공공기관의 출장 영수증 분석 전문가입니다.
업로드된 이미지를 분석하여 아래 형식 중 하나로 JSON을 반환하세요.
반드시 JSON만 출력하세요. 설명이나 마크다운 없이 순수 JSON만 출력하세요.

■ 철도 영수증 (KTX, SRT, ITX, 무궁화 등)
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

■ 숙박 영수증
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

■ 톨게이트 영수증 (하이패스 포함)
{
  "type": "toll_receipt",
  "category": "톨게이트영수증",
  "data": {
    "tollGate": "톨게이트명",
    "amount": 금액(숫자),
    "date": "YYYY-MM-DD 또는 빈문자열"
  }
}

■ 현지 영수증 (편의점, 식당, 카페, 마트 등)
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
주소를 확인할 수 없으면 빈 문자열("")로.`;

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
  충북: ["충북", "충청북도", "청주", "충주", "제천"],
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
