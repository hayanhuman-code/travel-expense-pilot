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

    // system 파라미터로 분리 (응답 품질 향상)
    const system = `당신은 한국 공공기관의 출장 영수증 분석 보조 전문가입니다.
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

규칙:
- "resolved": 모든 불확실한 항목이 해결됨. questions는 빈 배열 [].
- "follow_up": 아직 확인 필요. questions에 추가 질문 포함.
- receiptData에는 항상 수정 반영된 최신 데이터를 포함.
- 금액은 반드시 숫자(정수). 날짜는 YYYY-MM-DD.
- 톨게이트 영수증에서 사용자가 "자가차량" → data에 "vehicleType": "personal_car" 추가.
- 사용자가 "공용차량" → data에 "vehicleType": "official_car" 추가.
- receiptData에 "confidence" (0~1)와 "expenseCategory" ("교통비"/"숙박비"/"현지인증") 필드를 포함.
- 사용자가 카테고리를 선택하면 expenseCategory를 해당 값으로 업데이트.
- resolved 시 confidence를 1.0으로 설정.
- receiptData의 data에 "cardLast4", "approvalLast4" 필드가 있으면 반드시 유지.
- 사용자가 카드번호나 승인번호를 알려주면 해당 필드를 끝4자리로 업데이트.`;

    // 대화 메시지 구성 (user/assistant 교대 보장)
    const messages = [];

    if (conversationHistory && conversationHistory.length > 0) {
      for (const msg of conversationHistory) {
        // assistant/user만 허용
        const role = msg.role === "user" ? "user" : "assistant";
        const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
        if (lastMsg && lastMsg.role === role) {
          lastMsg.content += "\n\n" + msg.content;
        } else {
          messages.push({ role, content: msg.content });
        }
      }
    }

    // 첫 메시지가 assistant면 앞에 더미 user 추가 (API 규칙: 첫 메시지는 user)
    if (messages.length > 0 && messages[0].role === "assistant") {
      messages.unshift({ role: "user", content: "영수증 분석 결과를 확인해주세요." });
    }

    // 최신 사용자 메시지 추가
    const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
    if (lastMsg && lastMsg.role === "user") {
      lastMsg.content += "\n\n" + userMessage;
    } else {
      messages.push({ role: "user", content: userMessage });
    }

    // 메시지가 비어있으면 기본 구성
    if (messages.length === 0) {
      messages.push({ role: "user", content: userMessage });
    }

    console.log("QA request - messages count:", messages.length, "roles:", messages.map(m => m.role).join(","));

    const apiHeaders = {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    };
    const apiBody = { max_tokens: 1024, system, messages };

    // 1차: Haiku (빠르고 저렴)
    let response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: apiHeaders,
      body: JSON.stringify({ ...apiBody, model: "claude-haiku-4-5-20251001" }),
    });

    // Haiku 실패 시 Sonnet fallback
    if (!response.ok) {
      console.log("Haiku failed, falling back to Sonnet. Status:", response.status);
      response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: apiHeaders,
        body: JSON.stringify({ ...apiBody, model: "claude-sonnet-4-5-20250929" }),
      });
    }

    if (!response.ok) {
      const errText = await response.text();
      console.error("Claude API error (both models failed):", response.status, errText);
      return res.status(502).json({ error: `Claude API error: ${response.status}`, detail: errText });
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || "";
    console.log("Claude raw response:", text.slice(0, 300));

    // JSON 추출 (여러 패턴 시도)
    let parsed = null;

    // 1차: 코드블록 내 JSON
    const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      try { parsed = JSON.parse(codeBlockMatch[1].trim()); } catch (e) { /* fallthrough */ }
    }

    // 2차: 전체 텍스트를 JSON으로
    if (!parsed) {
      try { parsed = JSON.parse(text.trim()); } catch (e) { /* fallthrough */ }
    }

    // 3차: { } 블록 추출
    if (!parsed) {
      const braceMatch = text.match(/\{[\s\S]*\}/);
      if (braceMatch) {
        try { parsed = JSON.parse(braceMatch[0]); } catch (e) { /* fallthrough */ }
      }
    }

    // 파싱 실패 시 fallback 응답 (500 대신 유의미한 응답)
    if (!parsed) {
      console.error("JSON parse failed. Raw text:", text);
      return res.status(200).json({
        status: "resolved",
        receiptData: enrichResult(receiptData),
        questions: [],
      });
    }

    // receiptData에 proofMetro, isProof 보강
    if (parsed.receiptData) {
      parsed.receiptData = enrichResult(parsed.receiptData);
    } else {
      // receiptData 누락 시 원본 유지
      parsed.receiptData = enrichResult(receiptData);
    }

    if (!parsed.status) parsed.status = "resolved";
    if (!parsed.questions) parsed.questions = [];

    return res.status(200).json(parsed);
  } catch (err) {
    console.error("QA error:", err);
    // 500 대신 fallback 응답
    try {
      const { receiptData } = req.body || {};
      return res.status(200).json({
        status: "resolved",
        receiptData: receiptData ? enrichResult(receiptData) : { type: "unknown", category: "기타", data: {} },
        questions: [],
      });
    } catch (e) {
      return res.status(500).json({ error: err.message });
    }
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
  if (!parsed) return { type: "unknown", category: "기타", data: {}, proofMetro: null, isProof: false, simulated: false, confidence: 0.5, expenseCategory: "현지인증" };
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

  // expenseCategory 자동 매핑 (누락 시)
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
