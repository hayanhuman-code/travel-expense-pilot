import { useState, useRef, useMemo, useCallback } from "react";

// ═══════════════════════════════════════════════════
//  식품안전정보원 여비정산 시스템 v5
//  — 영수증 일괄 첨부 → AI 자동 출장 생성
// ═══════════════════════════════════════════════════

// ── 상수 ──
const MEAL_ALLOWANCE = 25000;
const MEAL_DEDUCTION = Math.floor(25000 / 3 / 10) * 10; // 8330원 (1/3 감액, 10원 단위 절사)
const DAILY_ALLOWANCE = 25000;
const DAILY_ALLOWANCE_HALF = 12500;
const FUEL_RATE = 1680; // 원/km

// 직원 숙박비 상한
const LODGING_LIMITS_STAFF = { 서울: 100000, 광역시: 80000, 기타: 70000 };

// 관내출장 정액
const DOMESTIC_SHORT = 10000;
const DOMESTIC_LONG = 20000;

// 광역지자체 매핑 DB
const METRO_MAP = {
  서울: ["서울", "서울특별시", "서울시"],
  부산: ["부산", "부산광역시", "부산시"],
  대구: ["대구", "대구광역시", "대구시"],
  인천: ["인천", "인천광역시", "인천시"],
  광주: ["광주", "광주광역시", "광주시"],
  대전: ["대전", "대전광역시", "대전시"],
  울산: ["울산", "울산광역시", "울산시"],
  세종: ["세종", "세종특별자치시", "세종시", "정부세종청사", "세종정부청사"],
  경기: ["경기", "경기도", "수원", "성남", "용인", "안양", "안산", "고양", "과천", "광명", "구리", "군포", "김포", "남양주", "동두천", "부천", "시흥", "안성", "양주", "양평", "여주", "오산", "의왕", "의정부", "이천", "파주", "평택", "포천", "하남", "화성"],
  강원: ["강원", "강원특별자치도", "강원도", "춘천", "원주", "강릉", "속초", "동해", "태백", "삼척"],
  충북: ["충북", "충청북도", "청주", "충주", "제천", "괴산", "단양", "보은", "영동", "옥천", "음성", "진천", "증평", "오송"],
  충남: ["충남", "충청남도", "천안", "아산", "논산", "공주", "서산", "당진", "보령", "홍성", "예산", "태안", "부여"],
  전북: ["전북", "전북특별자치도", "전라북도", "전주", "익산", "군산", "정읍", "김제", "남원", "완주"],
  전남: ["전남", "전라남도", "목포", "여수", "순천", "나주", "광양", "무안", "해남", "담양"],
  경북: ["경북", "경상북도", "포항", "경주", "구미", "안동", "김천", "영주", "영천", "상주", "문경", "칠곡"],
  경남: ["경남", "경상남도", "창원", "김해", "진주", "양산", "거제", "통영", "사천", "밀양", "함안", "거창"],
  제주: ["제주", "제주특별자치도", "제주도", "제주시", "서귀포"],
};

const METRO_CITIES = ["부산", "대구", "인천", "광주", "대전", "울산"];

const TRANSPORT_TYPES = [
  { value: "rail", label: "철도", icon: "🚄" },
  { value: "personal_car", label: "자가차량", icon: "🚗" },
  { value: "official_car", label: "공용차량", icon: "🚐" },
  { value: "public_transit", label: "대중교통", icon: "🚌" },
];

// confidence 기반 자동분류 임계값
const CONFIDENCE_THRESHOLD = 0.8;

// 비용 카테고리 (3가지만)
const EXPENSE_CATEGORIES = [
  { value: "교통비", icon: "🚄", description: "철도, 톨게이트, 자가차량 등" },
  { value: "숙박비", icon: "🏨", description: "호텔, 모텔, 펜션 등" },
  { value: "현지인증", icon: "🧾", description: "편의점, 식당 등 현지 방문 증빙" },
];

// ── 유틸리티 ──
const uid = () => Math.random().toString(36).slice(2, 9);

const detectMetro = (text) => {
  if (!text) return null;
  const t = text.trim();
  for (const [metro, keywords] of Object.entries(METRO_MAP)) {
    for (const kw of keywords) {
      if (t.includes(kw)) return metro;
    }
  }
  return null;
};

// 오송 → 식품의약품안전처 매핑
const mapDestinationName = (dest) => {
  if (!dest) return dest;
  if (dest === "오송" || dest.includes("오송역")) return "식품의약품안전처";
  return dest;
};

const getLodgingRegion = (metro) => {
  if (!metro) return "기타";
  if (metro === "서울") return "서울";
  if (METRO_CITIES.includes(metro)) return "광역시";
  return "기타";
};

const amountToKorean = (n) => {
  if (!n || n === 0) return "영";
  const units = ["", "만", "억"];
  const nums = ["", "일", "이", "삼", "사", "오", "육", "칠", "팔", "구"];
  const divs = [1, 10000, 100000000];
  let result = "";
  for (let i = units.length - 1; i >= 0; i--) {
    const d = Math.floor(n / divs[i]);
    if (d > 0) {
      const thousands = Math.floor(d / 1000);
      const hundreds = Math.floor((d % 1000) / 100);
      const tens = Math.floor((d % 100) / 10);
      const ones = d % 10;
      let part = "";
      if (thousands) part += nums[thousands] + "천";
      if (hundreds) part += nums[hundreds] + "백";
      if (tens) part += nums[tens] + "십";
      if (ones) part += nums[ones];
      result += part + units[i];
      n %= divs[i];
    }
  }
  return result || "영";
};

const legFare = (leg) => {
  if (leg.transport === "personal_car") return Math.round((leg.km || 0) * FUEL_RATE) + (leg.tollFee || 0);
  if (leg.transport === "official_car") return (leg.fuelFee || 0) + (leg.tollFee || 0);
  if (leg.transport === "rail") return leg.amount || 0;
  return 0;
};

// ── 빈 데이터 템플릿 ──
const emptyLeg = () => ({
  id: uid(), from: "식품안전정보원", to: "", transport: "rail",
  amount: 0, km: 0, tollFee: 0, fuelFee: 0, trainNo: "",
  cardLast4: "", approvalLast4: "",
});

const emptyTrip = () => ({
  id: uid(), date: "", tripType: "outside", destination: "", destinationMetro: null,
  legs: [emptyLeg()],
  breakfast: false, lunch: false, dinner: false, noMeal: true,
  noDaily: true,
  officeCar: false,
  lodgingRegion: "기타", lodgingAmount: 0, noLodging: true,
  farePayMethod: "corp_card", lodgingPayMethod: "corp_card",
  fareCardLast4: "", fareApprovalLast4: "",
  lodgingCardLast4: "", lodgingApprovalLast4: "",
  attachments: [],
  proofVerified: false,
  autoGenerated: false, // v5: 자동 생성 여부
});

// ── Claude Vision API 호출 ──
// 이미지 압축 (Vercel 4.5MB 제한 대응)
const compressImage = (file, maxWidth = 1280, quality = 0.8) => new Promise((resolve) => {
  // PDF는 압축 불가 → 그대로 반환
  if (file.type === "application/pdf") {
    const reader = new FileReader();
    reader.onload = () => resolve({ base64: reader.result.split(",")[1], mediaType: file.type });
    reader.readAsDataURL(file);
    return;
  }
  const img = new Image();
  img.onload = () => {
    const scale = Math.min(1, maxWidth / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", quality);
    resolve({ base64: dataUrl.split(",")[1], mediaType: "image/jpeg" });
  };
  img.onerror = () => {
    // 압축 실패 시 원본 그대로
    const reader = new FileReader();
    reader.onload = () => resolve({ base64: reader.result.split(",")[1], mediaType: file.type || "image/jpeg" });
    reader.readAsDataURL(file);
  };
  const reader = new FileReader();
  reader.onload = () => { img.src = reader.result; };
  reader.readAsDataURL(file);
});

const analyzeWithClaude = async (file) => {
  try {
    const { base64, mediaType } = await compressImage(file);
    console.log(`📎 ${file.name}: 압축 후 ${Math.round(base64.length / 1024)}KB`);
    const res = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: base64, mediaType, fileName: file.name }),
    });
    if (!res.ok) {
      const errBody = await res.text();
      console.error("Claude API 호출 실패:", res.status, errBody);
      throw new Error(`API 오류: ${res.status} - ${errBody.slice(0, 200)}`);
    }
    const result = await res.json();
    // API는 항상 배열 반환
    const items = Array.isArray(result) ? result : [result];
    return items.map((r) => ({ ...r, simulated: false, fileName: file.name }));
  } catch (err) {
    console.error("⚠️ Claude API 실패, 시뮬레이터 대체:", err.message);
    alert(`Claude API 호출 실패: ${err.message}\n\n파일명 기반 시뮬레이션으로 대체됩니다.`);
    return [{ ...simulateFallback(file), fileName: file.name }];
  }
};

