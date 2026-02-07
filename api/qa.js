// api/qa.js — Q&A 대화용 서버리스 엔드포인트
// Claude Sonnet으로 영수증 분석 결과에 대한 사용자 질의응답 처리

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
    const { receiptData, conversationHistory, userMessage } = req.body;
    if (!receiptData || !userMessage) {
      return res.status(400).json({ error: "receiptData and userMessage required" });
    }

    // 대화 히스토리 구성
    const messages = [];

    // 시스템 지시를 첫 번째 user 메시지에 포함
    const systemContext = `당신은 한국 공공기관의 출장 영수증 분석 보조 전문가입니다.
사용자가 업로드한 영수증의 AI 분석 결과에 대해 대화하고 있습니다.

현재 분석된 영수증 데이터:
${JSON.stringify(receiptData, null, 2)}

사용자의 답변을 바탕으로 데이터를 수정하고, 반드시 아래 JSON 형식으로만 응답하세요.
설명이나 마크다운 없이 순수 JSON만 출력하세요.

{
  "status": "resolved" 또는 "follow_up",
  "receiptData": { ...수정된 영수증 데이터 (type, category, data 포함)... },
  "questions": ["추가 질문이 있으면 여기에"]
}

- "resolved": 모든 불확실한 항목이 해결되어 더 이상 질문이 없는 경우. questions는 빈 배열.
- "follow_up": 아직 확인이 필요한 항목이 있는 경우. questions에 추가 질문 포함.
- receiptData에는 항상 수정 반영된 최신 데이터를 포함하세요.
- 금액은 반드시 숫자(정수)로. 날짜는 YYYY-MM-DD 형식으로.`;

    // 이전 대화 히스토리 추가
    if (conversationHistory && conversationHistory.length > 0) {
      // 첫 메시지에 시스템 컨텍스트 포함
      messages.push({
        role: "user",
        content: systemContext + "\n\n" + conversationHistory[0].content,
      });
      for (let i = 1; i < conversationHistory.length; i++) {
        messages.push({
          role: conversationHistory[i].role,
          content: conversationHistory[i].content,
        });
      }
      // 최신 사용자 메시지
      messages.push({ role: "user", content: userMessage });
    } else {
      // 첫 대화
      messages.push({
        role: "user",
        content: systemContext + "\n\n사용자 답변: " + userMessage,
      });
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5-20250929",
        max_tokens: 1024,
        messages,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Claude API error:", response.status, errText);
      return res.status(502).json({ error: `Claude API error: ${response.status}`, detail: errText });
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || "";

    // JSON 추출
    let jsonStr = text;
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) jsonStr = jsonMatch[1];
    jsonStr = jsonStr.trim();

    const parsed = JSON.parse(jsonStr);

    // receiptData에 proofMetro, isProof 보강
    if (parsed.receiptData) {
      parsed.receiptData = enrichResult(parsed.receiptData);
    }

    return res.status(200).json(parsed);
  } catch (err) {
    console.error("QA error:", err);
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
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

function enrichResult(parsed) {
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