// ── 폴백 시뮬레이터 ──
const simulateFallback = (file) => {
  const name = file.name.toLowerCase();
  // 파일명에서 날짜 추출 시도 (YYYYMMDD 또는 YYYY-MM-DD)
  const dateMatch = name.match(/(\d{4})[-_]?(\d{2})[-_]?(\d{2})/);
  const extractedDate = dateMatch ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}` : "";

  if (name.includes("ktx") || name.includes("코레일") || name.includes("열차") || name.includes("승차권") || name.includes("rail")) {
    const isReturn = name.includes("복귀") || name.includes("return") || name.includes("귀환");
    return {
      type: "rail_receipt", category: "철도영수증",
      data: { date: extractedDate, from: isReturn ? "오송" : "서울", to: isReturn ? "서울" : "오송", trainNo: "KTX 301", seatClass: "일반실", amount: 23700 },
      proofMetro: isReturn ? null : "세종", isProof: true, simulated: true
    };
  } else if (name.includes("숙박") || name.includes("호텔") || name.includes("모텔") || name.includes("hotel") || name.includes("lodging")) {
    return {
      type: "lodging_receipt", category: "숙박영수증",
      data: { hotelName: "세종호텔", date: extractedDate, amount: 85000, address: "세종특별자치시 어진동 123" },
      proofMetro: "세종", isProof: true, simulated: true
    };
  } else if (name.includes("톨") || name.includes("toll") || name.includes("하이패스") || name.includes("고속도로")) {
    return {
      type: "toll_receipt", category: "톨게이트영수증",
      data: { tollGate: "서세종IC", amount: 4800, date: extractedDate },
      proofMetro: null, isProof: true, simulated: true
    };
  } else if (name.includes("편의점") || name.includes("식당") || name.includes("카페") || name.includes("마트") || name.includes("영수증")) {
    return {
      type: "local_receipt", category: "현지영수증",
      data: { storeName: "GS25 세종어진점", amount: 3500, date: extractedDate, address: "세종특별자치시 어진동 456" },
      proofMetro: "세종", isProof: true, simulated: true
    };
  } else if (name.includes("지도") || name.includes("map") || name.includes("네이버")) {
    return {
      type: "map_capture", category: "지도캡처",
      data: { from: "서울", to: "세종", distanceKm: 148, estimatedMinutes: 110 },
      proofMetro: null, isProof: false, simulated: true
    };
  }
  return { type: "unknown", category: "기타첨부", data: {}, proofMetro: null, isProof: false, simulated: true };
};

// ═══════════════════════════════════════════════════
//  v5 핵심: 영수증 일괄 분석 → 출장 자동 그룹핑
// ═══════════════════════════════════════════════════
const groupReceiptsIntoTrips = (results) => {
  // 1단계: 날짜별 그룹핑 (1일 = 1출장)
  const groups = {};

  results.forEach((r) => {
    const date = r.data?.date || "날짜미확인";
    if (!groups[date]) {
      groups[date] = { date, receipts: [] };
    }
    groups[date].receipts.push(r);
  });

  // 2단계: 각 그룹을 출장으로 변환
  const newTrips = [];

  Object.values(groups).forEach((group) => {
    const trip = emptyTrip();
    trip.autoGenerated = true;
    trip.date = group.date !== "날짜미확인" ? group.date : "";

    // 기본값: 일비·식비 해당없음
    trip.noMeal = true;
    trip.noDaily = true;
    trip.breakfast = false;
    trip.lunch = false;
    trip.dinner = false;
    trip.noLodging = true;

    // 구간(legs) 초기화
    trip.legs = [];

    // 출장지 추론용
    let inferredDestination = "";

    // 영수증별 처리
    group.receipts.forEach((r) => {
      // 첨부파일 추가
      const att = {
        fileName: r.fileName || "영수증",
        category: r.expenseCategory || r.category,
        type: r.type,
        proofMetro: r.proofMetro,
        isProof: r.isProof,
        simulated: r.simulated || false,
        confidence: r.confidence,
        expenseCategory: r.expenseCategory,
      };
      if (!trip.attachments.some(a => a.fileName === att.fileName)) {
        trip.attachments.push(att);
      }

      // 철도 영수증 → 구간 자동 추가
      if (r.type === "rail_receipt" && r.data) {
        const d = r.data;
        trip.legs.push({
          ...emptyLeg(),
          from: d.from || "",
          to: d.to || "",
          transport: "rail",
          trainNo: d.trainNo || "",
          amount: d.amount || 0,
          cardLast4: d.cardLast4 || "",
          approvalLast4: d.approvalLast4 || "",
        });
        // 출장지 추론: 서울/행신이 아닌 도착지를 출장지로
        const to = d.to || "";
        if (to && !["서울", "행신", "용산", "수서", "청량리"].includes(to)) {
          inferredDestination = mapDestinationName(to);
        }
      }

      // 숙박 영수증
      if (r.type === "lodging_receipt" && r.data) {
        const d = r.data;
        trip.lodgingAmount = d.amount || 0;
        trip.noLodging = false;
        if (d.address) {
          const metro = detectMetro(d.address);
          if (metro) trip.lodgingRegion = getLodgingRegion(metro);
          if (!inferredDestination) inferredDestination = d.address;
        }
      }

      // 현지영수증에서 출장지 추론
      if (r.type === "local_receipt" && r.proofMetro && !inferredDestination) {
        inferredDestination = r.proofMetro;
      }

      // 톨게이트 영수증 → 차량 구간에 톨비 반영 (없으면 차량 구간 생성)
      if (r.type === "toll_receipt" && r.data) {
        const vehicleType = r.data.vehicleType || "personal_car";
        const existingCarLeg = trip.legs.find((l) =>
          l.transport === "personal_car" || l.transport === "official_car"
        );
        if (existingCarLeg) {
          existingCarLeg.tollFee = (existingCarLeg.tollFee || 0) + (r.data.amount || 0);
          existingCarLeg.transport = vehicleType;
        } else {
          trip.legs.push({
            ...emptyLeg(),
            transport: vehicleType,
            tollFee: r.data.amount || 0,
          });
        }
      }
    });

    // 출장지 설정 (오송 → 식품의약품안전처 매핑)
    trip.destination = mapDestinationName(inferredDestination);
    trip.destinationMetro = detectMetro(inferredDestination);

    // 구간이 없으면 기본 빈 구간 추가
    if (trip.legs.length === 0) {
      const leg = emptyLeg();
      leg.to = inferredDestination;
      trip.legs = [leg];
    }

    newTrips.push(trip);
  });

  // 날짜순 정렬
  newTrips.sort((a, b) => (a.date || "").localeCompare(b.date || ""));

  return newTrips;
};

// ═══════════════ 일괄 업로드 모달 ═══════════════
const BulkUploadModal = ({ isOpen, onClose, onComplete, analyzing, onRequestQA }) => {
  const [files, setFiles] = useState([]);
  const [results, setResults] = useState([]);
  const [step, setStep] = useState("select"); // select → analyzing → preview → done
  const [progress, setProgress] = useState(0);
  const fileRef = useRef(null);

  const handleFiles = (e) => {
    const newFiles = Array.from(e.target.files);
    setFiles((prev) => {
      const existingNames = new Set(prev.map(f => f.name));
      const unique = [];
      const duplicates = [];
      for (const f of newFiles) {
        if (existingNames.has(f.name)) {
          duplicates.push(f.name);
        } else {
          existingNames.add(f.name);
          unique.push(f);
        }
      }
      if (duplicates.length > 0) {
        alert(`중복 파일이 제외되었습니다: ${duplicates.join(", ")}`);
      }
      return [...prev, ...unique];
    });
    e.target.value = "";
  };

  const removeFile = (idx) => {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
  };

  const startAnalysis = async () => {
    if (files.length === 0) return;
    setStep("analyzing");
    setProgress(0);
    const allResults = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        const results = await analyzeWithClaude(file);
        // analyzeWithClaude는 항상 배열 반환 (PDF에 영수증 여러장 가능)
        for (const result of results) {
          if ((result.confidence ?? 0.5) < CONFIDENCE_THRESHOLD && onRequestQA) {
            // confidence 낮음 → Q&A 모달로 확인 요청
            const updated = await onRequestQA(result);
            allResults.push({ ...updated, fileName: result.fileName });
          } else {
            allResults.push(result);
          }
        }
      } catch (err) {
        console.error(`분석 실패: ${file.name}`, err);
        allResults.push({
          type: "unknown", category: "분석실패", data: {},
          proofMetro: null, isProof: false, fileName: file.name, error: true
        });
      }
      setProgress(Math.round(((i + 1) / files.length) * 100));
    }

    setResults(allResults);
    setStep("preview");
  };

  const confirmAndCreate = () => {
    const trips = groupReceiptsIntoTrips(results);
    onComplete(trips);
    // 초기화
    setFiles([]);
    setResults([]);
    setStep("select");
    setProgress(0);
    onClose();
  };

  const handleClose = () => {
    setFiles([]);
    setResults([]);
    setStep("select");
    setProgress(0);
    onClose();
  };

  if (!isOpen) return null;

  // 미리보기용 그룹핑
  const previewTrips = step === "preview" ? groupReceiptsIntoTrips(results) : [];

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full max-h-[85vh] overflow-hidden flex flex-col">
        {/* 모달 헤더 */}
        <div className="bg-gradient-to-r from-violet-600 to-indigo-600 px-5 py-3 flex items-center justify-between">
          <div>
            <h3 className="text-white font-bold text-sm">🤖 영수증 일괄 분석</h3>
            <p className="text-violet-200 text-xs mt-0.5">영수증을 한번에 올리면 출장이 자동으로 생성됩니다</p>
          </div>
          <button onClick={handleClose} className="text-white/70 hover:text-white text-lg">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {/* STEP 1: 파일 선택 */}
          {step === "select" && (
            <div className="space-y-4">
              <div
                onClick={() => fileRef.current?.click()}
                className="border-2 border-dashed border-violet-300 rounded-xl p-8 text-center cursor-pointer hover:border-violet-500 hover:bg-violet-50 transition-all"
              >
                <div className="text-3xl mb-2">📎</div>
                <p className="text-sm font-medium text-gray-700">영수증 파일을 선택하세요</p>
                <p className="text-xs text-gray-500 mt-1">PDF, PNG, JPG · 여러 파일 동시 선택 가능</p>
                <input ref={fileRef} type="file" accept=".pdf,.png,.jpg,.jpeg" multiple className="hidden" onChange={handleFiles} />
              </div>

              {files.length > 0 && (
                <div className="space-y-1">
                  <p className="text-xs font-semibold text-gray-600 mb-2">선택된 파일 ({files.length}개)</p>
                  {files.map((f, i) => (
                    <div key={i} className="flex items-center gap-2 bg-gray-50 rounded-lg px-3 py-2 text-xs">
                      <span className="text-gray-400">📄</span>
                      <span className="flex-1 truncate font-medium">{f.name}</span>
                      <span className="text-gray-400">{(f.size / 1024).toFixed(0)}KB</span>
                      <button onClick={() => removeFile(i)} className="text-gray-400 hover:text-red-500">✕</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* STEP 2: 분석 중 */}
          {step === "analyzing" && (
            <div className="text-center py-8">
              <div className="text-4xl mb-4 animate-pulse">🔍</div>
              <p className="text-sm font-medium text-gray-700 mb-2">AI가 영수증을 분석하고 있습니다...</p>
              <div className="w-full bg-gray-200 rounded-full h-2 mb-2">
                <div className="bg-violet-600 h-2 rounded-full transition-all duration-300" style={{ width: `${progress}%` }}></div>
              </div>
              <p className="text-xs text-gray-500">{progress}% ({Math.round(progress / 100 * files.length)}/{files.length})</p>
            </div>
          )}

          {/* STEP 3: 미리보기 */}
          {step === "preview" && (
            <div className="space-y-4">
              <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
                <p className="text-xs font-semibold text-emerald-700">
                  ✅ {results.length}개 영수증 분석 완료 → {previewTrips.length}건의 출장이 생성됩니다
                </p>
                <p className="text-xs text-emerald-600 mt-0.5">일비는 "해당없음", 식비는 "식사 미제공"(전액 지급)으로 설정됩니다. 필요시 수정해 주세요.</p>
              </div>

              {previewTrips.map((trip, i) => (
                <div key={i} className="border border-gray-200 rounded-lg overflow-hidden">
                  <div className="bg-gray-100 px-3 py-2 flex items-center gap-2">
                    <span className="text-xs font-bold text-gray-700">출장 #{i + 1}</span>
                    {trip.date && <span className="text-xs text-gray-500">{trip.date}</span>}
                    {trip.destinationMetro && (
                      <span className="text-xs px-1.5 py-0.5 bg-indigo-100 text-indigo-700 rounded-full">{trip.destinationMetro}</span>
                    )}
                    <span className="text-xs px-1.5 py-0.5 bg-violet-100 text-violet-700 rounded-full ml-auto">자동생성</span>
                  </div>
                  <div className="px-3 py-2 space-y-1">
                    {trip.legs.map((leg, j) => (
                      <div key={j} className="text-xs text-gray-600 flex items-center gap-1">
                        <span>🚄</span>
                        <span>{leg.from} → {leg.to}</span>
                        {leg.trainNo && <span className="text-gray-400">({leg.trainNo})</span>}
                        {leg.amount > 0 && <span className="font-mono text-blue-600 ml-auto">{leg.amount.toLocaleString()}원</span>}
                      </div>
                    ))}
                    {!trip.noLodging && trip.lodgingAmount > 0 && (
                      <div className="text-xs text-gray-600 flex items-center gap-1">
                        <span>🏨</span>
                        <span>숙박비</span>
                        <span className="font-mono text-blue-600 ml-auto">{trip.lodgingAmount.toLocaleString()}원</span>
                      </div>
                    )}
                    <div className="text-xs text-gray-400 mt-1">
                      📎 {trip.attachments.length}개 증빙 첨부
                    </div>
                  </div>
                </div>
              ))}

              {results.some((r) => r.error) && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  <p className="text-xs text-amber-700 font-medium">⚠️ 분석 실패 항목:</p>
                  {results.filter((r) => r.error).map((r, i) => (
                    <p key={i} className="text-xs text-amber-600">{r.fileName}</p>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* 모달 푸터 */}
        <div className="border-t border-gray-200 px-5 py-3 flex gap-2">
          {step === "select" && (
            <>
              <button onClick={handleClose} className="flex-1 py-2.5 border border-gray-300 rounded-lg text-sm text-gray-600 hover:bg-gray-50">취소</button>
              <button
                onClick={startAnalysis}
                disabled={files.length === 0}
                className="flex-1 py-2.5 bg-violet-600 text-white rounded-lg text-sm font-semibold hover:bg-violet-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-all"
              >
                🔍 {files.length}개 분석 시작
              </button>
            </>
          )}
          {step === "preview" && (
            <>
              <button onClick={handleClose} className="flex-1 py-2.5 border border-gray-300 rounded-lg text-sm text-gray-600 hover:bg-gray-50">취소</button>
              <button
                onClick={confirmAndCreate}
                className="flex-1 py-2.5 bg-emerald-600 text-white rounded-lg text-sm font-semibold hover:bg-emerald-700 transition-all"
              >
                ✅ {previewTrips.length}건 출장 생성
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};


// ═══════════════ Q&A 확인 모달 ═══════════════

// 영수증 타입별 아이콘/라벨
const RECEIPT_TYPE_INFO = {
  rail_receipt: { icon: "🚄", label: "철도영수증" },
  lodging_receipt: { icon: "🏨", label: "숙박영수증" },
  toll_receipt: { icon: "🛣️", label: "톨게이트영수증" },
  local_receipt: { icon: "🧾", label: "현지영수증" },
  map_capture: { icon: "🗺️", label: "지도캡처" },
  unknown: { icon: "📄", label: "기타" },
};

// 영수증 요약 텍스트 생성
const receiptSummary = (r) => {
  if (!r) return "";
  const d = r.data || {};
  const info = RECEIPT_TYPE_INFO[r.type] || RECEIPT_TYPE_INFO.unknown;
  let summary = `${info.icon} ${info.label}`;
  if (r.fileName) summary += ` (${r.fileName})`;
  const details = [];
  if (d.date) details.push(`날짜: ${d.date}`);
  if (d.amount != null) details.push(`금액: ${Number(d.amount).toLocaleString()}원`);
  if (d.storeName) details.push(`가게: ${d.storeName}`);
  if (d.hotelName) details.push(`숙소: ${d.hotelName}`);
  if (d.from && d.to) details.push(`${d.from} → ${d.to}`);
  if (d.trainNo) details.push(`열차: ${d.trainNo}`);
  if (d.tollGate) details.push(`톨게이트: ${d.tollGate}`);
  if (d.address) details.push(`주소: ${d.address}`);
  if (details.length > 0) summary += "\n" + details.join(" · ");
  return summary;
};

const QAModal = ({ isOpen, onClose, receiptResult, onResolved }) => {
  const [selectedCategory, setSelectedCategory] = useState("현지인증");
  const [formData, setFormData] = useState({});
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const chatEndRef = useRef(null);

  // 모달 열릴 때 초기화
  const prevOpenRef = useRef(false);
  if (isOpen && !prevOpenRef.current && receiptResult) {
    const cat = receiptResult.expenseCategory || "현지인증";
    setSelectedCategory(cat);

    // AI 분석 데이터에서 폼 필드 초기화
    const d = receiptResult.data || {};
    setFormData({
      date: d.date || "",
      amount: d.amount || "",
      transportType: d.vehicleType || (receiptResult.type === "rail_receipt" ? "rail" : "personal_car"),
      from: d.from || "",
      to: d.to || "",
      trainNo: d.trainNo || "",
      hotelName: d.hotelName || "",
      address: d.address || "",
      storeName: d.storeName || "",
      tollGate: d.tollGate || "",
    });

    // AI 질문이 있으면 채팅에 표시
    if (receiptResult.questions?.length > 0) {
      const summary = receiptSummary(receiptResult);
      // 질문에서 선택지 패턴 감지
      let detectedChoices = [];
      if (receiptResult.type === "toll_receipt" ||
          receiptResult.questions.some(q => q.includes("자가차량") || q.includes("공용차량") || q.includes("자가용"))) {
        detectedChoices = ["자가용(본인소유)", "공용차량(관용차)"];
      }
      setChatMessages([{
        role: "assistant",
        content: `📋 분석된 영수증 정보:\n${summary}\n\n❓ 확인이 필요한 항목:\n${receiptResult.questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}`,
        choices: detectedChoices,
      }]);
    } else {
      const summary = receiptSummary(receiptResult);
      setChatMessages([{
        role: "assistant",
        content: `📋 분석된 영수증 정보:\n${summary}\n\n⚠️ AI가 분류에 확신이 낮습니다. 아래에서 카테고리와 정보를 확인해 주세요.`,
        choices: [],
      }]);
    }
    setChatInput("");
    setChatLoading(false);
  }
  prevOpenRef.current = isOpen;

  const updateForm = (key, val) => setFormData((p) => ({ ...p, [key]: val }));

  const scrollToBottom = () => {
    setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
  };

  // 채팅으로 추가 질문 처리
  const submitChat = async (answer) => {
    if (!answer.trim() || chatLoading) return;
    const userMsg = { role: "user", content: answer.trim() };
    const newMessages = [...chatMessages, userMsg];
    setChatMessages(newMessages);
    setChatInput("");
    setChatLoading(true);
    scrollToBottom();

    try {
      const res = await fetch("/api/qa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          receiptData: receiptResult,
          conversationHistory: newMessages.slice(0, -1),
          userMessage: userMsg.content,
        }),
      });

      if (!res.ok) throw new Error(`API 오류: ${res.status}`);
      const data = await res.json();

      if (data.status === "resolved" && data.receiptData) {
        // 채팅 결과로 폼 데이터 업데이트
        const rd = data.receiptData.data || {};
        setFormData((prev) => ({
          ...prev,
          date: rd.date || prev.date,
          amount: rd.amount || prev.amount,
          transportType: rd.vehicleType || prev.transportType,
          from: rd.from || prev.from,
          to: rd.to || prev.to,
          trainNo: rd.trainNo || prev.trainNo,
          hotelName: rd.hotelName || prev.hotelName,
          address: rd.address || prev.address,
          storeName: rd.storeName || prev.storeName,
          tollGate: rd.tollGate || prev.tollGate,
        }));
        if (data.receiptData.expenseCategory) {
          setSelectedCategory(data.receiptData.expenseCategory);
        }
        const resolvedMsg = data.message
          ? `${data.message}\n\n"적용하기"를 눌러주세요.`
          : `✅ 확인 완료! 위 정보가 업데이트되었습니다. "적용하기"를 눌러주세요.`;
        setChatMessages((prev) => [...prev, { role: "assistant", content: resolvedMsg, choices: [] }]);
      } else {
        let followUpMsg = data.message || "";
        if (data.questions?.length > 0) {
          followUpMsg += (followUpMsg ? "\n\n" : "") + data.questions.map((q, i) => `${i + 1}. ${q}`).join("\n");
        }
        if (!followUpMsg) followUpMsg = "추가 정보가 필요합니다.";
        setChatMessages((prev) => [...prev, { role: "assistant", content: followUpMsg, choices: data.choices || [] }]);
      }
    } catch (err) {
      setChatMessages((prev) => [...prev, {
        role: "assistant",
        content: `오류가 발생했습니다: ${err.message}`,
      }]);
    } finally {
      setChatLoading(false);
      scrollToBottom();
    }
  };

  const handleSkip = () => {
    onResolved(receiptResult);
  };

  const handleApply = () => {
    // 카테고리에 따라 type 매핑
    let type = receiptResult.type;
    if (selectedCategory === "교통비") {
      if (formData.transportType === "rail") type = "rail_receipt";
      else type = "toll_receipt";
    } else if (selectedCategory === "숙박비") {
      type = "lodging_receipt";
    } else {
      type = "local_receipt";
    }

    // category 라벨 매핑
    const categoryLabel = {
      rail_receipt: "철도영수증",
      toll_receipt: "톨게이트영수증",
      lodging_receipt: "숙박영수증",
      local_receipt: "현지영수증",
    }[type] || receiptResult.category;

    // 카테고리별 data 구성
    let data = { ...receiptResult.data };
    if (formData.date) data.date = formData.date;

    if (selectedCategory === "교통비") {
      if (type === "rail_receipt") {
        data = { ...data, from: formData.from, to: formData.to, trainNo: formData.trainNo, amount: Number(formData.amount) || 0 };
      } else {
        data = { ...data, tollGate: formData.tollGate || data.tollGate, amount: Number(formData.amount) || 0, vehicleType: formData.transportType };
      }
    } else if (selectedCategory === "숙박비") {
      data = { ...data, hotelName: formData.hotelName, amount: Number(formData.amount) || 0, address: formData.address };
    } else {
      data = { ...data, storeName: formData.storeName, address: formData.address, amount: Number(formData.amount) || data.amount };
    }

    const updatedResult = {
      ...receiptResult,
      type,
      category: categoryLabel,
      expenseCategory: selectedCategory,
      confidence: 1.0,
      data,
      questions: [],
    };

    onResolved(updatedResult);
  };

  if (!isOpen) return null;

  const inputStyle = "w-full px-2 py-1.5 border border-gray-300 rounded text-xs focus:outline-none focus:border-violet-500";
  const labelStyle = "text-xs text-gray-500 mb-1 block";

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full max-h-[85vh] overflow-hidden flex flex-col">
        {/* 헤더 */}
        <div className="bg-gradient-to-r from-violet-600 to-indigo-600 px-5 py-3 flex items-center justify-between">
          <div>
            <h3 className="text-white font-bold text-sm">📋 영수증 확인</h3>
            <p className="text-violet-200 text-xs mt-0.5">
              {receiptResult?.fileName && `📎 ${receiptResult.fileName}`}
              {receiptResult?.confidence != null && ` · 신뢰도 ${Math.round(receiptResult.confidence * 100)}%`}
            </p>
          </div>
          <button onClick={handleSkip} className="text-white/70 hover:text-white text-lg">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* 카테고리 선택 */}
          <div className="px-4 pt-4 pb-2">
            <label className={labelStyle}>비용 분류</label>
            <div className="flex gap-2">
              {EXPENSE_CATEGORIES.map((cat) => (
                <button
                  key={cat.value}
                  onClick={() => setSelectedCategory(cat.value)}
                  className={`flex-1 py-2.5 rounded-xl text-sm border-2 transition-all font-medium ${
                    selectedCategory === cat.value
                      ? "bg-violet-600 text-white border-violet-600 shadow-md"
                      : "bg-white text-gray-600 border-gray-200 hover:border-violet-300 hover:bg-violet-50"
                  }`}
                >
                  {cat.icon} {cat.value}
                </button>
              ))}
            </div>
            <p className="text-xs text-gray-400 mt-1">
              {EXPENSE_CATEGORIES.find((c) => c.value === selectedCategory)?.description}
            </p>
          </div>

          {/* 카테고리별 입력 필드 */}
          <div className="px-4 pb-3 space-y-2">
            {/* 공통: 날짜 */}
            {!formData.date && (
              <div>
                <label className={labelStyle}>날짜 (미확인)</label>
                <input type="date" value={formData.date} onChange={(e) => updateForm("date", e.target.value)} className={inputStyle} />
              </div>
            )}
            {formData.date && (
              <div>
                <label className={labelStyle}>날짜</label>
                <input type="date" value={formData.date} onChange={(e) => updateForm("date", e.target.value)} className={inputStyle} />
              </div>
            )}

            {/* 교통비 필드 */}
            {selectedCategory === "교통비" && (
              <>
                <div>
                  <label className={labelStyle}>교통편 종류</label>
                  <select value={formData.transportType} onChange={(e) => updateForm("transportType", e.target.value)} className={`${inputStyle} bg-white`}>
                    <option value="rail">🚄 철도 (KTX/SRT 등)</option>
                    <option value="personal_car">🚗 자가차량</option>
                    <option value="official_car">🚐 공용차량</option>
                    <option value="public_transit">🚌 대중교통</option>
                  </select>
                </div>
                {formData.transportType === "rail" && (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className={labelStyle}>출발역</label>
                        <input value={formData.from} onChange={(e) => updateForm("from", e.target.value)} placeholder="서울" className={inputStyle} />
                      </div>
                      <div>
                        <label className={labelStyle}>도착역</label>
                        <input value={formData.to} onChange={(e) => updateForm("to", e.target.value)} placeholder="부산" className={inputStyle} />
                      </div>
                    </div>
                    <div>
                      <label className={labelStyle}>열차번호</label>
                      <input value={formData.trainNo} onChange={(e) => updateForm("trainNo", e.target.value)} placeholder="KTX 301" className={inputStyle} />
                    </div>
                  </>
                )}
                <div>
                  <label className={labelStyle}>금액 (원)</label>
                  <input type="number" value={formData.amount} onChange={(e) => updateForm("amount", e.target.value)} placeholder="0" className={inputStyle} />
                </div>
              </>
            )}

            {/* 숙박비 필드 */}
            {selectedCategory === "숙박비" && (
              <>
                <div>
                  <label className={labelStyle}>숙소명</label>
                  <input value={formData.hotelName} onChange={(e) => updateForm("hotelName", e.target.value)} placeholder="호텔명" className={inputStyle} />
                </div>
                <div>
                  <label className={labelStyle}>금액 (원)</label>
                  <input type="number" value={formData.amount} onChange={(e) => updateForm("amount", e.target.value)} placeholder="0" className={inputStyle} />
                </div>
                <div>
                  <label className={labelStyle}>주소</label>
                  <input value={formData.address} onChange={(e) => updateForm("address", e.target.value)} placeholder="호텔 주소 (지역 판별용)" className={inputStyle} />
                </div>
              </>
            )}

            {/* 현지인증 필드 */}
            {selectedCategory === "현지인증" && (
              <>
                <div>
                  <label className={labelStyle}>가게명</label>
                  <input value={formData.storeName} onChange={(e) => updateForm("storeName", e.target.value)} placeholder="가게명" className={inputStyle} />
                </div>
                <div>
                  <label className={labelStyle}>주소</label>
                  <input value={formData.address} onChange={(e) => updateForm("address", e.target.value)} placeholder="주소 (출장지 확인용)" className={inputStyle} />
                </div>
              </>
            )}
          </div>

          {/* 구분선 */}
          <div className="border-t border-gray-200 mx-4"></div>

          {/* 채팅 영역 (AI 질문이 있는 경우) */}
          <div className="px-4 py-3">
            <p className="text-xs text-gray-500 font-medium mb-2">💬 AI 대화</p>
            <div className="space-y-2 max-h-[150px] overflow-y-auto">
              {chatMessages.map((msg, i) => (
                <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                  <div className="max-w-[85%]">
                    <div className={`rounded-xl px-3 py-2 text-xs whitespace-pre-wrap ${
                      msg.role === "user"
                        ? "bg-violet-600 text-white rounded-br-sm"
                        : "bg-gray-100 text-gray-700 rounded-bl-sm"
                    }`}>
                      {msg.content}
                    </div>
                    {msg.role === "assistant" && msg.choices?.length > 0 && i === chatMessages.length - 1 && (
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {msg.choices.map((choice, ci) => (
                          <button key={ci} onClick={() => submitChat(choice)} disabled={chatLoading}
                            className="px-3 py-1.5 bg-white border-2 border-violet-300 text-violet-700 rounded-lg text-xs font-medium hover:bg-violet-50 hover:border-violet-500 disabled:opacity-50 transition-all">
                            {choice}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {chatLoading && (
                <div className="flex justify-start">
                  <div className="bg-gray-100 rounded-xl rounded-bl-sm px-3 py-2 text-xs text-gray-400">
                    <span className="animate-pulse">응답 작성 중...</span>
                  </div>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>
            <div className="flex gap-1.5 mt-2">
              <input
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitChat(chatInput); } }}
                placeholder="추가 정보 입력..."
                disabled={chatLoading}
                className="flex-1 px-2 py-1.5 border border-gray-300 rounded text-xs focus:outline-none focus:border-violet-500 disabled:bg-gray-50"
              />
              <button
                onClick={() => submitChat(chatInput)}
                disabled={!chatInput.trim() || chatLoading}
                className="px-3 py-1.5 bg-violet-600 text-white rounded text-xs font-medium hover:bg-violet-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-all"
              >
                전송
              </button>
            </div>
          </div>
        </div>

        {/* 하단 버튼 */}
        <div className="border-t border-gray-200 px-4 py-3 flex gap-2">
          <button
            onClick={handleSkip}
            className="flex-1 py-2.5 border border-gray-300 rounded-lg text-xs text-gray-600 hover:bg-gray-50 transition-all"
          >
            ⏭️ 건너뛰기
          </button>
          <button
            onClick={handleApply}
            className="flex-1 py-2.5 bg-emerald-600 text-white rounded-lg text-xs font-semibold hover:bg-emerald-700 transition-all"
          >
            ✅ 적용하기
          </button>
        </div>
      </div>
    </div>
  );
};

// ═══════════════ 구간 카드 ═══════════════
const LegCard = ({ leg, index, total, onUpdate, onRemove, canRemove, isExecutive }) => {
  const u = (k, v) => onUpdate(leg.id, k, v);
  const colors = ["#3b82f6", "#8b5cf6", "#10b981", "#f59e0b", "#ef4444"];
  const color = colors[index % colors.length];

  return (
    <div className="border-l-4 rounded-r-lg bg-white p-3 mb-2" style={{ borderColor: color }}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-bold" style={{ color }}>구간 {index + 1}/{total}</span>
        {canRemove && <button onClick={() => onRemove(leg.id)} className="text-xs text-red-400 hover:text-red-600">✕ 삭제</button>}
      </div>
      <div className="grid grid-cols-2 gap-2 mb-2">
        <input value={leg.from} onChange={(e) => u("from", e.target.value)} placeholder="출발지" className="px-2 py-1.5 border border-gray-300 rounded text-xs bg-white" />
        <input value={leg.to} onChange={(e) => u("to", e.target.value)} placeholder="도착지" className="px-2 py-1.5 border border-gray-300 rounded text-xs bg-white" />
      </div>
      <div className="flex gap-1 mb-2 flex-wrap">
        {TRANSPORT_TYPES.map((t) => (
          <button key={t.value} onClick={() => u("transport", t.value)}
            className={`px-2 py-1 rounded text-xs border transition-all ${leg.transport === t.value ? "bg-gray-800 text-white border-gray-800" : "bg-white text-gray-600 border-gray-200 hover:border-gray-400"}`}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {leg.transport === "rail" && (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <input value={leg.trainNo} onChange={(e) => u("trainNo", e.target.value)} placeholder="열차번호 (예: KTX 301)" className="px-2 py-1.5 border border-gray-300 rounded text-xs" />
            <input type="number" value={leg.amount || ""} onChange={(e) => u("amount", Number(e.target.value))} placeholder="운임 (원)" className="px-2 py-1.5 border border-gray-300 rounded text-xs font-mono" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input value={leg.cardLast4 || ""} onChange={(e) => u("cardLast4", e.target.value)} placeholder="카드번호 끝4자리" maxLength={4} className="px-2 py-1.5 border border-gray-300 rounded text-xs font-mono" />
            <input value={leg.approvalLast4 || ""} onChange={(e) => u("approvalLast4", e.target.value)} placeholder="승인번호 끝4자리" maxLength={4} className="px-2 py-1.5 border border-gray-300 rounded text-xs font-mono" />
          </div>
          {isExecutive && (
            <div className="text-xs text-amber-600 bg-amber-50 px-2 py-1 rounded">👔 임원: KTX 특실 이용 가능</div>
          )}
        </div>
      )}

      {leg.transport === "personal_car" && (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-gray-500 mb-0.5 block">편도 거리(km)</label>
              <input type="number" value={leg.km || ""} onChange={(e) => u("km", Number(e.target.value))} placeholder="km" className="w-full px-2 py-1.5 border border-gray-300 rounded text-xs font-mono" />
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-0.5 block">유류비 (자동계산)</label>
              <div className="px-2 py-1.5 bg-blue-50 border border-blue-200 rounded text-xs font-mono text-blue-700 font-bold">
                {((leg.km || 0) * FUEL_RATE).toLocaleString()}원
              </div>
            </div>
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-0.5 block">톨게이트비 (원)</label>
            <input type="number" value={leg.tollFee || ""} onChange={(e) => u("tollFee", Number(e.target.value))} placeholder="0" className="w-full px-2 py-1.5 border border-gray-300 rounded text-xs font-mono" />
          </div>
          <div className="text-xs text-gray-400">유류비 단가: {FUEL_RATE.toLocaleString()}원/km</div>
        </div>
      )}

      {leg.transport === "official_car" && (
        <div className="space-y-2">
          <div className="text-xs text-sky-600 bg-sky-50 px-2 py-1 rounded">🚐 공용차량: 일비 50% 감액 적용</div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-gray-500 mb-0.5 block">유류비 (해당 시)</label>
              <input type="number" value={leg.fuelFee || ""} onChange={(e) => u("fuelFee", Number(e.target.value))} placeholder="0" className="w-full px-2 py-1.5 border border-gray-300 rounded text-xs font-mono" />
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-0.5 block">톨게이트비 (해당 시)</label>
              <input type="number" value={leg.tollFee || ""} onChange={(e) => u("tollFee", Number(e.target.value))} placeholder="0" className="w-full px-2 py-1.5 border border-gray-300 rounded text-xs font-mono" />
            </div>
          </div>
        </div>
      )}

      {leg.transport === "public_transit" && (
        <div className="text-xs text-gray-500 bg-gray-50 px-2 py-1.5 rounded">
          🚌 대중교통 운임은 일비에 포함 (별도 정산 없음)
        </div>
      )}
    </div>
  );
};

// ═══════════════ 출장 카드 ═══════════════
const TripCard = ({ trip, index, onUpdate, onRemove, canRemove, isExecutive, analyzing, onAnalyzeFile }) => {
  const fileRef = useRef(null);
  const u = useCallback((k, v) => onUpdate(trip.id, k, v), [trip.id, onUpdate]);

  const updateLeg = useCallback((legId, key, val) => {
    const newLegs = trip.legs.map((l) => l.id === legId ? { ...l, [key]: val } : l);
    if (key === "to") {
      const idx = newLegs.findIndex((l) => l.id === legId);
      if (idx >= 0 && idx < newLegs.length - 1) newLegs[idx + 1] = { ...newLegs[idx + 1], from: val };
    }
    u("legs", newLegs);
  }, [trip.legs, u]);

  const addLeg = () => {
    const lastLeg = trip.legs[trip.legs.length - 1];
    const nl = emptyLeg();
    nl.from = lastLeg?.to || "";
    u("legs", [...trip.legs, nl]);
  };

  const removeLeg = (legId) => {
    if (trip.legs.length <= 1) return;
    u("legs", trip.legs.filter((l) => l.id !== legId));
  };

  const hasOfficialCar = trip.legs.some((l) => l.transport === "official_car");
  const totalFare = trip.legs.reduce((s, l) => s + legFare(l), 0);

  const handleDestChange = (val) => {
    u("destination", val);
    u("destinationMetro", detectMetro(val));
    if (trip.legs.length > 0) {
      const firstLeg = trip.legs[0];
      const newLegs = [...trip.legs];
      newLegs[0] = { ...firstLeg, from: firstLeg.from || "식품안전정보원", to: val };
      u("legs", newLegs);
    }
  };

  // 관외증빙 상태 계산
  const hasTransportProof = trip.attachments.some((a) => a.type === "rail_receipt" || a.type === "toll_receipt");
  const hasLocalProof = trip.attachments.some((a) =>
    a.type === "local_receipt" && a.proofMetro && trip.destinationMetro && a.proofMetro === trip.destinationMetro
  );
  const hasLodgingProof = trip.attachments.some((a) =>
    a.type === "lodging_receipt" && a.proofMetro && trip.destinationMetro && a.proofMetro === trip.destinationMetro
  );
  const proofOk = trip.tripType !== "outside" || hasTransportProof || hasLocalProof || hasLodgingProof;

  const isDomestic = trip.tripType !== "outside";

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
      {/* 헤더 */}
      <div className={`px-4 py-2.5 flex items-center justify-between ${trip.autoGenerated ? "bg-gradient-to-r from-violet-600 to-indigo-600" : "bg-gradient-to-r from-slate-700 to-slate-600"}`}>
        <div className="flex items-center gap-2">
          <span className="text-white text-sm font-bold">출장 #{index + 1}</span>
          {trip.autoGenerated && (
            <span className="text-xs px-1.5 py-0.5 bg-white/20 text-white rounded-full">🤖 자동생성</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {trip.tripType === "outside" && (
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${proofOk ? "bg-emerald-400/20 text-emerald-200" : "bg-red-400/20 text-red-200"}`}>
              {proofOk ? "✅ 증빙확인" : "⚠️ 증빙필요"}
            </span>
          )}
          {canRemove && <button onClick={() => onRemove(trip.id)} className="text-white/60 hover:text-white text-sm">✕</button>}
        </div>
      </div>

      <div className="p-4 space-y-3">
        {/* 자동생성 안내 (해당없음 상태일 때) */}
        {trip.autoGenerated && (trip.noMeal || trip.noDaily) && (
          <div className="bg-violet-50 border border-violet-200 rounded-lg px-3 py-2">
            <p className="text-xs font-semibold text-violet-700">
              🤖 자동으로 생성된 출장입니다
            </p>
            <p className="text-xs text-violet-600 mt-0.5">
              일비는 "해당없음", 식비는 "식사 미제공"(전액 지급)으로 설정되었습니다. 필요시 수정해 주세요.
            </p>
          </div>
        )}

        {/* 기본정보 */}
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-xs text-gray-500 mb-1 block">출장일자</label>
            <input type="date" value={trip.date} onChange={(e) => u("date", e.target.value)} className="w-full px-2 py-1.5 border border-gray-300 rounded text-xs" />
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">출장구분</label>
            <select value={trip.tripType} onChange={(e) => u("tripType", e.target.value)} className="w-full px-2 py-1.5 border border-gray-300 rounded text-xs bg-white">
              <option value="outside">관외출장</option>
              <option value="domestic_long">관내(4h이상)</option>
              <option value="domestic_short">관내(4h미만)</option>
            </select>
          </div>
        </div>

        {/* 출장지 */}
        <div>
          <label className="text-xs text-gray-500 mb-1 block">출장지</label>
          <div className="flex items-center gap-2">
            <input value={trip.destination} onChange={(e) => handleDestChange(e.target.value)} placeholder="출장지 (예: 세종정부청사, 부산 BEXCO)" className="flex-1 px-2 py-1.5 border border-gray-300 rounded text-xs" />
            {trip.destinationMetro && (
              <span className="text-xs px-2 py-0.5 bg-indigo-100 text-indigo-700 rounded-full font-medium whitespace-nowrap">
                📍 {trip.destinationMetro}
              </span>
            )}
          </div>
        </div>

        {/* 관내: 정액 안내 */}
        {isDomestic && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-center">
            <span className="text-sm font-bold text-amber-700">
              정액 {trip.tripType === "domestic_short" ? "10,000" : "20,000"}원
            </span>
            <p className="text-xs text-amber-600 mt-1">관내출장은 정액 지급 (세부 항목 없음)</p>
          </div>
        )}

        {/* 관외: 상세 입력 */}
        {!isDomestic && (
          <>
            {/* 구간(Leg) 목록 */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-gray-600">이동 구간</span>
                <button onClick={addLeg} className="text-xs text-blue-600 hover:text-blue-800 font-medium">+ 경유 구간 추가</button>
              </div>
              {trip.legs.map((leg, i) => (
                <LegCard key={leg.id} leg={leg} index={i} total={trip.legs.length}
                  onUpdate={updateLeg} onRemove={removeLeg} canRemove={trip.legs.length > 1} isExecutive={isExecutive} />
              ))}
            </div>

            {/* 운임 소계 + 결제수단 */}
            {totalFare > 0 && (
              <div className="bg-blue-50 rounded-lg px-3 py-2">
                <div className="flex justify-between items-center mb-2">
                  <span className="text-xs text-gray-600">운임 소계</span>
                  <span className="text-sm font-bold text-blue-700">{totalFare.toLocaleString()}원</span>
                </div>
                <div className="flex gap-2">
                  {["corp_card", "personal"].map((m) => (
                    <button key={m} onClick={() => u("farePayMethod", m)}
                      className={`flex-1 py-1.5 rounded text-center text-xs border transition-all ${trip.farePayMethod === m ? (m === "corp_card" ? "bg-blue-600 text-white border-blue-600" : "bg-emerald-600 text-white border-emerald-600") : "border-gray-300 bg-white"}`}>
                      {m === "corp_card" ? "💳 법인카드" : "🏦 개인부담"}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* 일비 */}
            <div className="bg-gray-50 rounded-lg p-3">
              <span className="text-xs font-semibold text-gray-600 mb-1 block">💰 일비</span>
              <div className="flex gap-1.5">
                <button onClick={() => u("noDaily", true)}
                  className={`flex-1 py-1.5 rounded text-xs border transition-all ${trip.noDaily ? "bg-red-500 text-white border-red-500" : "bg-white text-gray-500 border-gray-200"}`}>
                  🚫 해당없음
                </button>
                <button onClick={() => u("noDaily", false)}
                  className={`flex-1 py-1.5 rounded text-xs border transition-all ${!trip.noDaily ? "bg-blue-600 text-white border-blue-600" : "bg-white text-gray-500 border-gray-200"}`}>
                  💰 {(hasOfficialCar ? DAILY_ALLOWANCE_HALF : DAILY_ALLOWANCE).toLocaleString()}원
                </button>
              </div>
              {!trip.noDaily && hasOfficialCar && (
                <div className="text-xs text-sky-600 mt-1.5">🚐 공용차량 50% 감액 적용</div>
              )}
            </div>

            {/* 식비 */}
            <div className="bg-gray-50 rounded-lg p-3">
              <span className="text-xs font-semibold text-gray-600 mb-1 block">🍽️ 식비 (기본 {MEAL_ALLOWANCE.toLocaleString()}원, 제공 식사 시 차감)</span>
              <div className="flex gap-1.5">
                <button onClick={() => { u("noMeal", true); u("breakfast", false); u("lunch", false); u("dinner", false); }}
                  className={`flex-1 py-1.5 rounded text-xs border transition-all ${trip.noMeal ? "bg-green-600 text-white border-green-600" : "bg-white text-gray-500 border-gray-200"}`}>
                  ✅ 식사 미제공
                </button>
                {[["breakfast", "🌅 조식"], ["lunch", "☀️ 중식"], ["dinner", "🌙 석식"]].map(([key, label]) => (
                  <button key={key} onClick={() => { u("noMeal", false); u(key, !trip[key]); }}
                    className={`flex-1 py-1.5 rounded text-xs border transition-all ${!trip.noMeal && trip[key] ? "bg-orange-500 text-white border-orange-500" : "bg-white text-gray-500 border-gray-200"}`}>
                    {label} 제공
                  </button>
                ))}
              </div>
              {trip.noMeal ? (
                <div className="text-xs text-green-600 mt-1.5">
                  제공 식사 없음 → 식비 {MEAL_ALLOWANCE.toLocaleString()}원 전액 지급
                </div>
              ) : (
                <div className="text-xs text-gray-400 mt-1.5">
                  기본 {MEAL_ALLOWANCE.toLocaleString()}원 지급, 제공 식사 1끼당 {MEAL_DEDUCTION.toLocaleString()}원 차감
                </div>
              )}
            </div>

            {/* 숙박비 */}
            <div className="bg-gray-50 rounded-lg p-3">
              <span className="text-xs font-semibold text-gray-600 mb-1 block">🏨 숙박비</span>
              <div className="flex gap-1.5 mb-1.5">
                <button onClick={() => u("noLodging", true)}
                  className={`flex-1 py-1.5 rounded text-xs border transition-all ${trip.noLodging ? "bg-red-500 text-white border-red-500" : "bg-white text-gray-500 border-gray-200"}`}>
                  🚫 해당없음
                </button>
                {(isExecutive
                  ? [["실비", "💰 실비"]]
                  : Object.entries(LODGING_LIMITS_STAFF).map(([r, l]) => [r, `🏠 ${r}(${(l / 10000)}만)`])
                ).map(([val, label]) => (
                  <button key={val} onClick={() => { u("noLodging", false); u("lodgingRegion", val); }}
                    className={`flex-1 py-1.5 rounded text-xs border transition-all ${!trip.noLodging && trip.lodgingRegion === val ? "bg-blue-600 text-white border-blue-600" : "bg-white text-gray-500 border-gray-200"}`}>
                    {label}
                  </button>
                ))}
              </div>
              {!trip.noLodging && (
                <>
                  {isExecutive && (
                    <div className="text-xs text-amber-600 bg-amber-50 px-2 py-1 rounded mb-1.5">👔 임원: 숙박비 상한 없음 (실비 정산)</div>
                  )}
                  <input type="number" value={trip.lodgingAmount || ""} onChange={(e) => u("lodgingAmount", Number(e.target.value))} placeholder="숙박비 (원)" className="w-full px-2 py-1.5 border border-gray-300 rounded text-xs font-mono bg-white" />
                  {!isExecutive && trip.lodgingAmount > (LODGING_LIMITS_STAFF[trip.lodgingRegion] || 70000) && (
                    <p className="text-xs text-red-600 mt-1">⚠️ 상한 {(LODGING_LIMITS_STAFF[trip.lodgingRegion] || 70000).toLocaleString()}원 초과</p>
                  )}
                  {trip.lodgingAmount > 0 && (
                    <>
                      <div className="flex gap-2 mt-1.5">
                        {["corp_card", "personal"].map((m) => (
                          <button key={m} onClick={() => u("lodgingPayMethod", m)}
                            className={`flex-1 py-1 rounded text-center text-xs border ${trip.lodgingPayMethod === m ? (m === "corp_card" ? "bg-blue-600 text-white border-blue-600" : "bg-emerald-600 text-white border-emerald-600") : "border-gray-300 bg-white"}`}>
                            {m === "corp_card" ? "💳 법인카드" : "🏦 개인부담"}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </>
              )}
            </div>

            {/* 첨부파일 + Claude Vision */}
            <div className="border-t border-gray-100 pt-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-gray-600">📎 증빙서류 첨부</span>
                <button onClick={() => fileRef.current?.click()} disabled={analyzing}
                  className="text-xs text-blue-600 hover:text-blue-800 font-medium disabled:text-gray-400">
                  {analyzing ? "⏳ 분석 중..." : "+ Claude AI 분석"}
                </button>
                <input ref={fileRef} type="file" accept=".pdf,.png,.jpg,.jpeg" className="hidden"
                  onChange={(e) => { if (e.target.files[0]) onAnalyzeFile(trip.id, e.target.files[0]); e.target.value = ""; }} />
              </div>

              {trip.attachments.length > 0 && (
                <div className="space-y-1">
                  {trip.attachments.map((a, i) => {
                    const metroMatch = a.proofMetro && trip.destinationMetro && a.proofMetro === trip.destinationMetro;
                    return (
                      <div key={i} className={`flex items-center gap-2 rounded px-2 py-1.5 text-xs ${metroMatch ? "bg-emerald-50 border border-emerald-200" : a.isProof ? "bg-blue-50 border border-blue-200" : "bg-gray-50 border border-gray-200"}`}>
                        <span>{a.type === "rail_receipt" ? "🚄" : a.type === "lodging_receipt" ? "🏨" : a.type === "toll_receipt" ? "🛣️" : a.type === "local_receipt" ? "🧾" : a.type === "map_capture" ? "🗺️" : "📄"}</span>
                        <span className="font-medium truncate flex-1">{a.fileName}</span>
                        <span className="text-gray-500">{a.category}</span>
                        {metroMatch && <span className="text-emerald-600 font-bold">✅ {a.proofMetro}</span>}
                        {a.isProof && !metroMatch && a.type !== "rail_receipt" && a.type !== "toll_receipt" && (
                          <span className="text-amber-500">📍 {a.proofMetro || "지역미확인"}</span>
                        )}
                        <button onClick={() => u("attachments", trip.attachments.filter((_, j) => j !== i))} className="text-gray-400 hover:text-red-500">✕</button>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* 관외증빙 상태 */}
              {trip.tripType === "outside" && trip.attachments.length === 0 && (
                <div className="bg-red-50 border border-red-200 rounded px-3 py-2 mt-2 text-xs text-red-600">
                  ⚠️ 관외출장은 증빙서류(철도영수증, 숙박영수증, 톨비영수증 또는 현지영수증)를 첨부해야 합니다.
                </div>
              )}
              {trip.tripType === "outside" && trip.attachments.length > 0 && !proofOk && (
                <div className="bg-amber-50 border border-amber-200 rounded px-3 py-2 mt-2 text-xs text-amber-700">
                  ⚠️ 현지 영수증의 지역({trip.attachments.find(a => a.proofMetro)?.proofMetro || "미확인"})이 출장지({trip.destinationMetro || "미입력"})와 일치하지 않습니다.
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

// ═══════════════ 정산 표 ═══════════════
const SettlementTable = ({ trips, userName, userGrade }) => {
  const tableRef = useRef(null);
  const [copied, setCopied] = useState(false);
  const isExec = userGrade === "executive";

  const rows = useMemo(() => {
    const result = [];
    trips.forEach((t) => {
      const isDomestic = t.tripType !== "outside";
      const destinationOnly = t.destination || (t.legs.length > 0 ? t.legs[t.legs.length - 1].to : "") || "-";

      if (isDomestic) {
        const fixed = t.tripType === "domestic_short" ? DOMESTIC_SHORT : DOMESTIC_LONG;
        result.push({
          date: t.date, type: t.tripType === "domestic_short" ? "관내(4h미만)" : "관내(4h이상)",
          route: t.destination || "-", transport: "-", daily: 0, meal: 0, fare: 0, lodging: 0,
          total: fixed, fixed, note: "", farePayMethod: "personal", lodgingPayMethod: "personal", proofOk: true,
          fareCardLast4: "", fareApprovalLast4: "", fareCorpAmount: 0, farePersonalAmount: 0, farePersonalPurpose: "",
          lodgingCardLast4: "", lodgingApprovalLast4: "", lodgingCorpAmount: 0, lodgingPersonalAmount: 0,
          requestAmount: fixed,
        });
        return;
      }

      // 관외출장: leg별 1행
      const mc = t.noMeal ? 0 : [t.breakfast, t.lunch, t.dinner].filter(Boolean).length;
      const meal = Math.max(0, Math.floor((MEAL_ALLOWANCE - MEAL_DEDUCTION * mc) / 10) * 10);
      const hasOffCar = t.legs.some((l) => l.transport === "official_car");
      const daily = t.noDaily ? 0 : (hasOffCar ? DAILY_ALLOWANCE_HALF : DAILY_ALLOWANCE);

      let lodging = 0;
      if (!t.noLodging) {
        if (isExec) lodging = t.lodgingAmount || 0;
        else lodging = Math.min(t.lodgingAmount || 0, LODGING_LIMITS_STAFF[t.lodgingRegion] || 70000);
      }

      const hasRail = t.attachments.some((a) => a.type === "rail_receipt");
      const hasToll = t.attachments.some((a) => a.type === "toll_receipt");
      const hasLocal = t.attachments.some((a) => a.type === "local_receipt" && a.proofMetro === t.destinationMetro);
      const hasLodg = t.attachments.some((a) => a.type === "lodging_receipt" && a.proofMetro === t.destinationMetro);
      const proofOk = hasRail || hasToll || hasLocal || hasLodg;

      t.legs.forEach((leg, legIdx) => {
        const isFirst = legIdx === 0;
        const lf = legFare(leg);

        // 교통편 라벨
        let transportLabel;
        if (leg.transport === "rail") transportLabel = leg.trainNo || "철도";
        else if (leg.transport === "personal_car") transportLabel = `자가용(${leg.km || 0}km)`;
        else transportLabel = TRANSPORT_TYPES.find((x) => x.value === leg.transport)?.label || leg.transport;

        // 경로: 출장지 값 사용
        const legRoute = destinationOnly;

        // 카드정보: KTX(철도) 영수증만 표시
        const effCard = leg.transport === "rail" ? (leg.cardLast4 || "") : "";
        const effAppr = leg.transport === "rail" ? (leg.approvalLast4 || "") : "";

        const fareCorpAmount = t.farePayMethod === "corp_card" ? lf : 0;
        const farePersonalAmount = t.farePayMethod === "personal" ? lf : 0;

        // 일비/식비/숙박은 첫 leg에만
        const rowDaily = isFirst ? daily : 0;
        const rowMeal = isFirst ? meal : 0;
        const rowLodging = isFirst ? lodging : 0;
        const lodgingCorpAmt = isFirst ? (t.lodgingPayMethod === "corp_card" ? lodging : 0) : 0;
        const lodgingPersonalAmt = isFirst ? (t.lodgingPayMethod === "personal" ? lodging : 0) : 0;
        const requestAmount = rowDaily + rowMeal + farePersonalAmount + lodgingPersonalAmt;

        const notes = [];
        if (isFirst && hasOffCar) notes.push("공용차량(일비50%)");
        if (isFirst && !proofOk) notes.push("⚠️증빙 미확인");

        result.push({
          date: isFirst ? t.date : "", type: "관외",
          route: legRoute, transport: transportLabel,
          daily: rowDaily, meal: rowMeal, fare: lf, lodging: rowLodging,
          total: lf + rowDaily + rowMeal + rowLodging, fixed: 0,
          note: notes.join(", "),
          farePayMethod: t.farePayMethod, lodgingPayMethod: t.lodgingPayMethod, proofOk,
          fareCardLast4: effCard, fareApprovalLast4: effAppr,
          fareCorpAmount, farePersonalAmount,
          farePersonalPurpose: farePersonalAmount > 0 ? "운임" : "",
          lodgingCardLast4: "",
          lodgingApprovalLast4: "",
          lodgingCorpAmount: lodgingCorpAmt, lodgingPersonalAmount: lodgingPersonalAmt,
          requestAmount,
        });
      });
    });
    return result;
  }, [trips, isExec]);

  const totals = useMemo(() => rows.reduce((s, r) => ({
    daily: s.daily + r.daily, meal: s.meal + r.meal,
    fareCorpAmount: s.fareCorpAmount + r.fareCorpAmount,
    farePersonalAmount: s.farePersonalAmount + r.farePersonalAmount,
    lodgingCorpAmount: s.lodgingCorpAmount + r.lodgingCorpAmount,
    lodgingPersonalAmount: s.lodgingPersonalAmount + r.lodgingPersonalAmount,
    requestAmount: s.requestAmount + r.requestAmount,
    total: s.total + r.total,
  }), { daily: 0, meal: 0, fareCorpAmount: 0, farePersonalAmount: 0, lodgingCorpAmount: 0, lodgingPersonalAmount: 0, requestAmount: 0, total: 0 }), [rows]);

  // 첨부 목록
  const allAttachments = useMemo(() => {
    const list = [];
    trips.forEach((t, i) => {
      t.attachments.forEach((a) => {
        list.push({ tripIndex: i + 1, fileName: a.fileName, category: a.category });
      });
    });
    return list;
  }, [trips]);

  const handleCopy = () => {
    if (!tableRef.current) return;
    const range = document.createRange();
    range.selectNodeContents(tableRef.current);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand("copy");
    sel.removeAllRanges();
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // 스타일 (17컬럼 대응)
  const cs = { border: "1px solid #999", padding: "3px 4px", textAlign: "center", fontSize: "10px" };
  const hs = { ...cs, backgroundColor: "#f3f4f6", fontWeight: "bold" };
  const ns = { ...cs, minWidth: "55px", whiteSpace: "nowrap" };
  const nhs = { ...hs, minWidth: "55px", whiteSpace: "nowrap" };
  const cardCs = { ...cs, minWidth: "40px", fontSize: "9px", fontFamily: "'Courier New', monospace" };
  const cardHs = { ...hs, minWidth: "40px", fontSize: "9px" };
  const COL = 17;

  const fmt = (v) => v > 0 ? v.toLocaleString() : "";

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-gray-700">📋 여비정산 내역표</h2>
        <button onClick={handleCopy} className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all ${copied ? "bg-emerald-600 text-white" : "bg-blue-600 text-white hover:bg-blue-700"}`}>
          {copied ? "✅ 복사 완료!" : "📋 표 복사하기"}
        </button>
      </div>
      <p className="text-xs text-gray-400 mb-2">그룹웨어에 Ctrl+V로 붙여넣기</p>

      <div className="overflow-x-auto border border-gray-300 rounded-lg">
        <table ref={tableRef} style={{ width: "100%", borderCollapse: "collapse", fontFamily: "'Malgun Gothic', sans-serif" }}>
          <thead>
            {/* 정보 행 */}
            <tr><td colSpan={COL} style={{ ...cs, textAlign: "left", fontSize: "10px", backgroundColor: "#f9fafb", color: "#6b7280" }}>
              소속: 식품안전정보원 | 직급: {isExec ? "임원" : "직원"} | 성명: {userName || "(미입력)"} | 예산항목: 국내여비
            </td></tr>
            {/* 헤더 Row 1 */}
            <tr>
              <td colSpan={4} style={hs}>출장 개요</td>
              <td colSpan={11} style={hs}>내 역</td>
              <td rowSpan={4} style={{ ...nhs, fontSize: "9px", verticalAlign: "middle" }}>신청금액<br/>(A+B+C+D)</td>
              <td rowSpan={4} style={{ ...hs, verticalAlign: "middle" }}>비 고</td>
            </tr>
            {/* 헤더 Row 2 */}
            <tr>
              <td rowSpan={3} style={hs}>일자</td>
              <td rowSpan={3} style={hs}>구분</td>
              <td rowSpan={3} style={{ ...hs, fontSize: "9px" }}>경로<br/>(운행거리,km)</td>
              <td rowSpan={3} style={hs}>교통편</td>
              <td rowSpan={3} style={nhs}>일비<br/>(A)</td>
              <td rowSpan={3} style={nhs}>식비<br/>(B)</td>
              <td colSpan={5} style={hs}>운임</td>
              <td colSpan={4} style={hs}>숙박비</td>
            </tr>
            {/* 헤더 Row 3 */}
            <tr>
              <td colSpan={3} style={{ ...hs, fontSize: "9px" }}>법인카드 지출</td>
              <td colSpan={2} style={{ ...hs, fontSize: "9px" }}>개인 지출</td>
              <td colSpan={3} style={{ ...hs, fontSize: "9px" }}>법인카드 지출</td>
              <td style={{ ...hs, fontSize: "9px" }}>개인 지출</td>
            </tr>
            {/* 헤더 Row 4 */}
            <tr>
              <td style={cardHs}>카드번호</td>
              <td style={cardHs}>승인번호</td>
              <td style={nhs}>금액</td>
              <td style={{ ...hs, fontSize: "9px" }}>용도</td>
              <td style={nhs}>금액(C)</td>
              <td style={cardHs}>카드번호</td>
              <td style={cardHs}>승인번호</td>
              <td style={nhs}>금액</td>
              <td style={nhs}>금액(D)</td>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} style={!r.proofOk && !r.fixed ? { backgroundColor: "#fef2f2" } : {}}>
                <td style={cs}>{r.date ? r.date.slice(5).replace("-", "/") : ""}</td>
                <td style={cs}>{r.type}</td>
                <td style={{ ...cs, fontSize: "9px", maxWidth: "110px", wordBreak: "break-all" }}>{r.route}</td>
                <td style={{ ...cs, fontSize: "9px", maxWidth: "80px" }}>{r.transport}</td>
                <td style={ns}>{r.fixed ? "" : fmt(r.daily)}</td>
                <td style={ns}>{r.fixed ? "" : (r.meal > 0 ? fmt(r.meal) : "0")}</td>
                {/* 운임 - 법인카드 */}
                <td style={cardCs}>{r.fareCorpAmount > 0 ? r.fareCardLast4 : ""}</td>
                <td style={cardCs}>{r.fareCorpAmount > 0 ? r.fareApprovalLast4 : ""}</td>
                <td style={ns}>{fmt(r.fareCorpAmount)}</td>
                {/* 운임 - 개인지출 */}
                <td style={{ ...cs, fontSize: "9px" }}>{r.farePersonalPurpose}</td>
                <td style={ns}>{fmt(r.farePersonalAmount)}</td>
                {/* 숙박비 - 법인카드 */}
                <td style={cardCs}>{r.lodgingCorpAmount > 0 ? r.lodgingCardLast4 : ""}</td>
                <td style={cardCs}>{r.lodgingCorpAmount > 0 ? r.lodgingApprovalLast4 : ""}</td>
                <td style={ns}>{fmt(r.lodgingCorpAmount)}</td>
                {/* 숙박비 - 개인지출 */}
                <td style={ns}>{fmt(r.lodgingPersonalAmount)}</td>
                {/* 신청금액 */}
                <td style={{ ...ns, fontWeight: "bold" }}>{r.requestAmount.toLocaleString()}</td>
                <td style={{ ...cs, fontSize: "9px", maxWidth: "100px" }}>{r.note}</td>
              </tr>
            ))}
            {/* 신청총액 */}
            <tr style={{ backgroundColor: "#eff6ff" }}>
              <td colSpan={4} style={{ ...cs, fontWeight: "bold", textAlign: "right" }}>신청총액</td>
              <td style={{ ...ns, fontWeight: "bold" }}>{fmt(totals.daily)}</td>
              <td style={{ ...ns, fontWeight: "bold" }}>{totals.meal > 0 ? fmt(totals.meal) : "0"}</td>
              <td style={cardCs}></td>
              <td style={cardCs}></td>
              <td style={{ ...ns, fontWeight: "bold" }}>{fmt(totals.fareCorpAmount)}</td>
              <td style={cs}></td>
              <td style={{ ...ns, fontWeight: "bold" }}>{fmt(totals.farePersonalAmount)}</td>
              <td style={cardCs}></td>
              <td style={cardCs}></td>
              <td style={{ ...ns, fontWeight: "bold" }}>{fmt(totals.lodgingCorpAmount)}</td>
              <td style={{ ...ns, fontWeight: "bold" }}>{fmt(totals.lodgingPersonalAmount)}</td>
              <td style={{ ...ns, fontWeight: "bold", color: "#1d4ed8" }}>{totals.requestAmount.toLocaleString()}</td>
              <td style={cs}></td>
            </tr>
            {/* 총 여비 */}
            <tr><td colSpan={COL} style={{ ...cs, textAlign: "center", fontWeight: "bold", fontSize: "12px" }}>
              총 여비: 금 {totals.requestAmount.toLocaleString()}원정 ({amountToKorean(totals.requestAmount)}원)
            </td></tr>

            {/* 첨부 목록 */}
            {allAttachments.length > 0 && (
              <>
                <tr><td colSpan={COL} style={{ border: "none", padding: "6px 0 0", backgroundColor: "#fff" }}></td></tr>
                <tr><td colSpan={COL} style={{ ...hs, textAlign: "left" }}>■ 첨부서류 목록</td></tr>
                <tr>
                  <td colSpan={2} style={hs}>No.</td>
                  <td colSpan={2} style={hs}>출장</td>
                  <td colSpan={9} style={hs}>파일명</td>
                  <td colSpan={4} style={hs}>종류</td>
                </tr>
                {allAttachments.map((a, i) => (
                  <tr key={i}>
                    <td colSpan={2} style={cs}>{i + 1}</td>
                    <td colSpan={2} style={cs}>#{a.tripIndex}</td>
                    <td colSpan={9} style={{ ...cs, textAlign: "left", fontSize: "10px" }}>{a.fileName}</td>
                    <td colSpan={4} style={{ ...cs, fontSize: "10px" }}>{a.category}</td>
                  </tr>
                ))}
              </>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// ═══════════════ 메인 앱 ═══════════════
export default function TravelExpenseV5() {
  const [userName, setUserName] = useState("");
  const [userGrade, setUserGrade] = useState("staff");
  const [trips, setTrips] = useState([emptyTrip()]);
  const [showTable, setShowTable] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [showBulkModal, setShowBulkModal] = useState(false);

  // Q&A 모달 상태
  const [showQAModal, setShowQAModal] = useState(false);
  const [qaReceiptResult, setQaReceiptResult] = useState(null);
  const qaResolveRef = useRef(null);

  const isExec = userGrade === "executive";

  // Q&A: Promise 기반 모달 대기
  const waitForQA = useCallback((receiptResult) => {
    return new Promise((resolve) => {
      qaResolveRef.current = resolve;
      setQaReceiptResult(receiptResult);
      setShowQAModal(true);
    });
  }, []);

  const handleQAResolved = useCallback((updatedData) => {
    if (qaResolveRef.current) {
      qaResolveRef.current(updatedData);
      qaResolveRef.current = null;
    }
    setShowQAModal(false);
    setQaReceiptResult(null);
  }, []);

  const addTrip = () => setTrips((p) => [...p, emptyTrip()]);
  const removeTrip = (id) => setTrips((p) => p.length > 1 ? p.filter((t) => t.id !== id) : p);
  const updateTrip = useCallback((id, key, val) => setTrips((p) => p.map((t) => t.id === id ? { ...t, [key]: val } : t)), []);

  const analyzeFile = useCallback(async (tripId, file) => {
    setAnalyzing(true);
    try {
      let results = await analyzeWithClaude(file);
      // Q&A: confidence 낮은 결과는 사용자 확인 후 업데이트
      const processedResults = [];
      for (const result of results) {
        if ((result.confidence ?? 0.5) < CONFIDENCE_THRESHOLD) {
          const updated = await waitForQA(result);
          processedResults.push({ ...updated, fileName: result.fileName });
        } else {
          processedResults.push(result);
        }
      }
      results = processedResults;
      // analyzeWithClaude는 항상 배열 반환
      results.forEach((result) => {
        setTrips((prev) => prev.map((t) => {
          if (t.id !== tripId) return t;
          const att = { fileName: file.name, category: result.expenseCategory || result.category, type: result.type, proofMetro: result.proofMetro, isProof: result.isProof, simulated: result.simulated || false, confidence: result.confidence, expenseCategory: result.expenseCategory };
          let updated = { ...t, attachments: [...t.attachments, att] };

          if (result.type === "rail_receipt" && result.data) {
            const d = result.data;
            const newLeg = { ...emptyLeg(), from: d.from || "", to: d.to || "", transport: "rail", trainNo: d.trainNo || "", amount: d.amount || 0, cardLast4: d.cardLast4 || "", approvalLast4: d.approvalLast4 || "" };
            if (updated.legs.length === 1 && !updated.legs[0].from && !updated.legs[0].to) {
              updated.legs = [{ ...updated.legs[0], ...newLeg, id: updated.legs[0].id }];
            } else {
              updated.legs = [...updated.legs, newLeg];
            }
          }

          if (result.type === "lodging_receipt" && result.data) {
            const d = result.data;
            updated.lodgingAmount = d.amount || updated.lodgingAmount;
            updated.noLodging = false;
            if (d.address) {
              const metro = detectMetro(d.address);
              if (metro) updated.lodgingRegion = getLodgingRegion(metro);
            }
          }

          if (result.type === "toll_receipt" && result.data) {
            const vehicleType = result.data.vehicleType || "personal_car";
            const existingTollLeg = updated.legs.find((l) => (l.transport === "personal_car" || l.transport === "official_car"));
            if (existingTollLeg) {
              updated.legs = updated.legs.map((l) => l.id === existingTollLeg.id ? { ...l, tollFee: (l.tollFee || 0) + (result.data.amount || 0), transport: vehicleType } : l);
            } else {
              const carLeg = { ...emptyLeg(), transport: vehicleType, tollFee: result.data.amount || 0 };
              if (updated.legs.length === 1 && !updated.legs[0].to && updated.legs[0].transport === "rail") {
                updated.legs = [{ ...updated.legs[0], ...carLeg, id: updated.legs[0].id }];
              } else {
                updated.legs = [...updated.legs, carLeg];
              }
            }
          }

          if (result.type === "map_capture" && result.data) {
            const d = result.data;
            const carLeg = updated.legs.find((l) => l.transport === "personal_car");
            if (carLeg) {
              updated.legs = updated.legs.map((l) => l.id === carLeg.id ? { ...l, km: d.distanceKm || l.km, from: d.from || l.from, to: d.to || l.to } : l);
            }
          }

          return updated;
        }));
      });
    } finally {
      setAnalyzing(false);
    }
  }, [waitForQA]);

  // v5: 일괄 업로드 결과 반영
  const handleBulkComplete = useCallback((newTrips) => {
    if (newTrips.length === 0) return;
    setTrips((prev) => {
      // 기존에 빈 출장 1개만 있으면 교체, 아니면 추가
      const isEmpty = prev.length === 1 && !prev[0].date && !prev[0].destination && prev[0].attachments.length === 0;
      return isEmpty ? newTrips : [...prev, ...newTrips];
    });
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-gray-100">
      <div className="max-w-2xl mx-auto px-4 py-6">
        {/* 헤더 */}
        <div className="text-center mb-6">
          <h1 className="text-xl font-bold text-slate-800 tracking-tight">식품안전정보원 여비정산</h1>
          <p className="text-xs text-gray-500 mt-1">v5 — 영수증 일괄 분석 · AI 자동 출장 생성</p>
        </div>

        {/* 인적사항 */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4 mb-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-500 mb-1 block">성명</label>
              <input value={userName} onChange={(e) => setUserName(e.target.value)} placeholder="홍길동" className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">직급</label>
              <div className="flex gap-2">
                {[["executive", "👔 임원"], ["staff", "👤 직원"]].map(([val, label]) => (
                  <button key={val} onClick={() => setUserGrade(val)}
                    className={`flex-1 py-2 rounded-lg text-sm font-medium border transition-all ${userGrade === val ? "bg-slate-700 text-white border-slate-700" : "bg-white text-gray-600 border-gray-300 hover:border-gray-400"}`}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          {isExec && (
            <div className="mt-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5 text-xs text-amber-700">
              👔 임원 적용: KTX 특실 이용 가능 · 숙박비 상한 없음 (실비 정산)
            </div>
          )}
        </div>

        {/* v5: 일괄 업로드 버튼 */}
        <button onClick={() => setShowBulkModal(true)}
          className="w-full mb-4 py-3 bg-gradient-to-r from-violet-600 to-indigo-600 text-white rounded-xl text-sm font-semibold hover:from-violet-700 hover:to-indigo-700 transition-all shadow-sm">
          🤖 영수증 일괄 분석 → 출장 자동 생성
        </button>

        {/* 출장 카드 목록 */}
        <div className="space-y-4 mb-4">
          {trips.map((trip, i) => (
            <TripCard key={trip.id} trip={trip} index={i} onUpdate={updateTrip} onRemove={removeTrip}
              canRemove={trips.length > 1} isExecutive={isExec} analyzing={analyzing} onAnalyzeFile={analyzeFile} />
          ))}
        </div>

        {/* 출장 추가 + 정산 버튼 */}
        <div className="flex gap-2 mb-6">
          <button onClick={addTrip} className="flex-1 py-3 border-2 border-dashed border-gray-300 rounded-xl text-sm text-gray-500 hover:border-blue-400 hover:text-blue-600 transition-all">
            + 출장 추가
          </button>
          <button onClick={() => setShowTable(!showTable)}
            className="flex-1 py-3 bg-slate-700 text-white rounded-xl text-sm font-semibold hover:bg-slate-800 transition-all">
            {showTable ? "입력으로 돌아가기" : "📋 정산 내역표 보기"}
          </button>
        </div>

      </div>

      {/* 정산표 (A4 가로형 대응 - 넓은 컨테이너) */}
      {showTable && (
        <div className="max-w-6xl mx-auto px-4 pb-6">
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
            <SettlementTable trips={trips} userName={userName} userGrade={userGrade} />
          </div>
        </div>
      )}

      {/* v5: 일괄 업로드 모달 */}
      <BulkUploadModal
        isOpen={showBulkModal}
        onClose={() => setShowBulkModal(false)}
        onComplete={handleBulkComplete}
        analyzing={analyzing}
        onRequestQA={waitForQA}
      />

      {/* Q&A 채팅 모달 */}
      <QAModal
        isOpen={showQAModal}
        onClose={() => handleQAResolved(qaReceiptResult)}
        receiptResult={qaReceiptResult}
        onResolved={handleQAResolved}
      />
    </div>
  );
}